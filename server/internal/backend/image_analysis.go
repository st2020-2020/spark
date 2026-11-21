package backend

import (
	"context"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"spark/server/internal/contract"
)

var imageExtractionVersions = []string{imageExtractorVersion, legacyImageRecoveryExtractorVersion, imageRecoveryExtractorVersion}

const (
	imageConsentVersion                 = "deepseek-images-v1"
	imageExtractorVersion               = "deepseek-flash-image-v1"
	legacyImageRecoveryExtractorVersion = "deepseek-flash-image-recovery-v1"
	imageRecoveryExtractorVersion       = "deepseek-flash-image-recovery-v2"
	imageAnalysisQueue                  = "image_analysis"
	imageJobLockSalt                    = 43
	// All callers bind $2 to the administrator configured for this process.
	imageAccountAllowedSQL = "($2::text = '' OR (u.role = 'admin' AND u.id::text = $2))"
)

type imageAnalysisArgs struct {
	UserID       string `json:"user_id"`
	CollectionID string `json:"collection_id"`
	ExtractionID string `json:"extraction_id"`
}

func (imageAnalysisArgs) Kind() string { return "spark_analyze_image" }

type imageEvidence struct {
	Description string `json:"description,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
}

func (s *Server) getImagePreferences(c *gin.Context) (any, error) {
	return s.imagePreferences(c.Request.Context(), s.Pool, current(c).User.ID)
}

func (s *Server) imagePreferences(ctx context.Context, q querier, uid string) (contract.ImageAnalysisPreferences, error) {
	out := contract.ImageAnalysisPreferences{
		RequiredConsentVersion: imageConsentVersion,
	}
	err := q.QueryRow(ctx, `SELECT coalesce(u.image_consent_version=$3,false), $4::boolean AND `+imageAccountAllowedSQL+` FROM users u WHERE u.id=$1`, uid, s.Config.ImageAdminID, imageConsentVersion, s.Config.ImageAnalysisEnabled).Scan(&out.Enabled, &out.Available)
	return out, err
}

func (s *Server) setImagePreferences(c *gin.Context) (any, error) {
	req, err := bind[contract.ImageAnalysisPreferencesUpdate](s, c)
	if err != nil {
		return nil, err
	}
	if req.Enabled && value(req.ConsentVersion) != imageConsentVersion {
		return nil, problem(422, "validation_failed", "请先确认将新保存的图片发送给第三方 DeepSeek 以识别文字和描述画面。")
	}
	ctx, uid := c.Request.Context(), current(c).User.ID
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var consent any
	if req.Enabled {
		prefs, err := s.imagePreferences(ctx, tx, uid)
		if err != nil {
			return nil, err
		}
		if !prefs.Available {
			return nil, problem(403, "image_analysis_unavailable", "当前账号暂未开放图片理解。")
		}
		consent = imageConsentVersion
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET image_consent_version=$2::text,
		image_consented_at=CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
		image_policy_version=image_policy_version+1,updated_at=now()
		WHERE id=$1 AND image_consent_version IS DISTINCT FROM $2::text`, uid, consent); err != nil {
		return nil, err
	}
	out, err := s.imagePreferences(ctx, tx, uid)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *Server) enqueueImageAnalysis(ctx context.Context, tx pgx.Tx, uid, id string, attachments []uuid.UUID) error {
	if !s.Config.ImageAnalysisEnabled || len(attachments) == 0 {
		return nil
	}
	for _, attachment := range attachments {
		jobID := uuid.NewString()
		status, err := tx.Exec(ctx, `INSERT INTO extractions
			(id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,extractor_version,
			 image_user_policy_version,image_collection_policy_version)
			SELECT $6,c.user_id,c.id,c.content_version,'image',a.id::text,a.id,$7,u.image_policy_version,c.ai_policy_version
			FROM collections c JOIN users u ON u.id=c.user_id
			JOIN attachments a ON (a.user_id,a.collection_id)=(c.user_id,c.id)
			WHERE c.user_id=$1 AND c.id=$3 AND a.id=$4 AND a.removed_at IS NULL
			  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND NOT c.ai_excluded
			  AND u.status='active' AND u.image_consent_version=$5 AND `+imageAccountAllowedSQL+`
			ON CONFLICT DO NOTHING`, uid, s.Config.ImageAdminID, id, attachment, imageConsentVersion, jobID, imageExtractorVersion)
		if err != nil {
			return err
		}
		if status.RowsAffected() == 0 {
			continue
		}
		if _, err := s.Organizer.Queue.InsertTx(ctx, tx, imageAnalysisArgs{
			UserID: uid, CollectionID: id, ExtractionID: jobID,
		}, &river.InsertOpts{Queue: imageAnalysisQueue, MaxAttempts: 3}); err != nil {
			return err
		}
	}
	return nil
}
