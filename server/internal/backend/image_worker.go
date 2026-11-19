package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/store"
)

// ImageObjectReader can only open a known final object and version.
type ImageObjectReader interface {
	ReadFinal(context.Context, string, string, int64) (io.ReadCloser, error)
}

type imageWorker struct {
	river.WorkerDefaults[imageAnalysisArgs]
	pool    *pgxpool.Pool
	storage ImageObjectReader
	model   *ImageModel
	// Serialize the memory-intensive decode while allowing overlapping HTTP jobs.
	visualCopySlot chan struct{}
}

func StartImageWorker(ctx context.Context, pool *pgxpool.Pool, storage ImageObjectReader, model *ImageModel) (*river.Client[pgx.Tx], error) {
	if storage == nil || model == nil {
		return nil, errors.New("image analysis requires private object storage and a provider")
	}
	workers := river.NewWorkers()
	river.AddWorker(workers, &imageWorker{pool: pool, storage: storage, model: model, visualCopySlot: make(chan struct{}, 1)})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema: db.RiverSchema(pool), Workers: workers,
		Queues:     map[string]river.QueueConfig{imageAnalysisQueue: {MaxWorkers: 2}},
		JobTimeout: 35 * time.Second, PollOnly: true, FetchPollInterval: 200 * time.Millisecond,
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

type imageJob struct {
	Status, Key, Version, MIME string
	Size                       int64
	SHA                        []byte
	Eligible                   bool
}

func loadImageJob(ctx context.Context, q querier, args imageAnalysisArgs) (imageJob, error) {
	var job imageJob
	err := q.QueryRow(ctx, `SELECT e.status,a.object_key,coalesce(a.provider_version,''),a.mime_type,a.size_bytes,a.sha256,
		coalesce(u.status='active' AND u.image_consent_version=$5
		 AND u.image_policy_version=e.image_user_policy_version AND c.ai_policy_version=e.image_collection_policy_version
		 AND NOT c.ai_excluded AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND a.removed_at IS NULL,false)
		FROM extractions e JOIN users u ON u.id=e.user_id
		JOIN collections c ON (c.user_id,c.id)=(e.user_id,e.collection_id)
		JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(e.user_id,e.collection_id,e.attachment_id)
		WHERE e.user_id=$1 AND e.collection_id=$2 AND e.id=$3 AND e.source_kind='image'
		  AND e.extractor_version=$4 AND e.image_user_policy_version IS NOT NULL`,
		args.UserID, args.CollectionID, args.ExtractionID, imageExtractorVersion, imageConsentVersion).
		Scan(&job.Status, &job.Key, &job.Version, &job.MIME, &job.Size, &job.SHA, &job.Eligible)
	return job, err
}

func (w *imageWorker) Work(ctx context.Context, delivery *river.Job[imageAnalysisArgs]) error {
	args := delivery.Args
	conn, err := w.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,$2))`, args.ExtractionID, imageJobLockSalt).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return river.JobSnooze(time.Second)
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlock, `SELECT pg_advisory_unlock(hashtextextended($1,$2))`, args.ExtractionID, imageJobLockSalt); err != nil {
			_ = conn.Conn().Close(unlock)
		}
	}()

	job, err := loadImageJob(ctx, conn, args)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	switch job.Status {
	case "running":
		// A previous worker reached dispatch. Its reservation started
		// uncertain, so a redelivery cannot send or release it.
		return finishUndispatchedImage(ctx, conn, args, "running", "failed", "usage_uncertain")
	case "queued":
	default:
		return nil
	}
	if !job.Eligible {
		return finishUndispatchedImage(ctx, conn, args, "queued", "skipped", "image_authorization_changed")
	}
	objectCtx, cancelObject := context.WithTimeout(ctx, 10*time.Second)
	data, err := readImageObject(objectCtx, w.storage, job)
	cancelObject()
	if err != nil {
		if !errors.Is(err, asset.ErrSizeMismatch) && !errors.Is(err, asset.ErrObjectMissing) && delivery.Attempt < delivery.MaxAttempts {
			return errors.New("could not read confirmed image")
		}
		return finishUndispatchedImage(ctx, conn, args, "queued", "failed", "image_unavailable")
	}
	select {
	case w.visualCopySlot <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	visual, mime, err := visualCopy(data, job.MIME)
	<-w.visualCopySlot
	if err != nil {
		return finishUndispatchedImage(ctx, conn, args, "queued", "failed", "image_unavailable")
	}
	payload, err := buildImageRequest(visual, mime)
	if err != nil {
		return finishUndispatchedImage(ctx, conn, args, "queued", "blocked", "image_token_limit")
	}
	reservation, err := beginImageDispatch(ctx, conn, args)
	if err != nil || reservation == "" {
		return err
	}
	result := w.model.analyze(ctx, payload)

	// Provider cancellation may happen after dispatch. Keep a separate
	// settlement window so shutdown does not turn a billable call into a retry.
	settle, cancelSettle := context.WithTimeout(context.WithoutCancel(ctx), 8*time.Second)
	defer cancelSettle()
	return pgx.BeginFunc(settle, conn, func(tx pgx.Tx) error {
		if _, err := store.New(tx).LockUserChanges(settle, idPG(args.UserID)); err != nil {
			return err
		}
		if err := settleBudget(settle, tx, args.UserID, reservation, imageAccountingRoute, result.Account, "uncertain"); err != nil {
			return err
		}
		if result.OverLimit {
			if _, err := tx.Exec(settle, `INSERT INTO ai_route_failures(config_version,route,error_code)
				VALUES($1,$2,'image_token_limit') ON CONFLICT DO NOTHING`, imageExtractorVersion, imageAccountingRoute.Name); err != nil {
				return err
			}
		}
		current, err := loadImageJob(settle, tx, args)
		if err != nil {
			return err
		}
		if !current.Eligible {
			result = imageModelResult{Status: "skipped", Account: ModelOutput{ErrorCode: "image_authorization_changed"}}
		}
		return writeImageResult(settle, tx, args, "running", result)
	})
}

func readImageObject(ctx context.Context, storage ImageObjectReader, job imageJob) ([]byte, error) {
	body, err := storage.ReadFinal(ctx, job.Key, job.Version, job.Size)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, maxImageBytes+1))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if len(data) > maxImageBytes || int64(len(data)) != job.Size || !bytes.Equal(sum[:], job.SHA) {
		return nil, asset.ErrSizeMismatch
	}
	return data, nil
}

func beginImageDispatch(ctx context.Context, conn *pgxpool.Conn, args imageAnalysisArgs) (string, error) {
	var reservation string
	err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := store.New(tx).LockUserChanges(ctx, idPG(args.UserID)); err != nil {
			return err
		}
		job, err := loadImageJob(ctx, tx, args)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil || job.Status != "queued" {
			return err
		}
		if !job.Eligible {
			return writeImageResult(ctx, tx, args, "queued", imageModelResult{Status: "skipped", Account: ModelOutput{ErrorCode: "image_authorization_changed"}})
		}
		var costLimitViolated bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ai_route_failures WHERE config_version=$1 AND route=$2)`,
			imageExtractorVersion, imageAccountingRoute.Name).Scan(&costLimitViolated); err != nil {
			return err
		}
		if costLimitViolated {
			return writeImageResult(ctx, tx, args, "queued", imageModelResult{Status: "blocked", Account: ModelOutput{ErrorCode: "image_token_limit"}})
		}
		day, err := budgetDayWithCapacity(ctx, tx, args.UserID, imageReservationUnits)
		if err != nil {
			return err
		}
		if day == "" {
			return writeImageResult(ctx, tx, args, "queued", imageModelResult{Status: "blocked", Account: ModelOutput{ErrorCode: "quota_exceeded"}})
		}
		// Commit the one-shot dispatch marker and budget before opening the
		// provider connection. A missing settlement keeps the budget held.
		reservation = uuid.NewString()
		if _, err := tx.Exec(ctx, `INSERT INTO usage_reservations
			(id,user_id,image_extraction_id,attempt_no,budget_day,route,config_version,model,reserved_units,state,error_code)
			VALUES($1,$2,$3,1,$4::date,$5,$6,$7,$8,'uncertain','usage_uncertain')`,
			reservation, args.UserID, args.ExtractionID, day, imageAccountingRoute.Name, imageExtractorVersion,
			imageAccountingRoute.Model, imageReservationUnits); err != nil {
			return err
		}
		if err := addBudgetReservation(ctx, tx, args.UserID, day, imageReservationUnits); err != nil {
			return err
		}
		return writeImageResult(ctx, tx, args, "queued", imageModelResult{Status: "running"})
	})
	return reservation, err
}

func finishUndispatchedImage(ctx context.Context, conn *pgxpool.Conn, args imageAnalysisArgs, expected, status, code string) error {
	return writeImageResult(ctx, conn, args, expected, imageModelResult{Status: status, Account: ModelOutput{ErrorCode: code}})
}

func writeImageResult(ctx context.Context, q store.DBTX, args imageAnalysisArgs, expected string, result imageModelResult) error {
	_, err := q.Exec(ctx, `UPDATE extractions SET status=$5,text=NULLIF($6,''),evidence_meta=$7,
		error_code=NULLIF($8,''),updated_at=now() WHERE user_id=$1 AND collection_id=$2 AND id=$3 AND status=$4`,
		args.UserID, args.CollectionID, args.ExtractionID, expected,
		result.Status, result.Text, jsonBytes(result.Evidence), result.Account.ErrorCode)
	return err
}
