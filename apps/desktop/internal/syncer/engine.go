package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/store"
)

const (
	UploadRetention    = 24 * time.Hour
	UploadResignCutoff = 15 * time.Minute
	IdempotencyWindow  = 7 * 24 * time.Hour
)

// BackendClient is the minimal strict whitelist interface needed by Engine.
type BackendClient interface {
	CreateCollectionRaw(ctx context.Context, token string, idempotencyKey string, frozenJSON []byte) (api.Collection, bool, error)
	GetCollection(ctx context.Context, token string, id string) (api.Collection, error)
	ListCollections(ctx context.Context, token string, scope, projectID, tagID, cursor string, limit int) (api.CollectionPage, error)
	ListProjects(ctx context.Context, token string, state, query, cursor string, limit int) (api.ProjectPage, error)
	ListTags(ctx context.Context, token string, query, cursor string, limit int) (api.TagPage, error)
	SearchCollections(ctx context.Context, token string, query, projectID, tagID, cursor string, limit int) (api.SearchPage, error)
	CreateUpload(ctx context.Context, token string, idempotencyKey string, req api.UploadRequest) (api.UploadGrant, error)
	GetUpload(ctx context.Context, token string, uploadID string) (api.Upload, error)
	CompleteUpload(ctx context.Context, token string, uploadID string) (api.Upload, error)
	UploadObjectToOSS(ctx context.Context, grant api.UploadGrant, data []byte) error
}

// Engine drives account-isolated outbox syncing and cache refreshing.
type Engine struct {
	store  *store.Store
	creds  auth.CredentialStore
	client BackendClient
	nowFn  func() time.Time

	mu       sync.Mutex
	onChange func()
	wakeCh   chan struct{}
}

func New(st *store.Store, creds auth.CredentialStore, client BackendClient) *Engine {
	return &Engine{
		store:  st,
		creds:  creds,
		client: client,
		nowFn:  time.Now,
		wakeCh: make(chan struct{}, 1),
	}
}

// SetClock overrides the clock for deterministic unit tests.
func (e *Engine) SetClock(fn func() time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if fn != nil {
		e.nowFn = fn
	}
}

func (e *Engine) now() time.Time {
	e.mu.Lock()
	fn := e.nowFn
	e.mu.Unlock()
	return fn().UTC()
}

func (e *Engine) SetOnChange(fn func()) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onChange = fn
}

func (e *Engine) notifyChange() {
	e.mu.Lock()
	cb := e.onChange
	e.mu.Unlock()
	if cb != nil {
		cb()
	}
}

// Trigger wakes the background sync loop immediately.
func (e *Engine) Trigger() {
	select {
	case e.wakeCh <- struct{}{}:
	default:
	}
}

// Run starts the background outbox + cache refresh loop until ctx is cancelled.
func (e *Engine) Run(ctx context.Context) {
	if sess, err := e.creds.Load(); err == nil && sess.AccountID != "" {
		_ = e.store.ResetInterruptedSyncing(sess.AccountID, e.now())
	}
	e.SyncOnce(ctx)

	ticker := time.NewTicker(8 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wakeCh:
			e.SyncOnce(ctx)
		case <-ticker.C:
			e.SyncOnce(ctx)
		}
	}
}

// SyncOnce processes all due outbox items for the currently active account only.
// Stops immediately on 401 and never crosses accounts.
func (e *Engine) SyncOnce(ctx context.Context) {
	if e.client == nil {
		return
	}
	sess, err := e.creds.Load()
	if err != nil || sess.Token == "" || sess.AccountID == "" {
		return
	}
	now := e.now()
	if !sess.ExpiresAt.IsZero() && !sess.ExpiresAt.After(now) {
		_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已到期，请重新配对后再同步。", now)
		e.notifyChange()
		return
	}

	items, err := e.store.ListDueOutbox(sess.AccountID, now)
	if err != nil || len(items) == 0 {
		return
	}

	for _, item := range items {
		if ctx.Err() != nil {
			return
		}
		// Re-check active session before every item so an account switch mid-tick never crosses queues.
		curSess, err := e.creds.Load()
		if err != nil || curSess.AccountID != sess.AccountID || curSess.Token == "" {
			return
		}
		if stop := e.processItem(ctx, curSess, item); stop {
			e.notifyChange()
			return
		}
		e.notifyChange()
	}
}

// RefreshRemoteCache pulls the latest active collections, projects, and tags into local SQLite.
func (e *Engine) RefreshRemoteCache(ctx context.Context) error {
	if e.client == nil {
		return nil
	}
	sess, err := e.creds.Load()
	if err != nil || sess.Token == "" || sess.AccountID == "" {
		return nil
	}
	now := e.now()
	if !sess.ExpiresAt.IsZero() && !sess.ExpiresAt.After(now) {
		return &api.APIError{Status: http.StatusUnauthorized, Code: "desktop_session_expired", Message: "桌面会话已到期，请重新配对。"}
	}

	if page, err := e.client.ListCollections(ctx, sess.Token, "active", "", "", "", 50); err != nil {
		if isUnauthorized(err) {
			_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，请重新配对。", now)
			e.notifyChange()
		}
		return err
	} else {
		if err := e.store.UpsertCachedCollections(sess.AccountID, page.Items); err != nil {
			return err
		}
	}

	projects := []api.Project{}
	for cursor := ""; ; {
		page, err := e.client.ListProjects(ctx, sess.Token, "active", "", cursor, 100)
		if err != nil {
			return err
		}
		projects = append(projects, page.Items...)
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			return errors.New("项目分页游标未前进")
		}
		cursor = page.NextCursor
	}
	if err := e.store.ReplaceCachedProjects(sess.AccountID, projects); err != nil {
		return err
	}
	tags := []api.Tag{}
	for cursor := ""; ; {
		page, err := e.client.ListTags(ctx, sess.Token, "", cursor, 100)
		if err != nil {
			return err
		}
		tags = append(tags, page.Items...)
		if page.NextCursor == "" {
			break
		}
		if page.NextCursor == cursor {
			return errors.New("标签分页游标未前进")
		}
		cursor = page.NextCursor
	}
	if err := e.store.ReplaceCachedTags(sess.AccountID, tags); err != nil {
		return err
	}
	e.notifyChange()
	return nil
}

// processItem returns stop=true when a 401 requires pausing the entire account queue immediately.
func (e *Engine) processItem(ctx context.Context, sess auth.StoredSession, item store.OutboxItem) (stop bool) {
	now := e.now()
	if err := e.store.MarkOutboxSyncing(sess.AccountID, item.ID, now); err != nil {
		return false
	}

	// Step 1: If the collection request is not frozen yet, upload and verify all staged attachments first.
	if item.FrozenRequestJSON == "" {
		uploadIDs := make([]string, 0, len(item.Attachments))
		for _, att := range item.Attachments {
			upID, stopQueue, waitRetry, terminalErr := e.ensureAttachmentReady(ctx, sess, att)
			if stopQueue {
				return true
			}
			if terminalErr != nil {
				code, msg := extractErrorCodeMessage(terminalErr, "attachment_failed")
				_ = e.store.MarkOutboxNeedsReview(sess.AccountID, item.ID, code, msg, e.now())
				return false
			}
			if waitRetry > 0 {
				_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, "upload_in_progress", "图片正在云端校验，稍后自动继续同步。", e.now().Add(waitRetry), e.now())
				return false
			}
			uploadIDs = append(uploadIDs, upID)
		}

		// Freeze exact UUID + final CollectionCreate JSON BEFORE the first outbound POST /collections.
		req := api.CollectionCreate{
			ID:         item.ID,
			Document:   api.BuildDocument(item.RawText),
			UploadIDs:  uploadIDs,
			ProjectIDs: item.ProjectIDs,
			TagIDs:     item.TagIDs,
			AIExcluded: false,
		}
		req.Intent = item.Intent
		if item.OriginalURL != "" {
			v := item.OriginalURL
			req.OriginalURL = &v
		}
		if item.ManualTitle != "" {
			v := item.ManualTitle
			req.ManualTitle = &v
		}
		frozenBytes, err := json.Marshal(req)
		if err != nil {
			_ = e.store.MarkOutboxNeedsReview(sess.AccountID, item.ID, "marshal_failed", err.Error(), e.now())
			return false
		}
		if err := e.store.FreezeOutboxRequest(sess.AccountID, item.ID, string(frozenBytes), e.now()); err != nil {
			_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, "local_db_error", err.Error(), e.now().Add(5*time.Second), e.now())
			return false
		}
		item.FrozenRequestJSON = string(frozenBytes)
	}

	// Step 2: Check 7-day idempotency window rule:
	// - Never-sent offline drafts (!item.EverSent) CAN make their first send even if CreatedAt > 7 days ago.
	// - Previously-sent items (item.EverSent) whose FirstSentAt is >= 7 days ago MUST verify by GET /collections/{id} first;
	//   never automatically swap UUID, overwrite, or resurrect.
	if item.EverSent && !item.FirstSentAt.IsZero() && e.now().Sub(item.FirstSentAt) >= IdempotencyWindow {
		col, err := e.client.GetCollection(ctx, sess.Token, item.ID)
		if err == nil {
			e.acceptReceipt(sess.AccountID, item, col)
			return false
		}
		if isUnauthorized(err) {
			_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，请重新配对。", e.now())
			return true
		}
		if ae, ok := api.AsAPIError(err); ok {
			if ae.Status == http.StatusNotFound || ae.Status == http.StatusConflict || ae.Status == http.StatusForbidden {
				_ = e.store.MarkOutboxNeedsReview(
					sess.AccountID,
					item.ID,
					"idempotency_window_expired",
					"曾尝试发送且已超过 7 天幂等窗口，按原 ID 未查到云端记录（可能未写入或已删除）。为防重复或误复活，已保留本机原稿供核对。",
					e.now(),
				)
				return false
			}
		}
		// Transient network error while verifying: retry verification later without creating a new ID.
		_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, "verify_retry", err.Error(), e.now().Add(backoffDuration(item.AttemptCount)), e.now())
		return false
	}

	// Step 3: Record outbound attempt BEFORE POST so a crash mid-flight preserves EverSent & FirstSentAt.
	if err := e.store.MarkOutboxSent(sess.AccountID, item.ID, e.now()); err != nil {
		return false
	}

	col, _, err := e.client.CreateCollectionRaw(ctx, sess.Token, item.IdempotencyKey, []byte(item.FrozenRequestJSON))
	if err == nil {
		e.acceptReceipt(sess.AccountID, item, col)
		return false
	}

	if isUnauthorized(err) {
		_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，已暂停上传，请重新配对。", e.now())
		return true
	}

	if ae, ok := api.AsAPIError(err); ok {
		switch {
		case ae.Status == http.StatusConflict && ae.Code == "operation_in_progress":
			wait := ae.RetryAfter
			if wait <= 0 {
				wait = 3 * time.Second
			}
			_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, ae.Code, ae.Message, e.now().Add(wait), e.now())
			return false
		case ae.Status == http.StatusConflict:
			// 409 duplicate_resource / tombstone / idempotency_mismatch: NEVER swap ID, overwrite, or resurrect.
			msg := ae.Message
			if msg == "" {
				msg = "云端返回冲突（可能已存在或已永久删除），已保留本机原稿供核对。"
			}
			_ = e.store.MarkOutboxNeedsReview(sess.AccountID, item.ID, ae.Code, msg, e.now())
			return false
		case ae.Status == http.StatusNotFound || ae.Status == http.StatusForbidden ||
			ae.Status == http.StatusUnprocessableEntity || ae.Status == http.StatusRequestEntityTooLarge ||
			ae.Status == http.StatusBadRequest:
			_ = e.store.MarkOutboxNeedsReview(sess.AccountID, item.ID, ae.Code, ae.Message, e.now())
			return false
		case ae.Status == http.StatusTooManyRequests || ae.Status >= 500:
			wait := ae.RetryAfter
			if wait <= 0 {
				wait = backoffDuration(item.AttemptCount)
			}
			_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, ae.Code, ae.Message, e.now().Add(wait), e.now())
			return false
		}
	}

	// Network timeout / offline / lost response: retry later using the exact same frozen UUID, JSON, and Idempotency-Key.
	_ = e.store.MarkOutboxRetry(sess.AccountID, item.ID, "network_error", err.Error(), e.now().Add(backoffDuration(item.AttemptCount)), e.now())
	return false
}

// Keep the original and its staged files until the matching live receipt has been cached.
func (e *Engine) acceptReceipt(account string, item store.OutboxItem, col api.Collection) {
	now := e.now()
	if col.ID != item.ID || col.DeletedAt != nil {
		_ = e.store.MarkOutboxNeedsReview(account, item.ID, "receipt_mismatch", "云端记录已删除或回执编号不符，原稿留在本机供核对。", now)
		return
	}
	if err := e.store.UpsertCachedCollectionDetail(account, col); err == nil {
		if err = e.store.MarkOutboxSynced(account, item.ID, now); err == nil {
			return
		}
	}
	_ = e.store.MarkOutboxRetry(account, item.ID, "local_db_error", "云端已收下，正在重新保存本机回执。", now.Add(backoffDuration(item.AttemptCount)), now)
}

func (e *Engine) ensureAttachmentReady(
	ctx context.Context,
	sess auth.StoredSession,
	att store.OutboxAttachment,
) (uploadID string, stopQueue bool, waitRetry time.Duration, terminalErr error) {
	if att.Stage == store.StageReady && att.UploadID != "" {
		if !att.UploadExpiresAt.IsZero() && !att.UploadExpiresAt.After(e.now()) {
			_, err := e.store.RotateExpiredAttachmentRegistration(sess.AccountID, att.ID)
			return "", false, time.Second, err
		}
		return att.UploadID, false, 0, nil
	}

	now := e.now()

	// Already submitted complete (202): poll GET /uploads/{id} until ready.
	if att.Stage == store.StageVerifying && att.UploadID != "" {
		up, err := e.client.GetUpload(ctx, sess.Token, att.UploadID)
		if err != nil {
			if isUnauthorized(err) {
				_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，请重新配对。", now)
				return "", true, 0, nil
			}
			if isTransientError(err) {
				return "", false, 3 * time.Second, nil
			}
			return "", false, 0, err
		}
		switch up.Status {
		case "ready", "attached":
			_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageReady, up.ExpiresAt, "")
			return up.ID, false, 0, nil
		case "verifying":
			_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageVerifying, up.ExpiresAt, "")
			return "", false, 2 * time.Second, nil
		case "expired":
			// Registration expired before collection freeze -> rotate to a fresh registration.
			if _, err := e.store.RotateExpiredAttachmentRegistration(sess.AccountID, att.ID); err != nil {
				return "", false, 0, err
			}
			return "", false, time.Second, nil
		default:
			errCode := "upload_rejected"
			if up.ErrorCode != nil && *up.ErrorCode != "" {
				errCode = *up.ErrorCode
			}
			_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageFailed, up.ExpiresAt, errCode)
			return "", false, 0, &api.APIError{Status: http.StatusUnprocessableEntity, Code: errCode, Message: "图片未能通过云端校验，请核对后重试。"}
		}
	}

	// If already registered, enforce the 24h retention and 15m re-sign cutoff before attempting re-signing.
	if att.UploadID != "" && !att.UploadExpiresAt.IsZero() && !att.UploadExpiresAt.Add(-UploadResignCutoff).After(now) {
		if att.Stage == store.StagePendingLocal || att.Stage == store.StageGrantIssued {
			// Stop re-signing within 15m of 24h expiry; rotate registration since collection is not yet frozen.
			newKey, err := e.store.RotateExpiredAttachmentRegistration(sess.AccountID, att.ID)
			if err != nil {
				return "", false, 0, err
			}
			att.UploadIdempotencyKey = newKey
			att.UploadID = ""
			att.Stage = store.StagePendingLocal
			att.UploadRegisteredAt = time.Time{}
			att.UploadExpiresAt = time.Time{}
			att.GrantURL = ""
			att.GrantExpiresAt = time.Time{}
		}
	}

	// Step A: Register or re-sign upload if not yet uploaded to OSS.
	if att.Stage == store.StagePendingLocal || att.Stage == store.StageGrantIssued {
		needGrant := att.UploadID == "" || att.GrantURL == "" || !att.GrantExpiresAt.After(now.Add(15*time.Second))
		var grant api.UploadGrant
		if needGrant {
			var err error
			grant, err = e.client.CreateUpload(ctx, sess.Token, att.UploadIdempotencyKey, api.UploadRequest{
				Filename:  att.Filename,
				MimeType:  att.MimeType,
				SizeBytes: att.SizeBytes,
			})
			if err != nil {
				if isUnauthorized(err) {
					_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，请重新配对。", now)
					return "", true, 0, nil
				}
				if ae, ok := api.AsAPIError(err); ok {
					if ae.Status == http.StatusConflict && ae.Code == "upload_not_pending" {
						_, _ = e.store.RotateExpiredAttachmentRegistration(sess.AccountID, att.ID)
						return "", false, time.Second, nil
					}
					if ae.Status == http.StatusTooManyRequests || ae.Status >= 500 {
						wait := ae.RetryAfter
						if wait <= 0 {
							wait = 5 * time.Second
						}
						return "", false, wait, nil
					}
					return "", false, 0, err
				}
				return "", false, 5 * time.Second, nil
			}
			regAt := att.UploadRegisteredAt
			if regAt.IsZero() {
				regAt = now
			}
			upExp := att.UploadExpiresAt
			if upExp.IsZero() {
				upExp = regAt.Add(UploadRetention)
			}
			if err := e.store.UpdateAttachmentGrant(sess.AccountID, att.ID, grant.ID, store.StageGrantIssued, regAt, upExp, grant); err != nil {
				return "", false, 0, err
			}
			att.UploadID = grant.ID
			att.UploadRegisteredAt = regAt
			att.UploadExpiresAt = upExp
			att.GrantURL = grant.URL
			att.GrantMethod = grant.Method
			att.GrantHeaders = grant.Headers
			att.GrantExpiresAt = grant.ExpiresAt
		} else {
			grant = api.UploadGrant{
				ID:        att.UploadID,
				URL:       att.GrantURL,
				Method:    att.GrantMethod,
				Headers:   att.GrantHeaders,
				ExpiresAt: att.GrantExpiresAt,
			}
		}

		// Step B: Direct PUT to OSS with explicit Content-Length and zero Spark auth headers.
		rawBytes, err := e.store.ReadAttachmentBytes(att)
		if err != nil {
			return "", false, 0, fmt.Errorf("read staged attachment: %w", err)
		}
		if err := e.client.UploadObjectToOSS(ctx, grant, rawBytes); err != nil {
			if ae, ok := api.AsAPIError(err); ok && (ae.Status == http.StatusForbidden || ae.Status == http.StatusBadRequest) {
				// Signed PUT URL may have expired; clear cached grant so next tick re-signs if >15m left.
				_ = e.store.UpdateAttachmentGrant(sess.AccountID, att.ID, att.UploadID, store.StagePendingLocal, att.UploadRegisteredAt, att.UploadExpiresAt, api.UploadGrant{})
				return "", false, 2 * time.Second, nil
			}
			if isTransientError(err) {
				return "", false, 5 * time.Second, nil
			}
			return "", false, 0, err
		}
		_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageUploadedOSS, att.UploadExpiresAt, "")
		att.Stage = store.StageUploadedOSS
	}

	// Step C: Complete upload (202) and persist stage=verifying (or ready).
	if att.Stage == store.StageUploadedOSS {
		up, err := e.client.CompleteUpload(ctx, sess.Token, att.UploadID)
		if err != nil {
			if isUnauthorized(err) {
				_ = e.store.PauseAccountQueueOn401(sess.AccountID, "desktop_session_expired", "桌面会话已失效，请重新配对。", now)
				return "", true, 0, nil
			}
			if ae, ok := api.AsAPIError(err); ok && ae.Status == http.StatusConflict && ae.Code == "upload_not_pending" {
				// Check current state via GET /uploads/{id}.
				_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageVerifying, att.UploadExpiresAt, "")
				return "", false, time.Second, nil
			}
			if isTransientError(err) {
				return "", false, 5 * time.Second, nil
			}
			return "", false, 0, err
		}
		if up.Status == "ready" || up.Status == "attached" {
			_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageReady, up.ExpiresAt, "")
			return up.ID, false, 0, nil
		}
		_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageVerifying, up.ExpiresAt, "")
		// Poll once right away in case verification completed synchronously in fast/synthetic backends.
		checked, err := e.client.GetUpload(ctx, sess.Token, att.UploadID)
		if err == nil && (checked.Status == "ready" || checked.Status == "attached") {
			_ = e.store.UpdateAttachmentStage(sess.AccountID, att.ID, store.StageReady, checked.ExpiresAt, "")
			return checked.ID, false, 0, nil
		}
		return "", false, 2 * time.Second, nil
	}

	return "", false, 2 * time.Second, nil
}

func isUnauthorized(err error) bool {
	ae, ok := api.AsAPIError(err)
	return ok && ae.Status == http.StatusUnauthorized
}

func isTransientError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	if ae, ok := api.AsAPIError(err); ok {
		return ae.Status == http.StatusTooManyRequests || ae.Status >= 500
	}
	return true
}

func extractErrorCodeMessage(err error, fallbackCode string) (string, string) {
	if ae, ok := api.AsAPIError(err); ok {
		msg := ae.Message
		if msg == "" {
			msg = ae.Error()
		}
		return ae.Code, msg
	}
	return fallbackCode, err.Error()
}

func backoffDuration(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	d := 3 * time.Second
	for i := 0; i < attempts && i < 6; i++ {
		d *= 2
	}
	if d > 2*time.Minute {
		return 2 * time.Minute
	}
	return d
}
