package backend

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

const (
	uploadRetention = 24 * time.Hour
	uploadDrain     = 15 * time.Minute
)

var (
	uploadsUnavailable = problem(503, "integration_not_configured", "图片存储暂不可用。")
	invalidAttachment  = problem(422, "invalid_attachment", "请选择属于本账号且已确认的图片。")
)

func (s *Server) createUpload(c *gin.Context) (any, error) {
	if s.Assets == nil {
		return nil, uploadsUnavailable
	}
	req, err := bind[contract.UploadRequest](s, c)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(req.Filename) == "" || strings.ContainsFunc(req.Filename, unicode.IsControl) ||
		strings.ContainsAny(req.Filename, "/\\") {
		return nil, problem(422, "validation_failed", "图片文件名无效。")
	}
	ctx, uid := c.Request.Context(), current(c).User.ID
	owner := idPG(uid)
	replay := false
	stored, err := s.idempotentWithReplay(c, req, 201, func(tx pgx.Tx) (any, error) {
		if err := s.chargeAssetLimit(c, tx, "upload-count", 1, maxUploadsPerWindow, uploadQuotaWindow); err != nil {
			return nil, err
		}
		if err := s.chargeAssetLimit(c, tx, "upload-bytes", req.SizeBytes, maxUploadBytesPerWindow, uploadQuotaWindow); err != nil {
			return nil, err
		}
		if err := s.chargeAssetLimit(c, tx, "put", 1, maxPUTsPerSigningWindow, assetSigningWindow); err != nil {
			return nil, err
		}
		id := uuid.New()
		staging, _ := s.Assets.Keys(uid, id.String())
		upload, err := store.New(tx).CreateUpload(ctx, store.CreateUploadParams{
			ID: idPG(id.String()), UserID: owner, StagingKey: staging, Filename: req.Filename,
			DeclaredSize: int64(req.SizeBytes), MimeType: string(req.MimeType),
			ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(uploadRetention), Valid: true},
		})
		if err != nil {
			return nil, err
		}
		if _, err := queueUploadCleanup(ctx, tx, s.Organizer.Queue, cleanupUploadArgs{
			UserID: uid, UploadID: id.String(),
		}, upload.ExpiresAt.Time); err != nil {
			return nil, err
		}
		// The upload ID is sufficient for a replay. URLs and STS tokens
		// must never be persisted in the generic idempotency response.
		return id, nil
	}, func(_ pgx.Tx, response json.RawMessage) (any, error) {
		var id uuid.UUID
		err := json.Unmarshal(response, &id)
		replay = true
		return id, err
	})
	if err != nil {
		return nil, err
	}
	id := stored.(uuid.UUID)
	u, err := store.New(s.Pool).GetUpload(ctx, store.GetUploadParams{UserID: owner, ID: idPG(id.String())})
	if err != nil {
		return nil, err
	}
	if u.Status != "pending" || !u.ExpiresAt.Time.Add(-uploadDrain).After(time.Now()) {
		return nil, problem(409, "upload_not_pending", "这次上传已进入确认或已过期，请重新选择图片。")
	}
	if replay {
		if err := s.chargeAssetLimit(c, s.Pool, "put", 1, maxPUTsPerSigningWindow, assetSigningWindow); err != nil {
			return nil, err
		}
	}
	grant, err := s.Assets.SignPut(ctx, u.StagingKey, u.MimeType, u.DeclaredSize, u.ExpiresAt.Time.Add(-uploadDrain))
	if err != nil {
		return nil, err
	}
	return contract.UploadGrant{Id: id, Url: grant.URL, Headers: grant.Headers, Method: "PUT", ExpiresAt: grant.ExpiresAt}, nil
}

func (s *Server) getUpload(c *gin.Context) (any, error) {
	row, err := store.New(s.Pool).GetUpload(c.Request.Context(), store.GetUploadParams{
		UserID: idPG(current(c).User.ID), ID: idPG(c.Param("id")),
	})
	if err != nil {
		return nil, err
	}
	return uploadView(row), nil
}

func (s *Server) completeUpload(c *gin.Context) (any, error) {
	if s.Assets == nil {
		return nil, uploadsUnavailable
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	params := store.GetUploadParams{UserID: idPG(uid), ID: idPG(id)}
	row, err := q.GetUpload(ctx, params)
	if err != nil {
		return nil, err
	}
	if uploadView(row).Status == contract.UploadStatus("pending") {
		// Use the canonical UUID in generated and persisted object keys.
		id = uuid.UUID(row.ID.Bytes).String()
		_, final := s.Assets.Keys(uid, id)
		row, err = q.BeginUploadVerification(ctx, store.BeginUploadVerificationParams{UserID: params.UserID, ID: params.ID, FinalKey: final})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, problem(409, "upload_not_pending", "图片上传已过期，请重新选择图片。")
		}
		if err != nil {
			return nil, err
		}
		if _, err := s.Organizer.Queue.InsertTx(ctx, tx, verifyUploadArgs{UserID: uid, UploadID: id}, &river.InsertOpts{
			Queue: assetQueue, MaxAttempts: 3,
		}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	c.Set("status", 202)
	return uploadView(row), nil
}

func (s *Server) getDownload(c *gin.Context) (any, error) {
	if s.Assets == nil {
		return nil, uploadsUnavailable
	}
	ctx := c.Request.Context()
	q := store.New(s.Pool)
	params := store.GetAttachmentForDownloadParams{UserID: idPG(current(c).User.ID), ID: idPG(c.Param("id"))}
	row, err := q.GetAttachmentForDownload(ctx, params)
	if err != nil {
		return nil, err
	}
	if err := s.chargeAssetLimit(c, s.Pool, "get", 1, maxGETsPerSigningWindow, assetSigningWindow); err != nil {
		return nil, err
	}
	grant, err := s.Assets.SignGet(ctx, row.ObjectKey, row.ProviderVersion.String)
	if err != nil {
		return nil, err
	}
	// Signing can take a network round trip. Recheck that the attachment
	// wasn't removed or its collection marked for purge in the meantime.
	if _, err := q.GetAttachmentForDownload(ctx, params); err != nil {
		return nil, err
	}
	return contract.DownloadGrant{Url: grant.URL, ExpiresAt: grant.ExpiresAt}, nil
}

func uploadView(row store.Upload) contract.Upload {
	status := row.Status
	if status != "attached" && !row.ExpiresAt.Time.After(time.Now()) {
		status = "expired"
	}
	size := int(row.DeclaredSize)
	result := contract.Upload{
		Id: uuid.UUID(row.ID.Bytes), Status: contract.UploadStatus(status), ExpiresAt: row.ExpiresAt.Time,
		SizeBytes: &size, MimeType: &row.MimeType,
	}
	if row.ErrorCode.Valid {
		result.ErrorCode = &row.ErrorCode.String
	}
	return result
}
