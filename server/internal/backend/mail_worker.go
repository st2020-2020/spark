package backend

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
)

const (
	mailModeSMTP = "smtp"
	mailModeSES  = "tencent-ses"
)

func isMailDeliveryMode(mode string) bool {
	return mode == mailModeSMTP || mode == mailModeSES
}

type MailDelivery interface {
	adapter() string
	deliver(context.Context, challengeMail, func(context.Context) (bool, error)) mailDeliveryResult
}

func LoadMailDelivery(mode string) (MailDelivery, error) {
	switch mode {
	case mailModeSMTP:
		return LoadSMTPDelivery()
	case mailModeSES:
		return loadTencentSESDelivery(nil)
	default:
		return nil, errors.New("mail worker requires SPARK_MAIL_MODE=smtp or tencent-ses")
	}
}

type mailWorker struct {
	river.WorkerDefaults[mailJobArgs]
	pool   *pgxpool.Pool
	key    []byte
	sender MailDelivery
}

func StartMailWorker(ctx context.Context, pool *pgxpool.Pool, key []byte, sender MailDelivery) (*river.Client[pgx.Tx], error) {
	if len(key) != 32 || sender == nil {
		return nil, errors.New("mail worker requires a delivery adapter and the shared encryption key")
	}
	workers := river.NewWorkers()
	river.AddWorker(workers, &mailWorker{pool: pool, key: key, sender: sender})
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema: db.RiverSchema(pool), Workers: workers,
		Queues:     map[string]river.QueueConfig{mailQueue: {MaxWorkers: 1}},
		JobTimeout: 25 * time.Second, PollOnly: true, FetchPollInterval: time.Second,
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

func (w *mailWorker) NextRetry(job *river.Job[mailJobArgs]) time.Time {
	if job.Attempt <= 1 {
		return time.Now().Add(20 * time.Second)
	}
	return time.Now().Add(time.Minute)
}

func (w *mailWorker) Work(ctx context.Context, job *river.Job[mailJobArgs]) error {
	id, err := uuid.Parse(job.Args.ChallengeID)
	if err != nil {
		return river.JobCancel(errors.New("invalid mail challenge reference"))
	}
	conn, err := w.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 53))`, id.String()).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return river.JobSnooze(time.Second)
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlock, `SELECT pg_advisory_unlock(hashtextextended($1, 53))`, id.String()); err != nil {
			_ = conn.Conn().Close(unlock)
		}
	}()
	attempt, err := claimMail(ctx, conn, id)
	if err != nil || attempt.ciphertext == nil {
		return err
	}

	result := w.deliver(ctx, conn, id, attempt)
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if result.state == "retry" {
		if job.Attempt < job.MaxAttempts && attempt.expires.After(w.NextRetry(job).Add(mailMinimumLife)) {
			var stillQueued bool
			if err := conn.QueryRow(finish, `WITH live AS (
				SELECT EXISTS (SELECT FROM email_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()) AS active
			)
			UPDATE mail_outbox SET
				delivery_state=CASE WHEN live.active THEN 'queued' ELSE 'cancelled' END,
				encrypted_payload=CASE WHEN live.active THEN $2::bytea ELSE NULL END
			FROM live WHERE challenge_id=$1 AND delivery_state='uncertain'
			RETURNING live.active`, id, attempt.ciphertext).Scan(&stillQueued); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil
				}
				return err
			}
			if stillQueued {
				return errors.New(result.reason)
			}
			return nil
		}
		result.state = "failed"
	}
	if result.reason != "" {
		slog.Warn("mail delivery ended", "challenge_id", id, "state", result.state, "reason", result.reason)
	}
	_, err = conn.Exec(finish, `UPDATE mail_outbox
		SET delivery_state=$2,delivered_at=CASE WHEN $2='accepted' THEN clock_timestamp() ELSE NULL END
		WHERE challenge_id=$1 AND delivery_state='uncertain'`, id, result.state)
	return err
}

type mailAttempt struct {
	ciphertext  []byte
	to, purpose string
	expires     time.Time
}

func claimMail(ctx context.Context, conn *pgxpool.Conn, id uuid.UUID) (mailAttempt, error) {
	var a mailAttempt
	// Take the ciphertext out of the database before contacting the delivery service. If
	// the worker crashes, the durable uncertain row cannot be sent again.
	err := conn.QueryRow(ctx, `WITH candidate AS (
		SELECT o.challenge_id,o.encrypted_payload,c.email_normalized,c.purpose,LEAST(c.expires_at,o.expires_at) AS expiry
		FROM mail_outbox o JOIN email_challenges c ON c.id=o.challenge_id
		WHERE o.challenge_id=$1 AND o.delivery_state='queued' AND o.encrypted_payload IS NOT NULL
		  AND c.consumed_at IS NULL AND LEAST(c.expires_at,o.expires_at)>clock_timestamp()+$2::int*interval '1 second'
		FOR UPDATE OF o
	)
	UPDATE mail_outbox o SET delivery_state='uncertain',encrypted_payload=NULL
	FROM candidate c WHERE o.challenge_id=c.challenge_id
	RETURNING c.encrypted_payload,c.email_normalized,c.purpose,c.expiry`,
		id, int(mailMinimumLife/time.Second)).Scan(&a.ciphertext, &a.to, &a.purpose, &a.expires)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = conn.Exec(ctx, `UPDATE mail_outbox SET delivery_state='cancelled',encrypted_payload=NULL
			WHERE challenge_id=$1 AND delivery_state='queued'`, id)
	}
	return a, err
}

func (w *mailWorker) deliver(ctx context.Context, conn *pgxpool.Conn, id uuid.UUID, a mailAttempt) mailDeliveryResult {
	payload, err := openEncryptedPayload(w.key, "mail:"+id.String(), a.ciphertext)
	if err != nil {
		return mailDeliveryResult{"failed", "mail_payload_unreadable"}
	}
	defer clear(payload)
	var message challengeMail
	if err := json.Unmarshal(payload, &message); err != nil || message.ChallengeID != id.String() ||
		message.Email != a.to || message.Purpose != a.purpose {
		return mailDeliveryResult{"failed", "mail_payload_invalid"}
	}
	// A queued code belongs to its original channel, even after a mode change.
	if message.Adapter != w.sender.adapter() {
		return mailDeliveryResult{"cancelled", "mail_adapter_changed"}
	}
	ctx, cancel := context.WithDeadline(ctx, a.expires)
	defer cancel()
	return w.sender.deliver(ctx, message, func(ctx context.Context) (bool, error) {
		var valid bool
		err := conn.QueryRow(ctx, `SELECT EXISTS (
		 SELECT FROM mail_outbox o JOIN email_challenges c ON c.id=o.challenge_id
		 WHERE o.challenge_id=$1 AND o.delivery_state='uncertain' AND c.consumed_at IS NULL
		   AND LEAST(o.expires_at,c.expires_at)>clock_timestamp()
		)`, id).Scan(&valid)
		return valid, err
	})
}

// InvalidateRestoredMail runs before reopening an offline restored database.
// Logical backups can contain a still-valid code or a job that already sent.
func InvalidateRestoredMail(ctx context.Context, pool *pgxpool.Pool) (int64, int64, error) {
	var challenges, jobs int64
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		result, err := tx.Exec(ctx, `UPDATE email_challenges SET consumed_at=now() WHERE consumed_at IS NULL`)
		if err != nil {
			return err
		}
		challenges = result.RowsAffected()
		if _, err = tx.Exec(ctx, `UPDATE mail_outbox SET encrypted_payload=NULL,
			delivery_state=CASE WHEN delivery_state IN ('queued','development') THEN 'cancelled' ELSE delivery_state END
			WHERE encrypted_payload IS NOT NULL OR delivery_state='queued'`); err != nil {
			return err
		}
		// No producer or worker is running on the restored database. Mark
		// even previously running mail jobs terminal so rescue cannot replay.
		jobTable := pgx.Identifier{db.RiverSchema(pool), "river_job"}.Sanitize()
		result, err = tx.Exec(ctx, `UPDATE `+jobTable+` SET state='cancelled',finalized_at=now()
			WHERE queue=$1 AND kind=$2 AND state IN ('available','pending','running','retryable','scheduled')`,
			mailQueue, (mailJobArgs{}).Kind())
		if err != nil {
			return err
		}
		jobs = result.RowsAffected()
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return challenges, jobs, nil
}
