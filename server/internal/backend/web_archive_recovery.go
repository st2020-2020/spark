package backend

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

func webArchiveRecoveryTarget(ctx context.Context, q querier, row collectionRow) (requeue, allowed bool, err error) {
	run, code := row.Organization, value(row.Organization.ErrorCode)
	if run.RunId == nil || !value(row.WebArchiveAvailable) || len(row.Projects) != 0 ||
		(code != "invalid_model_output" && code != modelOutputTruncated && code != "quota_exceeded") {
		return false, false, nil
	}
	// Legacy runs did not snapshot the decision version. Version one has no
	// post-creation decisions, and the project check protects initial choices.
	err = q.QueryRow(ctx, `SELECT r.web_archive_recovery_of IS NOT NULL FROM organization_runs r
		JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
		JOIN users u ON u.id=r.user_id
		WHERE (r.user_id,r.collection_id,r.id)=($1,$2,$3)
		  AND (r.content_version,r.user_policy_version,r.collection_policy_version)=(c.content_version,u.ai_policy_version,c.ai_policy_version)
		  AND r.id=(SELECT id FROM organization_runs WHERE user_id=c.user_id AND collection_id=c.id
		    AND content_version=c.content_version ORDER BY created_at DESC,id DESC LIMIT 1)
		  AND c.decision_version=$4 AND c.decision_version=COALESCE(r.web_archive_decision_version,1)
		  AND u.status='active' AND u.ai_enabled AND u.ai_consent_version=$5
		  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND NOT c.ai_excluded
		  AND r.web_archive AND r.applied_at IS NULL AND r.result IS NULL
		  AND NOT EXISTS (SELECT 1 FROM collection_projects cp WHERE (cp.user_id,cp.collection_id)=(c.user_id,c.id))
		  AND NOT EXISTS (SELECT 1 FROM organization_runs prev
		    WHERE (prev.user_id,prev.collection_id,prev.content_version)=(r.user_id,r.collection_id,r.content_version)
		      AND prev.status IN ('succeeded','partial','queued','running'))
		  AND (
		    (r.web_archive_recovery_of IS NOT NULL AND r.status='blocked' AND r.error_code='quota_exceeded' AND r.attempts=0
		      AND NOT EXISTS (SELECT 1 FROM usage_reservations b WHERE (b.user_id,b.run_id)=(r.user_id,r.id)))
		    OR
		    (r.web_archive_recovery_of IS NULL AND r.status='failed'
		      AND (r.error_code=$6 OR (r.error_code='invalid_model_output' AND r.web_archive_decision_version IS NULL))
		      AND EXISTS (SELECT 1 FROM usage_reservations b WHERE (b.user_id,b.run_id)=(r.user_id,r.id)
		        AND b.state='settled' AND b.error_code=r.error_code AND b.input_tokens>=0 AND b.output_tokens>0 AND b.actual_units IS NOT NULL)
		      AND NOT EXISTS (SELECT 1 FROM usage_reservations b WHERE (b.user_id,b.run_id)=(r.user_id,r.id)
		        AND b.state IN ('reserved','uncertain'))
		      AND NOT EXISTS (SELECT 1 FROM organization_runs recovery
		        WHERE (recovery.user_id,recovery.collection_id,recovery.content_version)=(r.user_id,r.collection_id,r.content_version)
		          AND recovery.web_archive_recovery_of IS NOT NULL))
		  )`, row.UserID, row.Id, run.RunId, row.DecisionVersion, extensionArchiveConsentVersion, modelOutputTruncated).Scan(&requeue)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	return requeue, err == nil, err
}

func addWebArchiveRecoveryAvailability(ctx context.Context, q querier, row *collectionRow) error {
	_, allowed, err := webArchiveRecoveryTarget(ctx, q, *row)
	if allowed {
		row.Organization.WebArchiveRecoveryAvailable = &allowed
	}
	return err
}

func (s *Server) recoverWebArchive(c *gin.Context) (any, error) {
	req, err := bind[contract.WebArchiveRecoveryRequest](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	return s.idempotentWithReplay(c, req, 202, func(tx pgx.Tx) (any, error) {
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
		unavailable := problem(409, "web_archive_recovery_unavailable", "这次整理结果已变化或无法再次处理，请重新读取。")
		if row.Organization.RunId == nil || *row.Organization.RunId != req.RunId {
			return nil, unavailable
		}
		requeue, allowed, err := webArchiveRecoveryTarget(ctx, tx, row)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, unavailable
		}
		hasBudget, err := budgetAvailable(ctx, tx, uid)
		if err != nil {
			return nil, err
		}
		if !hasBudget {
			return nil, problem(429, "quota_exceeded", "剩余 AI 额度不足以恢复网页归类。")
		}
		run := req.RunId.String()
		if requeue {
			const queueStages = `[{"name":"generate","status":"queued","attempts":0}]`
			if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='queued',error_code=NULL,stages=$3::jsonb,
				started_at=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2`, uid, run, queueStages); err != nil {
				return nil, err
			}
		} else {
			run = uuid.NewString()
			if _, err = tx.Exec(ctx, `INSERT INTO organization_runs (id,user_id,collection_id,content_version,user_policy_version,
				collection_policy_version,status,stages,web_archive,web_archive_decision_version,web_archive_recovery_of,created_at,updated_at)
				SELECT $3,user_id,collection_id,content_version,user_policy_version,collection_policy_version,
				'queued','[{"name":"generate","status":"queued","attempts":0}]',true,$4,id,statement_timestamp(),statement_timestamp()
				FROM organization_runs WHERE user_id=$1 AND id=$2`, uid, req.RunId, run, req.BaseDecisionVersion); err != nil {
				return nil, err
			}
		}
		if err := s.Organizer.insertTextJob(ctx, tx, uid, run); err != nil {
			return nil, err
		}
		updated, err := s.loadCollection(ctx, tx, uid, id)
		return updated.Organization, err
	}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
		_, err := s.loadCollection(ctx, tx, uid, id)
		return response, err
	})
}
