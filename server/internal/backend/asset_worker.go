package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/store"
)

const assetQueue = "attachments"

type verifyUploadArgs struct {
	UserID   string `json:"user_id"`
	UploadID string `json:"upload_id"`
}

func (verifyUploadArgs) Kind() string { return "spark_verify_upload" }

type cleanupUploadArgs struct {
	UserID   string `json:"user_id"`
	UploadID string `json:"upload_id"`
}

func (cleanupUploadArgs) Kind() string { return "spark_cleanup_upload" }

type assetJobs struct {
	pool    *pgxpool.Pool
	storage asset.Storage
}

type verifyUploadWorker struct {
	river.WorkerDefaults[verifyUploadArgs]
	*assetJobs
}

type cleanupUploadWorker struct {
	river.WorkerDefaults[cleanupUploadArgs]
	*assetJobs
}

func StartAssetWorker(ctx context.Context, pool *pgxpool.Pool, storage asset.Storage) (*river.Client[pgx.Tx], error) {
	if storage == nil {
		return nil, errors.New("asset worker requires SPARK_OSS_ENABLED=true")
	}
	common := &assetJobs{pool: pool, storage: storage}
	workers := river.NewWorkers()
	river.AddWorker(workers, &verifyUploadWorker{assetJobs: common})
	river.AddWorker(workers, &cleanupUploadWorker{assetJobs: common})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema: db.RiverSchema(pool), Workers: workers,
		Queues:            map[string]river.QueueConfig{assetQueue: {MaxWorkers: 2}},
		JobTimeout:        50 * time.Second,
		PollOnly:          true,
		FetchPollInterval: 200 * time.Millisecond,
		Logger:            slog.Default(),
	})
	if err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

// Serialize external verification and cleanup for one upload. The session
// lock also protects against a recovered duplicate while the old worker lives.
func (w *assetJobs) lockUpload(ctx context.Context, user, id string) (*pgxpool.Conn, func(), error) {
	conn, err := w.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 23))`, user+":"+id).Scan(&locked); err != nil {
		conn.Release()
		return nil, nil, err
	}
	if !locked {
		conn.Release()
		return nil, nil, river.JobSnooze(time.Second)
	}
	return conn, func() {
		defer conn.Release()
		unlock, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlock, `SELECT pg_advisory_unlock(hashtextextended($1, 23))`, user+":"+id); err != nil {
			_ = conn.Conn().Close(unlock)
		}
	}, nil
}

func (w *verifyUploadWorker) Work(ctx context.Context, job *river.Job[verifyUploadArgs]) error {
	args := job.Args
	conn, unlock, err := w.lockUpload(ctx, args.UserID, args.UploadID)
	if err != nil {
		return err
	}
	defer unlock()
	q := store.New(conn)
	row, err := q.GetUpload(ctx, store.GetUploadParams{UserID: idPG(args.UserID), ID: idPG(args.UploadID)})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.Status != "verifying" || !row.ExpiresAt.Time.After(time.Now()) {
		return nil
	}

	var checksum []byte
	var rejection string
	body, version, err := w.storage.OpenFinal(ctx, row.StagingKey, row.FinalKey.String, row.MimeType, row.DeclaredSize)
	switch {
	case errors.Is(err, asset.ErrObjectMissing):
		rejection = "upload_missing"
	case errors.Is(err, asset.ErrSizeMismatch):
		rejection = "upload_size_mismatch"
	case err == nil:
		checksum, rejection, err = verifyImage(body, row.DeclaredSize, row.MimeType)
		body.Close()
		if err != nil {
			// An SDK transport error can include a signed URL or object path.
			err = errors.New("read verified OSS object body failed")
		}
	}
	if err != nil && rejection == "" {
		if job.Attempt < job.MaxAttempts {
			return err
		}
		rejection = "upload_verification_failed"
	}
	// Preserve the terminal result even after a job execution timeout.
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if rejection != "" {
		_, err := q.RejectUpload(finish, store.RejectUploadParams{
			UserID: row.UserID, ID: row.ID, ErrorCode: pgtype.Text{String: rejection, Valid: true},
		})
		return err
	}
	_, err = q.FinishUploadVerification(finish, store.FinishUploadVerificationParams{
		UserID: row.UserID, ID: row.ID, FinalKey: row.FinalKey.String,
		ActualSize: row.DeclaredSize, Sha256: checksum,
		ProviderVersion: pgtype.Text{String: version, Valid: version != ""},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func (w *cleanupUploadWorker) Work(ctx context.Context, job *river.Job[cleanupUploadArgs]) error {
	args := job.Args
	conn, unlock, err := w.lockUpload(ctx, args.UserID, args.UploadID)
	if err != nil {
		return err
	}
	defer unlock()
	q := store.New(conn)
	params := store.GetUploadParams{UserID: idPG(args.UserID), ID: idPG(args.UploadID)}
	row, err := q.GetUpload(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if until := time.Until(row.ExpiresAt.Time); until > 0 {
		return river.JobSnooze(until)
	}
	if row.Status != "attached" {
		row, err = q.ExpireUpload(ctx, store.ExpireUploadParams{UserID: params.UserID, ID: params.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			// A collection may have acquired the upload before expiry.
			return river.JobSnooze(time.Second)
		}
		if err != nil {
			return err
		}
	}
	// Every PUT grant has expired by now, including grants from a replay.
	if !row.StagingCleanedAt.Valid {
		if err := w.storage.Delete(ctx, row.StagingKey, ""); err != nil {
			return fmt.Errorf("clean staging upload: %w", err)
		}
		if err := q.MarkUploadStagingCleaned(ctx, store.MarkUploadStagingCleanedParams{
			UserID: row.UserID, ID: row.ID,
		}); err != nil {
			return err
		}
	}
	if row.Status == "attached" {
		return nil
	}
	if row.FinalKey.Valid {
		if err := w.storage.Delete(ctx, row.FinalKey.String, row.ProviderVersion.String); err != nil {
			return fmt.Errorf("clean unused final object: %w", err)
		}
	}
	_, err = q.DeleteExpiredUpload(ctx, store.DeleteExpiredUploadParams{UserID: row.UserID, ID: row.ID})
	return err
}
