package backend

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

type collectionRow struct {
	contract.Collection
	UserID             string                 `json:"user_id"`
	PlainText          string                 `json:"plain_text"`
	URLSearchText      string                 `json:"url_search_text"`
	ImageSearchText    string                 `json:"image_search_text"`
	ImageDescription   string                 `json:"image_search_description"`
	LinkPreview        *contract.LinkPreview  `json:"link_preview"`
	StoredOrganization *contract.Organization `json:"stored_organization"`
	UserAIEnabled      bool                   `json:"user_ai_enabled"`
	UserAIConsent      string                 `json:"user_ai_consent"`
	UserRole           string                 `json:"user_role"`
	HasImageMaterial   bool                   `json:"has_image_material"`
	GeneratedTitle     *string                `json:"generated_title"`
	GeneratedSummary   *string                `json:"generated_summary"`
}

const collectionJSON = `to_jsonb(c)||jsonb_build_object(
 'user_ai_enabled',(SELECT ai_enabled FROM users WHERE id=c.user_id),
 'user_ai_consent',(SELECT COALESCE(ai_consent_version,'') FROM users WHERE id=c.user_id),
 'user_role',(SELECT role FROM users WHERE id=c.user_id),
 'has_image_material',EXISTS(SELECT 1 FROM organization_image_materials m WHERE (m.user_id,m.collection_id)=(c.user_id,c.id)),
 'stored_organization',(SELECT jsonb_strip_nulls(jsonb_build_object('run_id',r.id,'content_version',r.content_version,'status',r.status,
 'stages',CASE WHEN r.image_waiting AND r.status<>'queued' THEN '[{"name":"extract_images","status":"skipped","attempts":0}]'::jsonb ELSE r.stages END,
 'error_code',r.error_code,'updated_at',r.updated_at,
 'image_material_status',CASE
  WHEN r.status='queued' AND r.image_waiting THEN 'waiting'
  WHEN r.status IN ('succeeded','partial') AND EXISTS(SELECT 1 FROM organization_current_image_runs ir
    WHERE (ir.user_id,ir.run_id)=(r.user_id,r.id)) THEN 'included' END)) FROM organization_runs r WHERE r.user_id=c.user_id AND r.collection_id=c.id AND r.content_version=c.content_version ORDER BY r.created_at DESC,r.id DESC LIMIT 1),
 'generated_title',(SELECT generated_title FROM organization_current oc WHERE oc.user_id=c.user_id AND oc.collection_id=c.id AND oc.content_version=c.content_version),
 'generated_summary',(SELECT summary FROM organization_current oc WHERE oc.user_id=c.user_id AND oc.collection_id=c.id AND oc.content_version=c.content_version),
 'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'mime_type',a.mime_type,
 'position',a.position,'size_bytes',a.size_bytes) ORDER BY a.position) FROM attachments a
 WHERE (a.user_id,a.collection_id)=(c.user_id,c.id) AND a.removed_at IS NULL),'[]'::jsonb),
 'link_preview',(SELECT jsonb_strip_nulls(jsonb_build_object(
 'status',e.status,'source_title',e.source_title,'site_name',e.evidence_meta->>'site_name','summary',e.evidence_meta->>'summary'))
 FROM extractions e
 WHERE (e.user_id,e.collection_id,e.content_version,e.source_id)=(c.user_id,c.id,c.content_version,c.original_url)
   AND c.deleted_at IS NULL AND e.source_kind='url' AND e.extractor_version='` + urlExtractorVersion + `'),
 'has_suggestion',EXISTS (SELECT 1 FROM organization_pending_suggestions sp WHERE (sp.user_id,sp.collection_id)=(c.user_id,c.id)),
 'tags',COALESCE((
 SELECT jsonb_agg(jsonb_build_object('tag_id',t.id,'path',t.name,'decision',ct.decision) ORDER BY t.normalized_name,t.id)
 FROM collection_tags ct JOIN tags t ON (t.user_id,t.id)=(ct.user_id,ct.tag_id)
 WHERE (ct.user_id,ct.collection_id)=(c.user_id,c.id)
 ),'[]'::jsonb),
 'projects',COALESCE(
 (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('project_id',p.id,'name',p.name,'decision',cp.decision,'reason',cp.reason,'evidence',cp.evidence,'project_version',cp.project_version,'suggestion_run_id',CASE WHEN cp.decision='suggested' THEN cp.run_id END)) ORDER BY p.id)
 FROM collection_projects cp JOIN projects p ON p.user_id=cp.user_id AND p.id=cp.project_id
 WHERE cp.user_id=c.user_id AND cp.collection_id=c.id
 AND (cp.decision <> 'suggested' OR EXISTS (SELECT 1 FROM organization_pending_suggestions sp
 WHERE (sp.user_id,sp.collection_id,sp.project_id)=(cp.user_id,cp.collection_id,cp.project_id)))), '[]'::jsonb))`

const collectionSelect = `SELECT ` + collectionJSON + ` FROM collections c `

func scanCollection(row pgx.Row, extraColumns ...any) (collectionRow, error) {
	var b []byte
	var out collectionRow
	if err := row.Scan(append([]any{&b}, extraColumns...)...); err != nil {
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
	if len(out.Attachments) > 0 {
		out.ContentTypes = append(out.ContentTypes, "image")
		if out.DisplayTitle == "" || value(out.ManualTitle) == "" && strings.TrimSpace(out.PlainText) == "" && value(out.OriginalUrl) == "" {
			out.DisplayTitle = out.Attachments[0].Filename
		}
	}
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
	row, err := scanCollection(q.QueryRow(ctx, collectionSelect+`WHERE c.user_id=$1 AND c.id=$2 AND c.purge_requested_at IS NULL`, uid, id))
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
	_, err := tx.Exec(ctx, `INSERT INTO collection_revisions(user_id,collection_id,content_version,document,intent,original_url,manual_title,attachment_ids)
		SELECT c.user_id,c.id,c.content_version,c.document,c.intent,c.original_url,c.manual_title,
		       COALESCE((SELECT jsonb_agg(a.id ORDER BY a.position) FROM attachments a
		                 WHERE (a.user_id,a.collection_id)=(c.user_id,c.id) AND a.removed_at IS NULL),'[]'::jsonb)
		FROM collections c WHERE c.user_id=$1 AND c.id=$2`, uid, id)
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
	seenTags := make(map[uuid.UUID]bool, len(req.TagIds))
	for _, tag := range req.TagIds {
		if seenTags[tag] {
			return nil, problem(422, "validation_failed", "创建时不能重复指定同一标签。")
		}
		seenTags[tag] = true
	}
	plain, originalURL, err := validateContent(req.Document, req.Intent, value(req.OriginalUrl), len(req.UploadIds) > 0)
	if err != nil {
		return nil, err
	}
	uid, id, ctx := current(c).User.ID, req.Id.String(), c.Request.Context()
	checkTombstone := func(tx pgx.Tx) error {
		_, err := store.New(tx).GetCollectionDeletion(ctx, store.GetCollectionDeletionParams{UserID: idPG(uid), CollectionID: idPG(id)})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		return problem(409, "duplicate_resource", "收藏已永久删除。")
	}
	return s.idempotentWithReplay(c, req, 201, func(tx pgx.Tx) (any, error) {
		if err := checkTombstone(tx); err != nil {
			return nil, err
		}
		if len(req.UploadIds) > 0 && s.Assets == nil {
			return nil, uploadsUnavailable
		}
		for _, pid := range req.ProjectIds {
			var exists bool
			if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE user_id=$1 AND id=$2)`, uid, pid.String()).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists {
				return nil, notFound
			}
		}
		if err := checkOwnedTags(ctx, tx, uid, req.TagIds); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO collections(id,user_id,document,plain_text,intent,original_url,manual_title,ai_excluded) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, uid, jsonBytes(req.Document), plain, req.Intent, originalURL, value(req.ManualTitle), value(req.AiExcluded)); err != nil {
			return nil, err
		}
		for _, pid := range req.ProjectIds {
			if _, err = tx.Exec(ctx, `INSERT INTO collection_projects(user_id,collection_id,project_id,decision) VALUES($1,$2,$3,'manual')`, uid, id, pid.String()); err != nil {
				return nil, err
			}
		}
		if len(req.TagIds) > 0 {
			if _, err = tx.Exec(ctx, `INSERT INTO collection_tags(user_id,collection_id,tag_id,decision)
				SELECT $1,$2,id,'manual' FROM unnest($3::uuid[]) AS tag(id)`, uid, id, req.TagIds); err != nil {
				return nil, err
			}
		}
		attachments, err := attachUploads(ctx, store.New(tx), uid, id, 0, req.UploadIds)
		if err != nil {
			return nil, err
		}
		if err := s.enqueueImageAnalysis(ctx, tx, uid, id, attachments); err != nil {
			return nil, err
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
		if _, err = s.enqueueURLExtraction(ctx, tx, uid, id, false); err != nil {
			return nil, err
		}
		row, err := s.loadCollection(ctx, tx, uid, id)
		return row.Collection, err
	}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
		if err := checkTombstone(tx); err != nil {
			return nil, err
		}
		return response, nil
	})
}
func (s *Server) updateCollection(c *gin.Context) (any, error) {
	req, err := bind[contract.CollectionUpdate](s, c)
	if err != nil {
		return nil, err
	}
	uploads := value(req.UploadIds)
	if len(uploads) > 0 && s.Assets == nil {
		return nil, uploadsUnavailable
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
	currentAttachments := make([]uuid.UUID, 0, len(row.Attachments))
	for _, a := range row.Attachments {
		currentAttachments = append(currentAttachments, a.Id)
	}
	kept := currentAttachments
	if req.AttachmentIds != nil {
		kept = *req.AttachmentIds
	}
	totalAttachments := len(kept) + len(uploads)
	if totalAttachments > 9 {
		return nil, problem(422, "invalid_attachment", "每条收藏最多保留 9 张图片。")
	}
	plain, rawURL, err := validateContent(row.Document, row.Intent, value(row.OriginalUrl), totalAttachments > 0)
	if err != nil {
		return nil, err
	}
	row.OriginalUrl = &rawURL
	reordered := !slices.Equal(currentAttachments, kept)
	if reordered || len(uploads) > 0 || !equalJSON(before, row.Collection) {
		q := store.New(tx)
		if reordered {
			ids := make([]pgtype.UUID, len(kept))
			for i, id := range kept {
				ids[i] = pgtype.UUID{Bytes: id, Valid: true}
			}
			_, err := q.SetCollectionAttachmentOrder(ctx, store.SetCollectionAttachmentOrderParams{
				UserID: idPG(uid), CollectionID: idPG(id), AttachmentIds: ids,
			})
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, invalidAttachment
			}
			if err != nil {
				return nil, err
			}
		}
		attachments, err := attachUploads(ctx, q, uid, id, len(kept), uploads)
		if err != nil {
			return nil, err
		}
		autoTags, err := tx.Exec(ctx, `DELETE FROM collection_tags WHERE user_id=$1 AND collection_id=$2 AND decision='auto'`, uid, id)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE collections SET document=$3,plain_text=$4,intent=$5,original_url=$6,manual_title=$7,
			content_version=content_version+1,resource_version=resource_version+1,
			decision_version=decision_version+CASE WHEN $8 THEN 1 ELSE 0 END,updated_at=now()
			WHERE user_id=$1 AND id=$2`, uid, id, jsonBytes(row.Document), plain, row.Intent, rawURL, value(row.ManualTitle), autoTags.RowsAffected() > 0); err != nil {
			return nil, err
		}
		if err := s.enqueueImageAnalysis(ctx, tx, uid, id, attachments); err != nil {
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
		if _, err = s.enqueueURLExtraction(ctx, tx, uid, id, false); err != nil {
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
func attachUploads(ctx context.Context, q *store.Queries, uid, collectionID string, start int, uploads []uuid.UUID) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(uploads))
	for index, upload := range uploads {
		id := uuid.New()
		_, err := q.AttachUpload(ctx, store.AttachUploadParams{
			ID: pgtype.UUID{Bytes: id, Valid: true}, UserID: idPG(uid), CollectionID: idPG(collectionID),
			UploadID: pgtype.UUID{Bytes: upload, Valid: true}, Position: int32(start + index),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, invalidAttachment
		}
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
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
			if _, err = s.enqueueURLExtraction(ctx, tx, uid, id, false); err != nil {
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
	result := contract.CollectionSummary{
		Id: row.Id, DisplayTitle: row.DisplayTitle, Excerpt: shortText(row.PlainText, 200),
		ContentTypes: types, Projects: row.Projects, Tags: slices.DeleteFunc(slices.Clone(row.Tags), func(t contract.TagAssociation) bool { return t.Decision == "rejected" }),
		OrganizationStatus: contract.CollectionSummaryOrganizationStatus(row.Organization.Status),
		HasSuggestion:      row.HasSuggestion, ReadAt: row.ReadAt, CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt, ResourceVersion: row.ResourceVersion, LinkPreview: row.LinkPreview,
	}
	if value(row.OriginalUrl) != "" {
		result.OriginalUrl = row.OriginalUrl
	}
	if count := len(row.Attachments); count > 0 {
		result.AttachmentCount = &count
		result.CoverAttachmentId = &row.Attachments[0].Id
	}
	return result
}

func (s *Server) collectionView(row collectionRow) collectionRow {
	if preview := row.LinkPreview; preview != nil && !s.Config.URLExtractEnabled &&
		(preview.Status == "queued" || preview.Status == "running") {
		row.LinkPreview = &contract.LinkPreview{Status: "skipped"}
	}
	if row.StoredOrganization == nil {
		if !s.Organizer.Enabled {
			code := "integration_not_configured"
			row.Organization.ErrorCode = &code
		} else if !s.Organizer.Trial.allows(row.UserID) {
			code := aiTrialUnavailable
			row.Organization.ErrorCode = &code
		}
	}
	if s.Organizer.Enabled && s.Organizer.Trial.allows(row.UserID) && row.UserAIEnabled &&
		row.HasImageMaterial && s.Organizer.Images.allows(row.UserID, row.UserRole) && row.UserAIConsent != textImageConsentVersion {
		status := contract.OrganizationImageMaterialStatus("consent_required")
		row.Organization.ImageMaterialStatus = &status
	}
	return row
}
