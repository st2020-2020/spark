package backend

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"spark/server/internal/store"
)

var errPurgeAccountingBusy = errors.New("collection has an in-flight model charge")

// purgeDatabase deletes the content in one transaction. The caller has the
// account change lock and verified the independent receipt already exists.
func purgeDatabase(ctx context.Context, tx pgx.Tx, row store.DeletionLedger) error {
	var marked bool
	err := tx.QueryRow(ctx, `SELECT purge_requested_at IS NOT NULL FROM collections
		WHERE user_id=$1 AND id=$2 FOR UPDATE`, row.UserID, row.CollectionID).Scan(&marked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !marked {
		return errors.New("collection is not marked for permanent deletion")
	}

	// A text worker holds this session lock through the provider call and
	// settlement. Try the same lock without waiting while holding the account
	// lock. A crashed worker's unconfirmed reservation remains chargeable.
	var canDetach bool
	err = tx.QueryRow(ctx, `
		SELECT coalesce(bool_and(pg_try_advisory_xact_lock(hashtextextended(r.id::text,17))),true)
		FROM organization_runs r
		WHERE r.user_id=$1 AND r.collection_id=$2 AND EXISTS (
		  SELECT 1 FROM usage_reservations u
		  WHERE (u.user_id,u.run_id)=(r.user_id,r.id) AND u.state='reserved'
		)`, row.UserID, row.CollectionID).Scan(&canDetach)
	if err != nil {
		return err
	}
	if !canDetach {
		return errPurgeAccountingBusy
	}
	err = tx.QueryRow(ctx, `
		SELECT coalesce(bool_and(pg_try_advisory_xact_lock(hashtextextended(e.id::text,$3))),true)
		FROM extractions e
		WHERE e.user_id=$1 AND e.collection_id=$2 AND e.status='running'
		  AND e.image_user_policy_version IS NOT NULL AND EXISTS (
		   SELECT 1 FROM usage_reservations u
		   WHERE (u.user_id,u.image_extraction_id)=(e.user_id,e.id) AND u.state='uncertain'
		  )`, row.UserID, row.CollectionID, imageJobLockSalt).Scan(&canDetach)
	if err != nil {
		return err
	}
	if !canDetach {
		return errPurgeAccountingBusy
	}
	if _, err := tx.Exec(ctx, `UPDATE usage_reservations u
		SET state='uncertain',error_code='usage_uncertain',updated_at=now()
		FROM organization_runs r
		WHERE (u.user_id,u.run_id)=(r.user_id,r.id) AND r.user_id=$1 AND r.collection_id=$2 AND u.state='reserved'`, row.UserID, row.CollectionID); err != nil {
		return fmt.Errorf("preserve pending model charges: %w", err)
	}

	for _, stmt := range []struct{ name, sql string }{
		{"extractions", "DELETE FROM extractions WHERE user_id=$1 AND collection_id=$2"},
		{"revisions", "DELETE FROM collection_revisions WHERE user_id=$1 AND collection_id=$2"},
		{"current organization", "DELETE FROM organization_current WHERE user_id=$1 AND collection_id=$2"},
		{"project decisions", "DELETE FROM collection_projects WHERE user_id=$1 AND collection_id=$2"},
		{"organization runs", "DELETE FROM organization_runs WHERE user_id=$1 AND collection_id=$2"},
		{"attached uploads", `WITH removed AS (
			DELETE FROM attachments WHERE user_id=$1 AND collection_id=$2 RETURNING user_id,upload_id
		) DELETE FROM uploads u USING removed a WHERE (u.user_id,u.id)=(a.user_id,a.upload_id)`},
		{"cached collection responses", `DELETE FROM idempotency_keys WHERE user_id=$1 AND (
			(operation='POST /api/v1/collections' AND response_json->>'id'=$2::uuid::text)
			OR lower(operation) = 'triage_undo_receipt:' || $2::uuid::text
			OR (lower(operation) LIKE '% /api/v1/collections/' || $2::uuid::text || '/%'
			    AND lower(operation) <> 'post /api/v1/collections/' || $2::uuid::text || '/purge')
		)`},
		{"collection", "DELETE FROM collections WHERE user_id=$1 AND id=$2"},
	} {
		if _, err := tx.Exec(ctx, stmt.sql, row.UserID, row.CollectionID); err != nil {
			return fmt.Errorf("purge %s: %w", stmt.name, err)
		}
	}
	return nil
}
