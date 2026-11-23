package backend

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

func (s *Server) checkWebArchiveAccess(row collectionRow) error {
	if err := checkActive(row); err != nil {
		return err
	}
	switch {
	case !s.Organizer.Enabled:
		return problem(503, "integration_not_configured", "文字整理暂不可用。")
	case !s.Organizer.Trial.allows(row.UserID):
		return problem(403, aiTrialUnavailable, "AI 整理暂未向此账号开放。")
	case !row.UserAIEnabled:
		return problem(403, "ai_disabled", "请先开启文字整理。")
	case row.AiExcluded:
		return problem(403, "ai_excluded", "已排除这条收藏的 AI 整理。")
	case !allowsWebArchive(row.UserAIConsent):
		return problem(403, "web_archive_consent_required", "请先确认网页归类资料处理说明。")
	}
	return nil
}

func loadWebProjectBackfill(ctx context.Context, q querier, row collectionRow) (runSnapshot, *modelTopic, error) {
	run := runSnapshot{UID: row.UserID, CollectionID: row.Id.String(), ID: value(row.Organization.RunId).String()}
	// Version one is assigned at creation. Version two plus a tag produced
	// by this run proves the only increment came from applying that output.
	// The old schema cannot distinguish prior manual removes from other increments.
	if value(row.Organization.WebArchiveStatus) != "no_match" || row.DecisionVersion != 2 || len(row.Projects) != 0 {
		return run, nil, nil
	}
	var payload []byte
	err := q.QueryRow(ctx, `
		SELECT r.result FROM organization_runs r
		JOIN organization_current oc ON (oc.user_id,oc.collection_id,oc.run_id)=(r.user_id,r.collection_id,r.id)
		JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
		JOIN users u ON u.id=r.user_id
		WHERE (r.user_id,r.collection_id,r.id)=($1,$2,$3)
		  AND c.content_version=$4 AND c.decision_version=2
		  AND (r.content_version,r.user_policy_version,r.collection_policy_version)=(c.content_version,u.ai_policy_version,c.ai_policy_version)
		  AND r.web_archive AND r.web_archive_status='no_match' AND r.status IN ('succeeded','partial') AND r.applied_at IS NOT NULL
		  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND NOT c.ai_excluded
		  AND u.status='active' AND u.ai_enabled AND u.ai_consent_version=$5
		  AND EXISTS(SELECT 1 FROM usage_reservations ur WHERE (ur.user_id,ur.run_id)=(r.user_id,r.id) AND ur.state='settled')
		  AND NOT EXISTS(SELECT 1 FROM usage_reservations ur WHERE (ur.user_id,ur.run_id)=(r.user_id,r.id) AND ur.state IN ('reserved','uncertain'))`,
		run.UID, run.CollectionID, run.ID, row.ContentVersion, extensionArchiveConsentVersion).Scan(&payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return run, nil, nil
	}
	if err != nil {
		return run, nil, err
	}
	var result organizationResult
	if err := json.Unmarshal(payload, &result); err != nil {
		return run, nil, err
	}
	material := webArchiveMaterial{value(row.ManualTitle), row.PlainText, row.Intent}
	clean := material.filtered()
	sources := []textSource{
		{ID: "page_title", Text: clean.title, original: material.title},
		{ID: "original_text", Text: clean.text, original: material.text},
		{ID: "intent", Text: clean.intent, original: material.intent},
	}
	topic, err := webFilingTopic(ctx, q, run, result.Tags, sources, true)
	return run, topic, err
}

func (s *Server) collectionWithWebArchiveActions(c *gin.Context) (collectionRow, error) {
	ctx := c.Request.Context()
	row, err := s.loadCollection(ctx, s.Pool, current(c).User.ID, c.Param("id"))
	if err != nil || s.checkWebArchiveAccess(row) != nil {
		return row, err
	}
	if value(row.Organization.WebArchiveStatus) != "no_match" {
		err = addWebArchiveRecoveryAvailability(ctx, s.Pool, &row)
		return row, err
	}
	_, topic, err := loadWebProjectBackfill(ctx, s.Pool, row)
	if topic != nil {
		available := true
		row.Organization.ProjectBackfillAvailable = &available
	}
	return row, err
}

func (s *Server) applyWebArchiveProject(c *gin.Context) (any, error) {
	req, err := bind[contract.ProjectBackfillRequest](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	return s.idempotentWithReplay(c, req, 200, func(tx pgx.Tx) (any, error) {
		row, err := s.loadCollection(ctx, tx, uid, id)
		if err != nil {
			return nil, err
		}
		if err := s.checkWebArchiveAccess(row); err != nil {
			return nil, err
		}
		if row.DecisionVersion != req.BaseDecisionVersion {
			return nil, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
		}
		unavailable := problem(409, "project_backfill_unavailable", "已有整理结果不再适合自动归类。")
		run, topic, err := loadWebProjectBackfill(ctx, tx, row)
		if err != nil {
			return nil, err
		}
		if topic == nil {
			return nil, unavailable
		}
		result := organizationResult{Topic: topic}
		status, _, err := applyAutomaticProject(ctx, tx, run, textInput{decisionVersion: int64(row.DecisionVersion)}, &result)
		if err != nil {
			return nil, err
		}
		if status == "" {
			return nil, unavailable
		}
		if _, err := tx.Exec(ctx, `UPDATE organization_runs SET web_archive_status=$4,updated_at=now()
			WHERE (user_id,collection_id,id)=($1,$2,$3)`, uid, id, run.ID, status); err != nil {
			return nil, err
		}
		updated, err := s.finishCollectionDecisions(ctx, tx, uid, id)
		return idempotentCurrentResponse{body: updated}, err
	}, func(tx pgx.Tx, _ json.RawMessage) (any, error) {
		row, err := s.loadCollection(ctx, tx, uid, id)
		if err != nil {
			return nil, err
		}
		if err := s.checkWebArchiveAccess(row); err != nil {
			return nil, err
		}
		return row.Collection, nil
	})
}
