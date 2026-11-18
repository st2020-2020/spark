package backend

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

type collectionRow struct {
	contract.Collection
	UserID             string                 `json:"user_id"`
	PlainText          string                 `json:"plain_text"`
	StoredOrganization *contract.Organization `json:"stored_organization"`
	UserAIEnabled      bool                   `json:"user_ai_enabled"`
	GeneratedTitle     *string                `json:"generated_title"`
	GeneratedSummary   *string                `json:"generated_summary"`
}

const collectionSelect = `SELECT to_jsonb(c)||jsonb_build_object(
 'user_ai_enabled',(SELECT ai_enabled FROM users WHERE id=c.user_id),
 'stored_organization',(SELECT jsonb_strip_nulls(jsonb_build_object('run_id',r.id,'content_version',r.content_version,'status',r.status,'stages',r.stages,'error_code',r.error_code,'updated_at',r.updated_at)) FROM organization_runs r WHERE r.user_id=c.user_id AND r.collection_id=c.id AND r.content_version=c.content_version ORDER BY r.created_at DESC,r.id DESC LIMIT 1),
 'generated_title',(SELECT generated_title FROM organization_current oc WHERE oc.user_id=c.user_id AND oc.collection_id=c.id AND oc.content_version=c.content_version),
 'generated_summary',(SELECT summary FROM organization_current oc WHERE oc.user_id=c.user_id AND oc.collection_id=c.id AND oc.content_version=c.content_version),
 'projects',COALESCE(
 (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('project_id',p.id,'name',p.name,'decision',cp.decision,'reason',cp.reason,'evidence',cp.evidence,'project_version',cp.project_version)) ORDER BY p.id)
 FROM collection_projects cp JOIN projects p ON p.user_id=cp.user_id AND p.id=cp.project_id
 WHERE cp.user_id=c.user_id AND cp.collection_id=c.id),'[]'::jsonb)) FROM collections c `

func scanCollection(row pgx.Row) (collectionRow, error) {
	var b []byte
	var out collectionRow
	if err := row.Scan(&b); err != nil {
		return out, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return out, err
	}
	out.ContentTypes = []contract.CollectionContentTypes{}
	if strings.TrimSpace(out.PlainText) != "" {
		out.ContentTypes = append(out.ContentTypes, "text")
	}
	if value(out.OriginalUrl) != "" {
		out.ContentTypes = append(out.ContentTypes, "url")
	}
	out.DisplayTitle = titleFor(out.PlainText, value(out.ManualTitle), value(out.OriginalUrl))
	out.Attachments = []contract.Attachment{}
	out.Tags = []contract.TagAssociation{}
	code := "integration_not_configured"
	if !out.UserAIEnabled {
		code = "ai_disabled"
	} else if out.AiExcluded {
		code = "ai_excluded"
	} else if !materialAvailable(out.PlainText, out.Intent) {
		code = "insufficient_material"
	}
	out.Organization = contract.Organization{ContentVersion: out.ContentVersion, Status: "skipped", Stages: []contract.Stage{}, ErrorCode: &code, UpdatedAt: out.UpdatedAt}
	if out.StoredOrganization != nil {
		out.Organization = *out.StoredOrganization
	}
	out.Organization.GeneratedTitle = out.GeneratedTitle
	out.Organization.Summary = out.GeneratedSummary
	if value(out.ManualTitle) == "" && value(out.GeneratedTitle) != "" {
		out.DisplayTitle = *out.GeneratedTitle
	}
	return out, nil
}
func (s *Server) loadCollection(ctx context.Context, q querier, uid, id string) (collectionRow, error) {
	row, err := scanCollection(q.QueryRow(ctx, collectionSelect+`WHERE c.user_id=$1 AND c.id=$2`, uid, id))
	return s.collectionView(row), err
}
func (s *Server) getCollection(c *gin.Context) (any, error) {
	row, err := s.loadCollection(c.Request.Context(), s.Pool, current(c).User.ID, c.Param("id"))
	return row.Collection, err
}
func (s *Server) getOrganization(c *gin.Context) (any, error) {
	row, err := s.loadCollection(c.Request.Context(), s.Pool, current(c).User.ID, c.Param("id"))
	return row.Organization, err
}
func snapshot(ctx context.Context, tx pgx.Tx, uid, id string) error {
	_, err := tx.Exec(ctx, `INSERT INTO collection_revisions(user_id,collection_id,content_version,document,intent,original_url,manual_title) SELECT user_id,id,content_version,document,intent,original_url,manual_title FROM collections WHERE user_id=$1 AND id=$2`, uid, id)
	return err
}
func checkActive(row collectionRow) error {
	if row.DeletedAt != nil {
		return problem(409, "collection_in_trash", "请先从回收站恢复收藏。")
	}
	return nil
}
func (s *Server) createCollection(c *gin.Context) (any, error) {
	req, err := bind[contract.CollectionCreate](s, c)
	if err != nil {
		return nil, err
	}
	if len(req.UploadIds) > 0 {
		return nil, problem(422, "invalid_attachment", "本批次尚未开放附件上传。")
	}
	if len(req.TagIds) > 0 {
		return nil, problem(422, "validation_failed", "本批次尚未开放标签。")
	}
	plain, originalURL, err := validateContent(req.Document, req.Intent, value(req.OriginalUrl))
	if err != nil {
		return nil, err
	}
	return s.idempotent(c, req, 201, func(tx pgx.Tx) (any, error) {
		uid := current(c).User.ID
		id := req.Id.String()
		ctx := c.Request.Context()
		for _, pid := range req.ProjectIds {
			var exists bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE user_id=$1 AND id=$2)`, uid, pid.String()).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists {
				return nil, notFound
			}
		}
		if _, err = tx.Exec(ctx, `INSERT INTO collections(id,user_id,document,plain_text,intent,original_url,manual_title,ai_excluded) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, uid, jsonBytes(req.Document), plain, req.Intent, originalURL, value(req.ManualTitle), value(req.AiExcluded)); err != nil {
			return nil, err
		}
		for _, pid := range req.ProjectIds {
			if _, err = tx.Exec(ctx, `INSERT INTO collection_projects(user_id,collection_id,project_id,decision) VALUES($1,$2,$3,'manual')`, uid, id, pid.String()); err != nil {
				return nil, err
			}
		}
		if err = snapshot(ctx, tx, uid, id); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "collection", id, 1); err != nil {
			return nil, err
		}
		if _, _, err = s.Organizer.Enqueue(ctx, tx, uid, id, false); err != nil {
			return nil, err
		}
		row, err := s.loadCollection(ctx, tx, uid, id)
		return row.Collection, err
	})
}
func (s *Server) updateCollection(c *gin.Context) (any, error) {
	req, err := bind[contract.CollectionUpdate](s, c)
	if err != nil {
		return nil, err
	}
	if req.UploadIds != nil && len(*req.UploadIds) > 0 || req.AttachmentIds != nil && len(*req.AttachmentIds) > 0 {
		return nil, problem(422, "invalid_attachment", "本批次尚未开放附件。")
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	uid, id := current(c).User.ID, c.Param("id")
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = checkActive(row); err != nil {
		return nil, err
	}
	if row.ContentVersion != req.BaseContentVersion {
		return nil, conflict("content_conflict", "current_content_version", int64(row.ContentVersion))
	}
	before := row.Collection
	if req.Document != nil {
		row.Document = *req.Document
	}
	if req.Intent != nil {
		row.Intent = *req.Intent
	}
	if req.OriginalUrl != nil {
		row.OriginalUrl = req.OriginalUrl
	}
	if req.ManualTitle != nil {
		row.ManualTitle = req.ManualTitle
	}
	plain, rawURL, err := validateContent(row.Document, row.Intent, value(row.OriginalUrl))
	if err != nil {
		return nil, err
	}
	row.OriginalUrl = &rawURL
	if !equalJSON(before, row.Collection) {
		if _, err = tx.Exec(ctx, `UPDATE collections SET document=$3,plain_text=$4,intent=$5,original_url=$6,manual_title=$7,content_version=content_version+1,resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, id, jsonBytes(row.Document), plain, row.Intent, rawURL, value(row.ManualTitle)); err != nil {
			return nil, err
		}
		if err = snapshot(ctx, tx, uid, id); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "collection", id, int64(row.ResourceVersion+1)); err != nil {
			return nil, err
		}
		if _, _, err = s.Organizer.Enqueue(ctx, tx, uid, id, false); err != nil {
			return nil, err
		}
	}
	row, err = s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row.Collection, nil
}
func (s *Server) projectDecisions(c *gin.Context) (any, error) {
	req, err := bind[contract.AssociationUpdate](s, c)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, op := range req.Operations {
		if seen[op.Id.String()] {
			return nil, problem(422, "validation_failed", "一次操作不能重复指定同一项目。")
		}
		seen[op.Id.String()] = true
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	uid, id := current(c).User.ID, c.Param("id")
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = checkActive(row); err != nil {
		return nil, err
	}
	if row.DecisionVersion != req.BaseDecisionVersion {
		return nil, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
	}
	existing := map[string]string{}
	for _, p := range row.Projects {
		existing[p.ProjectId.String()] = string(p.Decision)
	}
	changed := false
	for _, op := range req.Operations {
		var exists bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE user_id=$1 AND id=$2)`, uid, op.Id.String()).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, notFound
		}
		decision := "manual"
		if op.Action == "exclude" {
			decision = "rejected"
		}
		if op.Action == "include" && (existing[op.Id.String()] == "auto" || existing[op.Id.String()] == "suggested" || existing[op.Id.String()] == "confirmed") {
			decision = "confirmed"
		}
		if op.Action == "reset" {
			if existing[op.Id.String()] == "manual" || existing[op.Id.String()] == "confirmed" || existing[op.Id.String()] == "rejected" {
				if _, err = tx.Exec(ctx, `DELETE FROM collection_projects WHERE user_id=$1 AND collection_id=$2 AND project_id=$3`, uid, id, op.Id.String()); err != nil {
					return nil, err
				}
				changed = true
			}
			continue
		}
		if existing[op.Id.String()] == decision {
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO collection_projects(user_id,collection_id,project_id,decision) VALUES($1,$2,$3,$4) ON CONFLICT(collection_id,project_id) DO UPDATE SET decision=excluded.decision,updated_at=now()`, uid, id, op.Id.String(), decision); err != nil {
			return nil, err
		}
		changed = true
	}
	if changed {
		if _, err = tx.Exec(ctx, `UPDATE collections SET decision_version=decision_version+1,resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, id); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "collection", id, int64(row.ResourceVersion+1)); err != nil {
			return nil, err
		}
	}
	row, err = s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row.Collection, nil
}
func (s *Server) readState(c *gin.Context) (any, error) {
	req, err := bind[contract.ReadUpdate](s, c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	uid, id := current(c).User.ID, c.Param("id")
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = checkActive(row); err != nil {
		return nil, err
	}
	if (row.ReadAt != nil) != req.Read {
		if _, err = tx.Exec(ctx, `UPDATE collections SET read_at=CASE WHEN $3 THEN now() ELSE NULL END,resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, id, req.Read); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "collection", id, int64(row.ResourceVersion+1)); err != nil {
			return nil, err
		}
	}
	row, err = s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row.Collection, nil
}
func (s *Server) trashCollection(c *gin.Context) (any, error)   { return s.setTrash(c, true) }
func (s *Server) restoreCollection(c *gin.Context) (any, error) { return s.setTrash(c, false) }
func (s *Server) setTrash(c *gin.Context, trash bool) (any, error) {
	req, err := bind[contract.ResourceCondition](s, c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	uid, id := current(c).User.ID, c.Param("id")
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if row.ResourceVersion != req.BaseResourceVersion {
		return nil, conflict("resource_conflict", "current_resource_version", int64(row.ResourceVersion))
	}
	if (row.DeletedAt != nil) != trash {
		if _, err = tx.Exec(ctx, `UPDATE collections SET deleted_at=CASE WHEN $3 THEN now() ELSE NULL END,purge_after=CASE WHEN $3 THEN now()+interval '30 days' ELSE NULL END,ai_policy_version=ai_policy_version+1,resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, id, trash); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "collection", id, int64(row.ResourceVersion+1)); err != nil {
			return nil, err
		}
		if trash {
			if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='skipped',error_code='collection_in_trash',updated_at=now(),completed_at=now() WHERE user_id=$1 AND collection_id=$2 AND status='queued'`, uid, id); err != nil {
				return nil, err
			}
		} else {
			if _, _, err = s.Organizer.Enqueue(ctx, tx, uid, id, false); err != nil {
				return nil, err
			}
		}
	}
	row, err = s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return row.Collection, nil
}
func summary(row collectionRow) contract.CollectionSummary {
	types := []contract.CollectionSummaryContentTypes{}
	for _, t := range row.ContentTypes {
		types = append(types, contract.CollectionSummaryContentTypes(t))
	}
	return contract.CollectionSummary{Id: row.Id, DisplayTitle: row.DisplayTitle, Excerpt: shortText(row.PlainText, 200), ContentTypes: types, Projects: row.Projects, Tags: row.Tags, OrganizationStatus: contract.CollectionSummaryOrganizationStatus(row.Organization.Status), ReadAt: row.ReadAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, ResourceVersion: row.ResourceVersion}
}

func (s *Server) collectionView(row collectionRow) collectionRow {
	if row.StoredOrganization == nil {
		if !s.Organizer.Enabled {
			code := "integration_not_configured"
			row.Organization.ErrorCode = &code
		} else if !s.Organizer.Trial.allows(row.UserID) {
			code := aiTrialUnavailable
			row.Organization.ErrorCode = &code
		}
	}
	return row
}
