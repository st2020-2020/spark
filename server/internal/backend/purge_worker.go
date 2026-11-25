package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"spark/server/db"
	"spark/server/internal/purgearchive"
	"spark/server/internal/store"
)

type purgeObjectStore interface {
	Delete(context.Context, string, string) error
}

type purgeWorker struct {
	river.WorkerDefaults[purgeArgs]
	pool    *pgxpool.Pool
	archive *purgearchive.Archive
	objects purgeObjectStore
}

func StartPurgeWorker(ctx context.Context, pool *pgxpool.Pool, archive *purgearchive.Archive, objects purgeObjectStore, expiryStart pgtype.Timestamptz) (*river.Client[pgx.Tx], error) {
	if archive == nil {
		return nil, errors.New("purge worker requires an independent deletion ledger")
	}
	workers := river.NewWorkers()
	sweep := &purgeSweepWorker{pool: pool, expiryStart: expiryStart}
	river.AddWorker(workers, &purgeWorker{pool: pool, archive: archive, objects: objects})
	river.AddWorker(workers, sweep)
	client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema: db.RiverSchema(pool), Workers: workers,
		Queues:            map[string]river.QueueConfig{purgeQueue: {MaxWorkers: 2}},
		JobTimeout:        time.Minute,
		PollOnly:          true,
		FetchPollInterval: 200 * time.Millisecond,
		Logger:            slog.Default(),
	})
	if err != nil {
		return nil, err
	}
	sweep.queue = client
	if err := schedulePurgeSweep(ctx, client, time.Now()); err != nil {
		return nil, err
	}
	if err := client.Start(ctx); err != nil {
		return nil, err
	}
	return client, nil
}

func (w *purgeWorker) Work(ctx context.Context, job *river.Job[purgeArgs]) error {
	args := job.Args
	conn, err := w.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	lockKey := args.UserID + ":" + args.CollectionID
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1,31))`, lockKey).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return river.JobSnooze(time.Second)
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlock, `SELECT pg_advisory_unlock(hashtextextended($1,31))`, lockKey); err != nil {
			_ = conn.Conn().Close(unlock)
		}
	}()

	q := store.New(conn)
	row, err := q.GetCollectionDeletion(ctx, deletionParams(args.UserID, args.CollectionID))
	if errors.Is(err, pgx.ErrNoRows) || err == nil && row.CompletedAt.Valid {
		return nil
	}
	if err != nil {
		return err
	}
	receipt, err := durableReceipt(ctx, w.archive, conn, row)
	if err != nil {
		return err
	}
	if !row.ReplicatedAt.Valid {
		if _, err := q.MarkDeletionReplicated(ctx, store.MarkDeletionReplicatedParams{UserID: row.UserID, ID: row.ID}); err != nil {
			return err
		}
	}
	err = pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if _, err := store.New(tx).LockUserChanges(ctx, row.UserID); err != nil {
			return err
		}
		return purgeDatabase(ctx, tx, row)
	})
	if errors.Is(err, errPurgeAccountingBusy) {
		return river.JobSnooze(15 * time.Second)
	}
	if err != nil {
		return err
	}
	return w.eraseObjects(ctx, conn, row, receipt)
}

func (w *purgeWorker) eraseObjects(ctx context.Context, conn *pgxpool.Conn, row store.DeletionLedger, receipt purgearchive.Receipt) error {
	cursor := int(row.ObjectCursor)
	if cursor > len(receipt.Objects) {
		return errors.New("deletion progress exceeds independent receipt")
	}
	for end := min(cursor+3, len(receipt.Objects)); cursor < end; cursor++ {
		object := receipt.Objects[cursor]
		if object.NotBefore != nil {
			if wait := time.Until(*object.NotBefore); wait > 0 {
				// A previously signed staging PUT may still be in flight.
				return river.JobSnooze(wait)
			}
		}
		if w.objects == nil {
			return errors.New("object cleanup requires configured object storage")
		}
		if err := w.objects.Delete(ctx, object.Key, object.Version); err != nil {
			return errors.New("collection object removal failed")
		}
		if _, err := conn.Exec(ctx, `UPDATE deletion_ledger SET object_cursor=$3
			WHERE user_id=$1 AND id=$2`, row.UserID, row.ID, cursor+1); err != nil {
			return err
		}
	}
	if cursor < len(receipt.Objects) {
		return river.JobSnooze(time.Second)
	}
	updated, err := store.New(conn).MarkDeletionCompleted(ctx, store.MarkDeletionCompletedParams{UserID: row.UserID, ID: row.ID})
	if err == nil && updated != 1 {
		return errors.New("deletion completion preconditions are unmet")
	}
	return err
}

func durableReceipt(ctx context.Context, archive *purgearchive.Archive, conn *pgxpool.Conn, row store.DeletionLedger) (purgearchive.Receipt, error) {
	var keys []string
	if err := json.Unmarshal(row.ObjectKeys, &keys); err != nil {
		return purgearchive.Receipt{}, errors.New("invalid deletion object list")
	}
	slices.Sort(keys)
	receipt, err := archive.Read(uuid.UUID(row.ID.Bytes))
	if errors.Is(err, os.ErrNotExist) && !row.ReplicatedAt.Valid {
		receipt, err = buildReceipt(ctx, conn, row, keys)
		if err != nil {
			return receipt, err
		}
		if err := archive.Put(receipt); err != nil {
			return receipt, fmt.Errorf("replicate deletion receipt: %w", err)
		}
		return receipt, nil
	}
	if err != nil {
		return receipt, fmt.Errorf("read independent deletion receipt: %w", err)
	}
	if receipt.UserID != uuid.UUID(row.UserID.Bytes) || receipt.CollectionID != uuid.UUID(row.CollectionID.Bytes) ||
		!receipt.RequestedAt.Equal(row.RequestedAt.Time) || !slices.Equal(receiptKeys(receipt), keys) {
		return receipt, errors.New("independent deletion receipt does not match the database")
	}
	if !row.ReplicatedAt.Valid {
		// A previous process may have linked the receipt before syncing the directory.
		return receipt, archive.Sync()
	}
	return receipt, nil
}

func buildReceipt(ctx context.Context, conn *pgxpool.Conn, row store.DeletionLedger, keys []string) (purgearchive.Receipt, error) {
	receipt := purgearchive.Receipt{
		SchemaVersion: 1, OperationID: uuid.UUID(row.ID.Bytes), UserID: uuid.UUID(row.UserID.Bytes),
		CollectionID: uuid.UUID(row.CollectionID.Bytes), RequestedAt: row.RequestedAt.Time.UTC(),
		Objects: make([]purgearchive.Object, 0, len(keys)),
	}
	rows, err := conn.Query(ctx, `SELECT u.staging_key,u.expires_at,a.object_key,a.provider_version
		FROM attachments a JOIN uploads u ON (a.user_id,a.upload_id)=(u.user_id,u.id)
		WHERE a.user_id=$1 AND a.collection_id=$2`, row.UserID, row.CollectionID)
	if err != nil {
		return receipt, err
	}
	defer rows.Close()
	objects := make(map[string]purgearchive.Object, len(keys))
	for rows.Next() {
		var staging, final string
		var version pgtype.Text
		var expires time.Time
		if err := rows.Scan(&staging, &expires, &final, &version); err != nil {
			return receipt, err
		}
		notBefore := expires.UTC()
		objects[staging] = purgearchive.Object{Key: staging, NotBefore: &notBefore}
		objects[final] = purgearchive.Object{Key: final, Version: version.String}
	}
	if err := rows.Err(); err != nil {
		return receipt, err
	}
	for _, key := range keys {
		object, ok := objects[key]
		if !ok {
			// Earlier ledger rows may predate the staging timestamp in the
			// replica. The request time plus the upload lifetime is a safe bound.
			object.Key = key
			if path.Base(path.Dir(key)) == "uploads" {
				notBefore := receipt.RequestedAt.Add(uploadRetention)
				object.NotBefore = &notBefore
			}
		}
		receipt.Objects = append(receipt.Objects, object)
	}
	slices.SortFunc(receipt.Objects, func(a, b purgearchive.Object) int {
		var first, second time.Time
		if a.NotBefore != nil {
			first = *a.NotBefore
		}
		if b.NotBefore != nil {
			second = *b.NotBefore
		}
		if order := first.Compare(second); order != 0 {
			return order
		}
		return strings.Compare(a.Key, b.Key)
	})
	return receipt, nil
}

func receiptKeys(receipt purgearchive.Receipt) []string {
	keys := make([]string, 0, len(receipt.Objects))
	for _, object := range receipt.Objects {
		keys = append(keys, object.Key)
	}
	slices.Sort(keys)
	return keys
}
