package backend

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/store"
	"spark/server/internal/webextract"
)

type urlWorker struct {
	river.WorkerDefaults[urlExtractionArgs]
	pool   *pgxpool.Pool
	client webextract.Client
}

func StartURLWorker(ctx context.Context, pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) {
	return startURLWorker(ctx, pool, webextract.Client{})
}

func startURLWorker(ctx context.Context, pool *pgxpool.Pool, fetcher webextract.Client) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &urlWorker{pool: pool, client: fetcher})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema: db.RiverSchema(pool), Workers: workers,
		Queues:     map[string]river.QueueConfig{urlExtractionQueue: {MaxWorkers: 2}},
		JobTimeout: 15 * time.Second, PollOnly: true, FetchPollInterval: 200 * time.Millisecond,
		Logger: slog.Default(),
	})
	if err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

func (w *urlWorker) Work(ctx context.Context, job *river.Job[urlExtractionArgs]) error {
	args := job.Args
	row, err := w.begin(ctx, args)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	page, fetchErr := w.client.Fetch(ctx, row.SourceID)
	status, code := "succeeded", ""
	if fetchErr != nil {
		status = "failed"
		var failure *webextract.Failure
		if !errors.As(fetchErr, &failure) {
			return errors.New("unexpected web fetch error")
		}
		code = failure.Code
		if failure.Blocked {
			status = "blocked"
		}
		if failure.Retryable && job.Attempt < job.MaxAttempts {
			return failure
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	err = pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if _, err := q.LockUserChanges(ctx, row.UserID); err != nil {
			return err
		}
		// Recheck the active account after the network call. The update
		// itself compares the collection version and the attempt timestamp.
		if _, err := q.GetCurrentURLExtraction(ctx, store.GetCurrentURLExtractionParams{
			UserID: row.UserID, CollectionID: row.CollectionID, ExtractorVersion: urlExtractorVersion,
		}); err != nil {
			return err
		}
		_, err := updateURLExtraction(ctx, q, row, status, page, code)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func (w *urlWorker) begin(ctx context.Context, args urlExtractionArgs) (store.Extraction, error) {
	var result store.Extraction
	params := urlExtractionParams(args.UserID, args.CollectionID)
	err := pgx.BeginFunc(ctx, w.pool, func(tx pgx.Tx) error {
		q := store.New(tx)
		if _, err := q.LockUserChanges(ctx, params.UserID); err != nil {
			return err
		}
		row, err := q.GetCurrentURLExtraction(ctx, params)
		if err != nil {
			return err
		}
		if row.ID != idPG(args.ExtractionID) || (row.Status != "queued" && row.Status != "running") {
			return pgx.ErrNoRows
		}
		result, err = updateURLExtraction(ctx, q, row, "running", webextract.Page{}, "")
		return err
	})
	return result, err
}
