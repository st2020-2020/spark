package backend

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"spark/server/internal/store"
)

const purgeSweepBatch = 50

type purgeSweepArgs struct {
	Day string `json:"day"`
}

func (purgeSweepArgs) Kind() string { return "spark_sweep_expired_collections" }

func schedulePurgeSweep(ctx context.Context, queue *river.Client[pgx.Tx], when time.Time) error {
	// Persist one sweep per UTC day. Each sweep schedules its successor
	// even when another River process is the database-wide leader.
	opts := &river.InsertOpts{Queue: purgeQueue, MaxAttempts: 8, UniqueOpts: river.UniqueOpts{ByArgs: true}}
	if when.After(time.Now()) {
		opts.ScheduledAt = when
	}
	_, err := queue.Insert(ctx, purgeSweepArgs{Day: when.UTC().Format(time.DateOnly)}, opts)
	return err
}

type purgeSweepWorker struct {
	river.WorkerDefaults[purgeSweepArgs]
	pool  *pgxpool.Pool
	queue *river.Client[pgx.Tx]
}

func (w *purgeSweepWorker) Work(ctx context.Context, _ *river.Job[purgeSweepArgs]) error {
	tomorrow := time.Now().UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
	if err := schedulePurgeSweep(ctx, w.queue, tomorrow); err != nil {
		return err
	}
	due, err := store.New(w.pool).ListDueCollectionsForPurge(ctx, purgeSweepBatch)
	if err != nil {
		return err
	}
	for _, item := range due {
		err := pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
			if _, err := store.New(tx).LockUserChanges(ctx, item.UserID); err != nil {
				return err
			}
			var version int64
			err := tx.QueryRow(ctx, `SELECT resource_version FROM collections
				WHERE user_id=$1 AND id=$2 AND deleted_at IS NOT NULL
				  AND purge_requested_at IS NULL AND purge_after<=now()`, item.UserID, item.ID).Scan(&version)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // A concurrent restore or purge won.
			}
			if err != nil {
				return err
			}
			_, err = registerPurge(ctx, tx, w.queue, uuid.UUID(item.UserID.Bytes).String(), uuid.UUID(item.ID.Bytes).String(), version)
			return err
		})
		if err != nil {
			return err
		}
	}
	recovered, err := w.requeueUnfinished(ctx)
	if err != nil {
		return err
	}
	if len(due) == purgeSweepBatch || recovered == purgeSweepBatch {
		return river.JobSnooze(time.Second)
	}
	return nil
}

func (w *purgeSweepWorker) requeueUnfinished(ctx context.Context) (int, error) {
	// Reconcile receipts whose earlier cleanup jobs exhausted retries. Active
	// or delayed jobs are excluded so a later receipt cannot be starved.
	rows, err := w.pool.Query(ctx, `SELECT d.user_id,d.collection_id
		FROM deletion_ledger d
		WHERE d.completed_at IS NULL AND NOT EXISTS (
		 SELECT 1 FROM river_job j WHERE j.queue='collection_purge' AND j.kind='spark_purge_collection'
		  AND j.args @> jsonb_build_object('user_id',d.user_id::text,'collection_id',d.collection_id::text)
		  AND j.state IN ('available','pending','running','retryable','scheduled')
		) ORDER BY d.requested_at,d.id LIMIT $1`, purgeSweepBatch)
	if err != nil {
		return 0, err
	}
	entries, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) ([2]pgtype.UUID, error) {
		var pair [2]pgtype.UUID
		err := row.Scan(&pair[0], &pair[1])
		return pair, err
	})
	if err != nil {
		return 0, err
	}
	for _, pair := range entries {
		err := pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
			return queuePurge(ctx, tx, w.queue, uuid.UUID(pair[0].Bytes).String(), uuid.UUID(pair[1].Bytes).String())
		})
		if err != nil {
			return 0, err
		}
	}
	return len(entries), nil
}
