package backend

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
	"spark/server/db"
)

func queueUploadCleanup(ctx context.Context, tx pgx.Tx, queue *river.Client[pgx.Tx], args cleanupUploadArgs, when time.Time) (*rivertype.JobInsertResult, error) {
	return queue.InsertTx(ctx, tx, args, &river.InsertOpts{
		Queue: assetQueue, ScheduledAt: when, MaxAttempts: 8,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRunning,
			rivertype.JobStateRetryable, rivertype.JobStateScheduled,
		}},
	})
}

// RequeueUploadCleanup gives a bounded batch of unfinished uploads a fresh
// attempt after an operator has recovered the storage service. It only uses
// PostgreSQL; the asset worker performs all object operations.
func RequeueUploadCleanup(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	queue, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Schema: db.RiverSchema(pool)})
	if err != nil {
		return 0, err
	}
	count := 0
	err = pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// Include jobs created before uniqueness was enabled. Lock candidates
		// so simultaneous operator calls can claim separate batches.
		rows, err := tx.Query(ctx, `SELECT u.user_id::text,u.id::text FROM uploads u
			WHERE u.expires_at<=now() AND (u.status<>'attached' OR u.staging_cleaned_at IS NULL)
			  AND NOT EXISTS (
			    SELECT 1 FROM river_job j WHERE j.queue='attachments' AND j.kind='spark_cleanup_upload'
			      AND j.state IN ('available','pending','running','retryable','scheduled')
			      AND j.args @> jsonb_build_object('user_id',u.user_id::text,'upload_id',u.id::text)
			  )
			ORDER BY u.expires_at,u.id LIMIT 50 FOR UPDATE OF u SKIP LOCKED`)
		if err != nil {
			return err
		}
		uploads, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (cleanupUploadArgs, error) {
			var args cleanupUploadArgs
			err := row.Scan(&args.UserID, &args.UploadID)
			return args, err
		})
		if err != nil {
			return err
		}
		for _, upload := range uploads {
			result, err := queueUploadCleanup(ctx, tx, queue, upload, time.Time{})
			if err != nil {
				return err
			}
			if !result.UniqueSkippedAsDuplicate {
				count++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}
