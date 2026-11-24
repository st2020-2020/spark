package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"spark/apps/desktop/internal/api"
)

type OutboxState string

const (
	OutboxLocalSaved  OutboxState = "local_saved"
	OutboxSyncing     OutboxState = "syncing"
	OutboxSynced      OutboxState = "synced"
	OutboxNeedsReview OutboxState = "needs_review"
	OutboxAuthPaused  OutboxState = "auth_paused"
)

type AttachmentStage string

const (
	StagePendingLocal AttachmentStage = "pending_local"
	StageGrantIssued  AttachmentStage = "grant_issued"
	StageUploadedOSS  AttachmentStage = "uploaded_oss"
	StageVerifying    AttachmentStage = "verifying"
	StageReady        AttachmentStage = "ready"
	StageFailed       AttachmentStage = "failed"
)

type PendingAttachmentInput struct {
	Filename string
	Data     []byte
}

type EnqueueInput struct {
	AccountID   string
	RawText     string
	SuppressURL bool
	Intent      string
	OriginalURL string
	ManualTitle string
	ProjectIDs  []string
	TagIDs      []string
	Attachments []PendingAttachmentInput
}

type OutboxAttachment struct {
	ID                   string            `json:"id"`
	OutboxID             string            `json:"outbox_id"`
	AccountID            string            `json:"account_id"`
	Order                int               `json:"order"`
	Filename             string            `json:"filename"`
	MimeType             string            `json:"mime_type"`
	SizeBytes            int               `json:"size_bytes"`
	LocalPath            string            `json:"-"`
	UploadIdempotencyKey string            `json:"-"`
	UploadID             string            `json:"upload_id,omitempty"`
	Stage                AttachmentStage   `json:"stage"`
	UploadRegisteredAt   time.Time         `json:"upload_registered_at,omitempty"`
	UploadExpiresAt      time.Time         `json:"upload_expires_at,omitempty"`
	GrantURL             string            `json:"-"`
	GrantMethod          string            `json:"-"`
	GrantHeaders         map[string]string `json:"-"`
	GrantExpiresAt       time.Time         `json:"-"`
	LastError            string            `json:"last_error,omitempty"`
}

type OutboxItem struct {
	ID                string             `json:"id"`
	AccountID         string             `json:"account_id"`
	RawText           string             `json:"raw_text"`
	Intent            string             `json:"intent,omitempty"`
	OriginalURL       string             `json:"original_url,omitempty"`
	ManualTitle       string             `json:"manual_title,omitempty"`
	ProjectIDs        []string           `json:"project_ids"`
	TagIDs            []string           `json:"tag_ids"`
	IdempotencyKey    string             `json:"-"`
	FrozenRequestJSON string             `json:"-"`
	State             OutboxState        `json:"state"`
	EverSent          bool               `json:"ever_sent"`
	FirstSentAt       time.Time          `json:"first_sent_at,omitempty"`
	LastAttemptAt     time.Time          `json:"last_attempt_at,omitempty"`
	NextRetryAt       time.Time          `json:"next_retry_at,omitempty"`
	AttemptCount      int                `json:"attempt_count"`
	LastErrorCode     string             `json:"last_error_code,omitempty"`
	LastErrorMessage  string             `json:"last_error_message,omitempty"`
	CreatedAt         time.Time          `json:"created_at"`
	UpdatedAt         time.Time          `json:"updated_at"`
	Attachments       []OutboxAttachment `json:"attachments,omitempty"`
}

func newIdempotencyKey(prefix string) (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return prefix + "-" + base64.RawURLEncoding.EncodeToString(raw), nil
}

// EnqueueCapture atomically writes staged attachment files to disk and inserts the outbox record
// in a single SQLite transaction under the active account scope.
// Returns an OutboxItem in state "local_saved" immediately once persisted on disk.
func (s *Store) EnqueueCapture(in EnqueueInput, now time.Time) (OutboxItem, error) {
	if !filepath.IsLocal(in.AccountID) || filepath.Base(in.AccountID) != in.AccountID || in.AccountID == "." {
		return OutboxItem{}, errors.New("请先登录 Spark 账号。")
	}

	rawURL := strings.TrimSpace(in.OriginalURL)
	if rawURL == "" && !in.SuppressURL {
		rawURL = api.ExtractFirstURL(in.RawText)
	}
	if err := api.ValidateCaptureInput(in.RawText, in.Intent, rawURL, len(in.Attachments)); err != nil {
		return OutboxItem{}, err
	}

	collectionID := uuid.NewString()
	idemKey, err := newIdempotencyKey("col")
	if err != nil {
		return OutboxItem{}, fmt.Errorf("generate idempotency key: %w", err)
	}

	// Stage and fsync all image files atomically before starting the DB transaction.
	type stagedFile struct {
		att      OutboxAttachment
		fullPath string
	}
	staged := make([]stagedFile, 0, len(in.Attachments))
	cleanupStaged := func() {
		for _, f := range staged {
			_ = os.Remove(f.fullPath)
		}
	}

	for idx, rawAtt := range in.Attachments {
		mimeType, safeName, err := api.ValidateImageBytes(rawAtt.Data, rawAtt.Filename)
		if err != nil {
			cleanupStaged()
			return OutboxItem{}, err
		}
		attID := uuid.NewString()
		upKey, err := newIdempotencyKey("up")
		if err != nil {
			cleanupStaged()
			return OutboxItem{}, err
		}
		relPath := filepath.Join(in.AccountID, collectionID, attID+".bin")
		fullPath := filepath.Join(s.stagingDir, relPath)
		if err := writeFileAtomic(fullPath, rawAtt.Data); err != nil {
			cleanupStaged()
			return OutboxItem{}, fmt.Errorf("stage attachment on disk: %w", err)
		}
		staged = append(staged, stagedFile{
			fullPath: fullPath,
			att: OutboxAttachment{
				ID:                   attID,
				OutboxID:             collectionID,
				AccountID:            in.AccountID,
				Order:                idx,
				Filename:             safeName,
				MimeType:             mimeType,
				SizeBytes:            len(rawAtt.Data),
				LocalPath:            relPath,
				UploadIdempotencyKey: upKey,
				Stage:                StagePendingLocal,
			},
		})
	}

	projIDs := in.ProjectIDs
	if projIDs == nil {
		projIDs = []string{}
	}
	tagIDs := in.TagIDs
	if tagIDs == nil {
		tagIDs = []string{}
	}
	projJSON, _ := json.Marshal(projIDs)
	tagJSON, _ := json.Marshal(tagIDs)
	ts := now.UTC().Format(time.RFC3339Nano)

	tx, err := s.db.Begin()
	if err != nil {
		cleanupStaged()
		return OutboxItem{}, err
	}
	defer tx.Rollback()

	_, err = tx.Exec(`
		INSERT INTO outbox_items (
			id, account_id, raw_text, intent, original_url, manual_title,
			project_ids_json, tag_ids_json, idempotency_key, frozen_request_json,
			state, ever_sent, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?, ?)`,
		collectionID, in.AccountID, in.RawText, in.Intent,
		rawURL, strings.TrimSpace(in.ManualTitle),
		string(projJSON), string(tagJSON), idemKey,
		string(OutboxLocalSaved), ts, ts,
	)
	if err != nil {
		cleanupStaged()
		return OutboxItem{}, fmt.Errorf("insert outbox item: %w", err)
	}

	for _, f := range staged {
		_, err = tx.Exec(`
			INSERT INTO outbox_attachments (
				id, outbox_id, account_id, ord, filename, mime_type, size_bytes,
				local_path, upload_idempotency_key, stage
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			f.att.ID, f.att.OutboxID, f.att.AccountID, f.att.Order,
			f.att.Filename, f.att.MimeType, f.att.SizeBytes,
			f.att.LocalPath, f.att.UploadIdempotencyKey, string(f.att.Stage),
		)
		if err != nil {
			cleanupStaged()
			return OutboxItem{}, fmt.Errorf("insert outbox attachment: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		cleanupStaged()
		return OutboxItem{}, fmt.Errorf("commit outbox capture: %w", err)
	}

	item, _, err := s.GetOutboxItem(in.AccountID, collectionID)
	return item, err
}

func (s *Store) GetOutboxItem(accountID, id string) (OutboxItem, bool, error) {
	row := s.db.QueryRow(`
		SELECT id, account_id, raw_text, intent, original_url, manual_title,
		       project_ids_json, tag_ids_json, idempotency_key, frozen_request_json,
		       state, ever_sent, first_sent_at, last_attempt_at, next_retry_at,
		       attempt_count, last_error_code, last_error_message, created_at, updated_at
		FROM outbox_items WHERE account_id=? AND id=?`, accountID, id)
	item, err := scanOutboxItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return OutboxItem{}, false, nil
	}
	if err != nil {
		return OutboxItem{}, false, err
	}
	atts, err := s.listOutboxAttachments(accountID, id)
	if err != nil {
		return OutboxItem{}, false, err
	}
	item.Attachments = atts
	return item, true, nil
}

// ListOutbox returns outbox records strictly scoped to accountID, newest first.
func (s *Store) ListOutbox(accountID string, limit int) ([]OutboxItem, error) {
	return s.listOutbox(accountID, limit, false)
}
func (s *Store) ListPending(accountID string) ([]OutboxItem, error) {
	return s.listOutbox(accountID, 100, true)
}
func (s *Store) listOutbox(accountID string, limit int, pendingOnly bool) ([]OutboxItem, error) {
	if accountID == "" {
		return []OutboxItem{}, nil
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, account_id, raw_text, intent, original_url, manual_title,
		       project_ids_json, tag_ids_json, idempotency_key, frozen_request_json,
		       state, ever_sent, first_sent_at, last_attempt_at, next_retry_at,
		       attempt_count, last_error_code, last_error_message, created_at, updated_at
		FROM outbox_items WHERE account_id=? AND (?=0 OR state!='synced') ORDER BY created_at DESC LIMIT ?`, accountID, pendingOnly, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]OutboxItem, 0)
	for rows.Next() {
		item, err := scanOutboxItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range items {
		atts, err := s.listOutboxAttachments(accountID, items[i].ID)
		if err != nil {
			return nil, err
		}
		items[i].Attachments = atts
	}
	return items, nil
}

// ListDueOutbox returns pending items for accountID that are eligible for syncing at now.
// Recovers interrupted "syncing" rows from previous process restarts automatically.
func (s *Store) ListDueOutbox(accountID string, now time.Time) ([]OutboxItem, error) {
	if accountID == "" {
		return nil, nil
	}
	nowStr := now.UTC().Format(time.RFC3339Nano)
	rows, err := s.db.Query(`
		SELECT id, account_id, raw_text, intent, original_url, manual_title,
		       project_ids_json, tag_ids_json, idempotency_key, frozen_request_json,
		       state, ever_sent, first_sent_at, last_attempt_at, next_retry_at,
		       attempt_count, last_error_code, last_error_message, created_at, updated_at
		FROM outbox_items
		WHERE account_id=?
		  AND state IN ('local_saved', 'syncing')
		  AND (next_retry_at = '' OR next_retry_at <= ?)
		ORDER BY created_at ASC LIMIT 25`, accountID, nowStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []OutboxItem
	for rows.Next() {
		item, err := scanOutboxItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range items {
		atts, err := s.listOutboxAttachments(accountID, items[i].ID)
		if err != nil {
			return nil, err
		}
		items[i].Attachments = atts
	}
	return items, nil
}

// ResetInterruptedSyncing transitions stale "syncing" items back to "local_saved" on startup.
func (s *Store) ResetInterruptedSyncing(accountID string, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items SET state='local_saved', updated_at=?
		WHERE account_id=? AND state='syncing'`,
		now.UTC().Format(time.RFC3339Nano), accountID)
	return err
}

// ResumeAuthPaused transitions auth_paused items for accountID back to local_saved after re-pairing.
func (s *Store) ResumeAuthPaused(accountID string, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items SET state='local_saved', next_retry_at='', last_error_code='', last_error_message='', updated_at=?
		WHERE account_id=? AND state='auth_paused'`,
		now.UTC().Format(time.RFC3339Nano), accountID)
	return err
}

// PauseAccountQueueOn401 marks all in-flight/local_saved items for accountID as auth_paused.
func (s *Store) PauseAccountQueueOn401(accountID string, code, msg string, now time.Time) (bool, error) {
	result, err := s.db.Exec(`
		UPDATE outbox_items SET state='auth_paused', last_error_code=?, last_error_message=?, updated_at=?
		WHERE account_id=? AND state IN ('local_saved', 'syncing')`,
		code, msg, now.UTC().Format(time.RFC3339Nano), accountID)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (s *Store) MarkOutboxSyncing(accountID, id string, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items SET state='syncing', last_attempt_at=?, attempt_count=attempt_count+1, updated_at=?
		WHERE account_id=? AND id=?`,
		now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), accountID, id)
	return err
}

// FreezeOutboxRequest persists the exact final CollectionCreate JSON before the first outbound POST /collections.
// Once frozen, the collection UUID, request body, and idempotency key never mutate.
func (s *Store) FreezeOutboxRequest(accountID, id, frozenJSON string, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items SET frozen_request_json=?, updated_at=?
		WHERE account_id=? AND id=? AND frozen_request_json=''`,
		frozenJSON, now.UTC().Format(time.RFC3339Nano), accountID, id)
	return err
}

// MarkOutboxSent records that an outbound POST /collections attempt has been dispatched (for 7-day window tracking).
func (s *Store) MarkOutboxSent(accountID, id string, now time.Time) error {
	ts := now.UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`
		UPDATE outbox_items
		SET ever_sent=1,
		    first_sent_at=CASE WHEN first_sent_at='' THEN ? ELSE first_sent_at END,
		    updated_at=?
		WHERE account_id=? AND id=?`,
		ts, ts, accountID, id)
	return err
}

func (s *Store) MarkOutboxRetry(accountID, id, errCode, errMsg string, nextRetry time.Time, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items
		SET state='local_saved', last_error_code=?, last_error_message=?, next_retry_at=?, updated_at=?
		WHERE account_id=? AND id=?`,
		errCode, errMsg, nextRetry.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), accountID, id)
	return err
}

// MarkOutboxNeedsReview preserves the local draft & files untouched so the user can inspect/verify.
func (s *Store) MarkOutboxNeedsReview(accountID, id, errCode, errMsg string, now time.Time) error {
	_, err := s.db.Exec(`
		UPDATE outbox_items
		SET state='needs_review', last_error_code=?, last_error_message=?, next_retry_at='', updated_at=?
		WHERE account_id=? AND id=?`,
		errCode, errMsg, now.UTC().Format(time.RFC3339Nano), accountID, id)
	return err
}

// MarkOutboxSynced marks the outbox item synced and removes temporary staged attachment files.
func (s *Store) MarkOutboxSynced(accountID, id string, now time.Time) error {
	atts, _ := s.listOutboxAttachments(accountID, id)
	_, err := s.db.Exec(`
		UPDATE outbox_items
		SET state='synced', last_error_code='', last_error_message='', next_retry_at='', updated_at=?
		WHERE account_id=? AND id=?`,
		now.UTC().Format(time.RFC3339Nano), accountID, id)
	if err != nil {
		return err
	}
	for _, att := range atts {
		if att.LocalPath != "" {
			_ = os.Remove(filepath.Join(s.stagingDir, att.LocalPath))
		}
	}
	_ = os.Remove(filepath.Join(s.stagingDir, accountID, id))
	return nil
}

// DeleteOutboxItem deletes a needs_review or local item and cleans up its staged files.
func (s *Store) DeleteOutboxItem(accountID, id string) error {
	atts, _ := s.listOutboxAttachments(accountID, id)
	res, err := s.db.Exec(`DELETE FROM outbox_items WHERE account_id=? AND id=? AND state='needs_review'`, accountID, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("只能删除当前账号需核对的原稿")
	}
	for _, att := range atts {
		if att.LocalPath != "" {
			_ = os.Remove(filepath.Join(s.stagingDir, att.LocalPath))
		}
	}
	_ = os.Remove(filepath.Join(s.stagingDir, accountID, id))
	return nil
}

func (s *Store) ReadAttachmentBytes(att OutboxAttachment) ([]byte, error) {
	return os.ReadFile(filepath.Join(s.stagingDir, att.LocalPath))
}

func (s *Store) UpdateAttachmentGrant(
	accountID, attID, uploadID string,
	stage AttachmentStage,
	registeredAt, uploadExpiresAt time.Time,
	grant api.UploadGrant,
) error {
	headersJSON, _ := json.Marshal(grant.Headers)
	regStr := ""
	if !registeredAt.IsZero() {
		regStr = registeredAt.UTC().Format(time.RFC3339Nano)
	}
	expStr := ""
	if !uploadExpiresAt.IsZero() {
		expStr = uploadExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	grantExpStr := ""
	if !grant.ExpiresAt.IsZero() {
		grantExpStr = grant.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.Exec(`
		UPDATE outbox_attachments
		SET upload_id=?, stage=?,
		    upload_registered_at=CASE WHEN upload_registered_at='' THEN ? ELSE upload_registered_at END,
		    upload_expires_at=CASE WHEN upload_expires_at='' THEN ? ELSE upload_expires_at END,
		    grant_url=?, grant_method=?, grant_headers_json=?, grant_expires_at=?, last_error=''
		WHERE account_id=? AND id=?`,
		uploadID, string(stage), regStr, expStr,
		grant.URL, grant.Method, string(headersJSON), grantExpStr,
		accountID, attID)
	return err
}

func (s *Store) UpdateAttachmentStage(accountID, attID string, stage AttachmentStage, uploadExpiresAt time.Time, lastErr string) error {
	if !uploadExpiresAt.IsZero() {
		_, err := s.db.Exec(`
			UPDATE outbox_attachments SET stage=?, upload_expires_at=?, last_error=?
			WHERE account_id=? AND id=?`,
			string(stage), uploadExpiresAt.UTC().Format(time.RFC3339Nano), lastErr, accountID, attID)
		return err
	}
	_, err := s.db.Exec(`
		UPDATE outbox_attachments SET stage=?, last_error=?
		WHERE account_id=? AND id=?`,
		string(stage), lastErr, accountID, attID)
	return err
}

// RotateExpiredAttachmentRegistration resets an expired upload registration before collection freeze,
// issuing a new upload idempotency key so a fresh 24h registration can be created.
func (s *Store) RotateExpiredAttachmentRegistration(accountID, attID string) (string, error) {
	newKey, err := newIdempotencyKey("up")
	if err != nil {
		return "", err
	}
	_, err = s.db.Exec(`
		UPDATE outbox_attachments
		SET upload_idempotency_key=?, upload_id='', stage='pending_local',
		    upload_registered_at='', upload_expires_at='',
		    grant_url='', grant_method='', grant_headers_json='{}', grant_expires_at='',
		    last_error=''
		WHERE account_id=? AND id=?`,
		newKey, accountID, attID)
	return newKey, err
}

func (s *Store) listOutboxAttachments(accountID, outboxID string) ([]OutboxAttachment, error) {
	rows, err := s.db.Query(`
		SELECT id, outbox_id, account_id, ord, filename, mime_type, size_bytes,
		       local_path, upload_idempotency_key, upload_id, stage,
		       upload_registered_at, upload_expires_at,
		       grant_url, grant_method, grant_headers_json, grant_expires_at, last_error
		FROM outbox_attachments
		WHERE account_id=? AND outbox_id=? ORDER BY ord ASC`, accountID, outboxID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []OutboxAttachment
	for rows.Next() {
		var a OutboxAttachment
		var stageStr, regStr, expStr, headersStr, grantExpStr string
		if err := rows.Scan(
			&a.ID, &a.OutboxID, &a.AccountID, &a.Order,
			&a.Filename, &a.MimeType, &a.SizeBytes,
			&a.LocalPath, &a.UploadIdempotencyKey, &a.UploadID, &stageStr,
			&regStr, &expStr,
			&a.GrantURL, &a.GrantMethod, &headersStr, &grantExpStr, &a.LastError,
		); err != nil {
			return nil, err
		}
		a.Stage = AttachmentStage(stageStr)
		a.UploadRegisteredAt = parseTimeOpt(regStr)
		a.UploadExpiresAt = parseTimeOpt(expStr)
		a.GrantExpiresAt = parseTimeOpt(grantExpStr)
		if headersStr != "" {
			_ = json.Unmarshal([]byte(headersStr), &a.GrantHeaders)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func scanOutboxItem(scanner interface{ Scan(...any) error }) (OutboxItem, error) {
	var item OutboxItem
	var projJSON, tagJSON, stateStr string
	var everSentInt int
	var firstSentStr, lastAttStr, nextRetryStr, createdStr, updatedStr string
	if err := scanner.Scan(
		&item.ID, &item.AccountID, &item.RawText, &item.Intent,
		&item.OriginalURL, &item.ManualTitle,
		&projJSON, &tagJSON, &item.IdempotencyKey, &item.FrozenRequestJSON,
		&stateStr, &everSentInt, &firstSentStr, &lastAttStr, &nextRetryStr,
		&item.AttemptCount, &item.LastErrorCode, &item.LastErrorMessage,
		&createdStr, &updatedStr,
	); err != nil {
		return OutboxItem{}, err
	}
	item.State = OutboxState(stateStr)
	item.EverSent = everSentInt != 0
	item.FirstSentAt = parseTimeOpt(firstSentStr)
	item.LastAttemptAt = parseTimeOpt(lastAttStr)
	item.NextRetryAt = parseTimeOpt(nextRetryStr)
	item.CreatedAt = parseTimeOpt(createdStr)
	item.UpdatedAt = parseTimeOpt(updatedStr)
	_ = json.Unmarshal([]byte(projJSON), &item.ProjectIDs)
	_ = json.Unmarshal([]byte(tagJSON), &item.TagIDs)
	if item.ProjectIDs == nil {
		item.ProjectIDs = []string{}
	}
	if item.TagIDs == nil {
		item.TagIDs = []string{}
	}
	return item, nil
}

func parseTimeOpt(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return ts
	}
	if ts, err := time.Parse(time.RFC3339, s); err == nil {
		return ts
	}
	return time.Time{}
}

func (s *Store) Counts(accountID string) (map[OutboxState]int, error) {
	rows, err := s.db.Query("SELECT state,count(*) FROM outbox_items WHERE account_id=? AND state!='synced' GROUP BY state", accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[OutboxState]int{}
	for rows.Next() {
		var state OutboxState
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		counts[state] = n
	}
	return counts, rows.Err()
}
