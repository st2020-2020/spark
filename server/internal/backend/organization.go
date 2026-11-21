package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/contract"
)

type TextOrganizationArgs struct {
	UserID string `json:"user_id"`
	RunID  string `json:"run_id"`
}

func (TextOrganizationArgs) Kind() string { return "spark_text_organization" }

type Organizer struct {
	Pool    *pgxpool.Pool
	Queue   *river.Client[pgx.Tx]
	Enabled bool
	Trial   AITrialScope
	Images  ImageOrganizationScope
}

func NewOrganizer(pool *pgxpool.Pool, enabled bool, trial AITrialScope) (*Organizer, error) {
	q, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Schema: db.RiverSchema(pool)})
	if err != nil {
		return nil, err
	}
	return &Organizer{Pool: pool, Queue: q, Enabled: enabled, Trial: trial}, nil
}
func materialAvailable(text, intent string) bool {
	return strings.TrimSpace(urlInText.ReplaceAllString(text, "")) != "" || strings.TrimSpace(intent) != ""
}

// Caller holds user_change_counters, so new inputs supersede prior runs in the
// same transaction as content and River insertion. No network work occurs here.
func (o *Organizer) Enqueue(ctx context.Context, tx pgx.Tx, uid, id string, explicit bool) (string, string, error) {
	return o.enqueue(ctx, tx, uid, id, explicit, false)
}

func (o *Organizer) EnqueueImage(ctx context.Context, tx pgx.Tx, uid, id string) error {
	_, _, err := o.enqueue(ctx, tx, uid, id, false, true)
	return err
}

func (o *Organizer) enqueue(ctx context.Context, tx pgx.Tx, uid, id string, explicit, imageEvent bool) (string, string, error) {
	var enabled, excluded bool
	var status, text, intent, role, consent string
	var deleted *time.Time
	var cv, uv, pv int64
	err := tx.QueryRow(ctx, `SELECT u.ai_enabled,u.status,u.ai_policy_version,c.ai_excluded,c.ai_policy_version,c.content_version,c.plain_text,c.intent,c.deleted_at,u.role,COALESCE(u.ai_consent_version,'') FROM collections c JOIN users u ON u.id=c.user_id WHERE c.user_id=$1 AND c.id=$2`, uid, id).Scan(&enabled, &status, &uv, &excluded, &pv, &cv, &text, &intent, &deleted, &role, &consent)
	if err != nil {
		return "", "", err
	}
	reason := ""
	switch {
	case !o.Enabled:
		reason = "integration_not_configured"
	case !o.Trial.allows(uid):
		reason = aiTrialUnavailable
	case !enabled || status != "active":
		reason = "ai_disabled"
	case excluded:
		reason = "ai_excluded"
	case deleted != nil:
		reason = "collection_in_trash"
	}
	if reason != "" {
		return "", reason, nil
	}
	if imageEvent && consent != textImageNotesConsentVersion {
		return "", "", nil
	}
	hasImages, pendingImages, err := o.Images.candidates(ctx, tx, uid, id, role)
	if err != nil {
		return "", "", err
	}
	canUseImages := hasImages && allowsTextImageMaterial(consent)
	hasText := materialAvailable(text, intent)
	if hasImages && !canUseImages && (explicit || !hasText) {
		return "", "image_material_consent_required", nil
	}
	if !hasText && !canUseImages {
		return "", "insufficient_material", nil
	}
	if imageEvent && !canUseImages {
		return "", "", nil
	}
	waitImages := canUseImages && pendingImages
	var active string
	err = tx.QueryRow(ctx, `SELECT id FROM organization_runs WHERE user_id=$1 AND collection_id=$2 AND content_version=$3 AND user_policy_version=$4 AND collection_policy_version=$5 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, uid, id, cv, uv, pv).Scan(&active)
	if err == nil {
		return active, "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	if canUseImages && !pendingImages && consent == textImageNotesConsentVersion {
		sources, _, err := o.Images.sources(ctx, tx, uid, id)
		if err != nil {
			return "", "", err
		}
		ids := imageExtractionIDs(sources)
		if len(ids) > 0 {
			err = tx.QueryRow(ctx, `SELECT id FROM organization_runs
				WHERE (user_id,collection_id,content_version,user_policy_version,collection_policy_version)=($1,$2,$3,$4,$5)
				  AND image_extraction_ids=$6
				ORDER BY created_at DESC,id DESC LIMIT 1`, uid, id, cv, uv, pv, ids).Scan(&active)
			if err == nil || !errors.Is(err, pgx.ErrNoRows) {
				return active, "", err
			}
		}
	}
	if explicit {
		ok, err := budgetAvailable(ctx, tx, uid)
		if err != nil {
			return "", "", err
		}
		if !ok {
			return "", "quota_exceeded", nil
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='superseded',error_code='input_changed',updated_at=now(),completed_at=now() WHERE user_id=$1 AND collection_id=$2 AND status IN ('queued','running')`, uid, id); err != nil {
		return "", "", err
	}
	run := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO organization_runs(id,user_id,collection_id,content_version,user_policy_version,collection_policy_version,status,stages,image_waiting)
		VALUES($1,$2,$3,$4,$5,$6,'queued',CASE WHEN $7
			THEN '[{"name":"extract_images","status":"queued","attempts":0}]'::jsonb
			ELSE '[{"name":"generate","status":"queued","attempts":0}]'::jsonb END,$7)`, run, uid, id, cv, uv, pv, waitImages); err != nil {
		return "", "", err
	}
	if _, err = o.Queue.InsertTx(ctx, tx, TextOrganizationArgs{UserID: uid, RunID: run}, &river.InsertOpts{MaxAttempts: 5, Queue: "text_organization"}); err != nil {
		return "", "", err
	}
	return run, "", nil
}
func (s *Server) updatePreferences(c *gin.Context) (any, error) {
	req, err := bind[contract.Preferences](s, c)
	if err != nil {
		return nil, err
	}
	if value(req.AiEnabled) && strings.TrimSpace(value(req.ConsentVersion)) == "" {
		return nil, problem(422, "validation_failed", "开启 AI 前请确认资料处理说明。")
	}
	if req.AiEnabled == nil && req.ConsentVersion != nil {
		return nil, problem(422, "validation_failed", "同意版本须与 AI 设置一起提交。")
	}
	ctx := c.Request.Context()
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	uid := current(c).User.ID
	var old bool
	var oldConsent string
	if err = tx.QueryRow(ctx, `SELECT ai_enabled,COALESCE(ai_consent_version,'') FROM users WHERE id=$1 FOR UPDATE`, uid).Scan(&old, &oldConsent); err != nil {
		return nil, err
	}
	if req.AiEnabled != nil && (old != *req.AiEnabled || *req.AiEnabled && oldConsent != value(req.ConsentVersion)) {
		if _, err = tx.Exec(ctx, `UPDATE users SET ai_enabled=$2,ai_policy_version=ai_policy_version+1,ai_consent_at=CASE WHEN $2 THEN now() ELSE ai_consent_at END,ai_consent_version=CASE WHEN $2 THEN $3 ELSE ai_consent_version END,updated_at=now() WHERE id=$1`, uid, *req.AiEnabled, value(req.ConsentVersion)); err != nil {
			return nil, err
		}
		if !*req.AiEnabled {
			if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='skipped',error_code='ai_disabled',updated_at=now(),completed_at=now() WHERE user_id=$1 AND status='queued'`, uid); err != nil {
				return nil, err
			}
		}
	}
	if req.Palette != nil || req.Theme != nil {
		if _, err = tx.Exec(ctx, `UPDATE users SET palette=COALESCE(NULLIF($2,''),palette),
			theme=COALESCE(NULLIF($3,''),theme),updated_at=now()
			WHERE id=$1 AND (palette<>COALESCE(NULLIF($2,''),palette)
				OR theme<>COALESCE(NULLIF($3,''),theme))`, uid, string(value(req.Palette)), string(value(req.Theme))); err != nil {
			return nil, err
		}
	}
	var u userView
	if err = tx.QueryRow(ctx, `SELECT id,email_normalized,role,status,ai_enabled,ai_policy_version,palette,theme,COALESCE(ai_consent_version,'') FROM users WHERE id=$1`, uid).Scan(&u.ID, &u.Email, &u.Role, &u.Status, &u.AIEnabled, &u.AIPolicyVersion, &u.Palette, &u.Theme, &u.AIConsentVersion); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return u, nil
}
func (s *Server) setAIExclusion(c *gin.Context) (any, error) {
	req, err := bind[contract.AIExclusion](s, c)
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
	if row.AiExcluded != req.Excluded {
		if _, err = tx.Exec(ctx, `UPDATE collections SET ai_excluded=$3,ai_policy_version=ai_policy_version+1,resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, id, req.Excluded); err != nil {
			return nil, err
		}
		if req.Excluded {
			if _, err = tx.Exec(ctx, `UPDATE organization_runs SET status='skipped',error_code='ai_excluded',updated_at=now(),completed_at=now() WHERE user_id=$1 AND collection_id=$2 AND status='queued'`, uid, id); err != nil {
				return nil, err
			}
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
func (s *Server) restartOrganization(c *gin.Context) (any, error) {
	return s.idempotentWithReplay(c, nil, 202, func(tx pgx.Tx) (any, error) {
		uid, id := current(c).User.ID, c.Param("id")
		_, reason, err := s.Organizer.Enqueue(c.Request.Context(), tx, uid, id, true)
		if err != nil {
			return nil, err
		}
		if reason != "" {
			if reason == aiTrialUnavailable {
				return nil, problem(403, reason, "AI 整理暂未向此账号开放。")
			}
			if reason == "image_material_consent_required" {
				return nil, problem(403, reason, "请先确认将已识别的图中文字和画面描述用于文字 AI 整理。")
			}
			status := 403
			switch reason {
			case "integration_not_configured":
				status = 503
			case "insufficient_material":
				status = 422
			case "collection_in_trash":
				status = 409
			case "quota_exceeded":
				status = 429
			}
			return nil, problem(status, reason, "当前无法重新整理，请检查处理设置、材料或额度。")
		}
		row, err := s.loadCollection(c.Request.Context(), tx, uid, id)
		return row.Organization, err
	}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
		_, err := s.loadCollection(c.Request.Context(), tx, current(c).User.ID, c.Param("id"))
		return response, err
	})
}
