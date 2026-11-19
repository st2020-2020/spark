package backend

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/purgearchive"
	"spark/server/internal/store"
)

// ReplayDeletions applies the independent receipts to an offline restored
// database. The worker then removes objects from the corresponding restored
// storage even when an older database backup marked cleanup complete.
func ReplayDeletions(ctx context.Context, pool *pgxpool.Pool, archive *purgearchive.Archive) (int, error) {
	queue, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Schema: db.RiverSchema(pool)})
	if err != nil {
		return 0, err
	}
	count := 0
	err = archive.Each(ctx, func(receipt purgearchive.Receipt) error {
		step, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		applied := false
		err := pgx.BeginFunc(step, pool, func(tx pgx.Tx) error {
			var err error
			applied, err = replayDeletion(step, tx, queue, receipt)
			return err
		})
		if err == nil && applied {
			count++
		}
		return err
	})
	return count, err
}

func replayDeletion(ctx context.Context, tx pgx.Tx, queue *river.Client[pgx.Tx], receipt purgearchive.Receipt) (bool, error) {
	uid, cid := receipt.UserID.String(), receipt.CollectionID.String()
	params := deletionParams(uid, cid)
	q := store.New(tx)
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,31))`, uid+":"+cid).Scan(&locked); err != nil {
		return false, err
	}
	if !locked {
		return false, errors.New("a worker is processing this deletion")
	}
	var accountExists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)", params.UserID).Scan(&accountExists); err != nil {
		return false, err
	}
	if !accountExists {
		if len(receipt.Objects) != 0 {
			return false, errors.New("restored account is missing for a receipt with objects; keep recovery offline, verify the database and object backup pairing, and resolve the affected objects before reopening")
		}
		return false, nil
	}
	if _, err := q.LockUserChanges(ctx, params.UserID); err != nil {
		return false, err
	}
	keys := receiptKeys(receipt)
	if _, err := tx.Exec(ctx, `INSERT INTO deletion_ledger(id,user_id,collection_id,object_keys,requested_at)
		VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,collection_id) DO NOTHING`,
		idPG(receipt.OperationID.String()), params.UserID, params.CollectionID, jsonBytes(keys), receipt.RequestedAt); err != nil {
		return false, err
	}
	row, err := q.GetCollectionDeletion(ctx, params)
	if err != nil {
		return false, err
	}
	var storedKeys []string
	if err := json.Unmarshal(row.ObjectKeys, &storedKeys); err != nil {
		return false, errors.New("invalid stored deletion object list")
	}
	slices.Sort(storedKeys)
	if uuid.UUID(row.ID.Bytes) != receipt.OperationID || !row.RequestedAt.Time.Equal(receipt.RequestedAt) ||
		!slices.Equal(storedKeys, keys) {
		return false, errors.New("restored database conflicts with independent deletion receipt")
	}
	var unknownObjects bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM attachments a JOIN uploads u ON (a.user_id,a.upload_id)=(u.user_id,u.id)
		WHERE a.user_id=$1 AND a.collection_id=$2 AND
		 (NOT a.object_key = ANY($3::text[]) OR NOT u.staging_key = ANY($3::text[]))
	)`, params.UserID, params.CollectionID, keys).Scan(&unknownObjects); err != nil {
		return false, err
	}
	if unknownObjects {
		return false, errors.New("restored attachments exceed the independent deletion receipt")
	}

	var version int64
	err = tx.QueryRow(ctx, `UPDATE collections SET
		deleted_at=COALESCE(deleted_at,now()),purge_after=COALESCE(purge_after,now()),purge_requested_at=$3,
		resource_version=resource_version+1,ai_policy_version=ai_policy_version+1,updated_at=now()
		WHERE user_id=$1 AND id=$2 AND purge_requested_at IS NULL RETURNING resource_version`,
		params.UserID, params.CollectionID, receipt.RequestedAt).Scan(&version)
	if err == nil {
		if err := q.RecordChange(ctx, store.RecordChangeParams{UserID: params.UserID, ResourceType: "collection",
			ResourceID: params.CollectionID, ResourceVersion: version, Action: "delete"}); err != nil {
			return false, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if err := purgeDatabase(ctx, tx, row); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE deletion_ledger SET object_cursor=0,completed_at=NULL,
		replicated_at=COALESCE(replicated_at,GREATEST(now(),requested_at))
		WHERE user_id=$1 AND id=$2`, row.UserID, row.ID); err != nil {
		return false, err
	}
	return true, queuePurge(ctx, tx, queue, uid, cid)
}
