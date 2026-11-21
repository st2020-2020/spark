package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

func emptyImageTruncation(row store.Extraction, evidence imageEvidence) bool {
	return row.ExtractorVersion == imageExtractorVersion && row.ImageUserPolicyVersion.Valid &&
		evidence.Truncated && strings.TrimSpace(row.Text.String) == "" && strings.TrimSpace(evidence.Description) == "" &&
		(row.Status == "partial" || row.Status == "failed" && row.ErrorCode.String == "image_output_truncated_empty")
}

func quotaBlockedImageRecovery(row store.Extraction) bool {
	// The worker writes this state before it inserts a dispatch reservation.
	return row.ExtractorVersion == imageRecoveryExtractorVersion && row.Status == "blocked" && row.ErrorCode.String == "quota_exceeded"
}

func (s *Server) retryImageAnalysis(c *gin.Context) (any, error) {
	req, err := bind[contract.ImageAnalysisRetry](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, attachment := c.Request.Context(), current(c).User.ID, c.Param("id")
	return s.idempotentWithReplay(c, req, 202, func(tx pgx.Tx) (any, error) {
		item, err := s.imageRecovery(ctx, tx, uid, attachment, req.BaseExtractionId.String(), true)
		return idempotentCurrentResponse{body: item}, err
	}, func(tx pgx.Tx, _ json.RawMessage) (any, error) {
		return s.imageRecovery(ctx, tx, uid, attachment, req.BaseExtractionId.String(), false)
	})
}

// The idempotency transaction holds the account change lock. Both keys for
// one attachment and concurrent preferences, edits and deletions serialize.
func (s *Server) imageRecovery(ctx context.Context, tx pgx.Tx, uid, attachment, baseID string, enqueue bool) (contract.Extraction, error) {
	var item contract.Extraction
	var collection string
	var trashed, excluded bool
	err := tx.QueryRow(ctx, `SELECT c.id,c.deleted_at IS NOT NULL,c.ai_excluded
		FROM attachments a JOIN collections c ON (c.user_id,c.id)=(a.user_id,a.collection_id)
		WHERE a.user_id=$1 AND a.id=$2 AND a.removed_at IS NULL AND c.purge_requested_at IS NULL`, uid, attachment).
		Scan(&collection, &trashed, &excluded)
	if err != nil {
		return item, err
	}
	if trashed {
		return item, problem(409, "collection_in_trash", "请先从回收站恢复收藏。")
	}
	q := store.New(tx)
	lookup := store.GetAttachmentImageExtractionParams{
		UserID: idPG(uid), CollectionID: idPG(collection), AttachmentID: idPG(attachment), ExtractorVersion: imageExtractorVersion,
	}
	base, err := q.GetAttachmentImageExtraction(ctx, lookup)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, problem(422, "image_retry_not_available", "此附件没有可恢复的图片识别结果。")
	}
	if err != nil {
		return item, err
	}
	lookup.ExtractorVersion = imageRecoveryExtractorVersion
	recovery, err := q.GetAttachmentImageExtraction(ctx, lookup)
	existing := err == nil
	if !existing && !errors.Is(err, pgx.ErrNoRows) {
		return item, err
	}
	isRecoveryTarget := existing && recovery.ID.String() == baseID
	if base.ID.String() != baseID && !isRecoveryTarget {
		return item, problem(409, "extraction_conflict", "图片识别结果已变化，请重新读取。")
	}
	requeue := enqueue && isRecoveryTarget && quotaBlockedImageRecovery(recovery)
	if existing && !requeue {
		return extractionView(recovery)
	}
	if !enqueue {
		return item, pgx.ErrNoRows
	}
	if !s.Config.ImageAnalysisEnabled {
		return item, problem(503, "integration_not_configured", "图片理解暂未开启。")
	}
	prefs, err := s.imagePreferences(ctx, tx, uid)
	if err != nil {
		return item, err
	}
	switch {
	case !prefs.Available:
		return item, problem(403, "image_analysis_unavailable", "当前账号暂未开放图片理解。")
	case !prefs.Enabled:
		return item, problem(403, "image_consent_required", "请先开启图片理解并同意图片发送范围。")
	case excluded:
		return item, problem(403, "ai_excluded", "此收藏已排除 AI 处理。")
	}
	baseView, err := extractionView(base)
	if err != nil {
		return item, err
	}
	if !requeue && !value(baseView.ImageRetryAvailable) {
		return item, problem(422, "image_retry_not_available", "只有识别截断且未得到内容的图片可以尝试恢复。")
	}
	blocked, err := imageRouteBlocked(ctx, tx)
	if err != nil {
		return item, err
	}
	if blocked {
		return item, problem(503, "image_token_limit", "图片理解暂时无法在额度上限内运行。")
	}
	day, err := budgetDayWithCapacity(ctx, tx, uid, imageReservationUnits)
	if err != nil {
		return item, err
	}
	if day == "" {
		return item, problem(429, "quota_exceeded", "剩余 AI 额度不足以重新识别此图片。")
	}
	if requeue {
		recovery, err = q.RequeueUnsentImageRecovery(ctx, store.RequeueUnsentImageRecoveryParams{UserID: idPG(uid), ID: recovery.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return item, problem(422, "image_retry_not_available", "该恢复作业已经派发或记账。")
		}
	} else {
		recovery, err = q.InsertImageRecovery(ctx, store.InsertImageRecoveryParams{
			ID: idPG(uuid.NewString()), UserID: idPG(uid), BaseID: base.ID, RecoveryVersion: imageRecoveryExtractorVersion,
		})
	}
	if err != nil {
		return item, err
	}
	if _, err := s.Organizer.Queue.InsertTx(ctx, tx, imageAnalysisArgs{
		UserID: uid, CollectionID: collection, ExtractionID: recovery.ID.String(),
	}, &river.InsertOpts{Queue: imageAnalysisQueue, MaxAttempts: 3}); err != nil {
		return item, err
	}
	return extractionView(recovery)
}

func imageRouteBlocked(ctx context.Context, q querier) (bool, error) {
	var blocked bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ai_route_failures WHERE config_version=$1 AND route=$2)`,
		imageExtractorVersion, imageAccountingRoute.Name).Scan(&blocked)
	return blocked, err
}
