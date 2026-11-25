package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/backend"
	"spark/server/internal/purgearchive"
)

func runPurge() error {
	if os.Getenv("SPARK_PURGE_ENABLED") != "true" {
		return errors.New("purge worker requires SPARK_PURGE_ENABLED=true")
	}
	expiryStart, err := purgeExpiryStart(os.Getenv("SPARK_PURGE_EXPIRY_START_AT"))
	if err != nil {
		return err
	}
	env := os.Getenv("SPARK_ENV")
	if env == "" {
		env = "production"
	}
	if env != "production" && env != "development" {
		return errors.New("SPARK_ENV must be development or production")
	}
	storage, err := asset.Load(env)
	if err != nil {
		return err
	}
	var objects asset.Storage
	if storage != nil {
		objects = storage
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	connect, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	archive, err := purgearchive.OpenConfigured(connect)
	if err != nil {
		return err
	}
	defer archive.Close()
	if ledger, ok := archive.(*purgearchive.OSS); ok && storage != nil && ledger.Location().ObjectPrefix != storage.Prefix {
		return errors.New("deletion ledger object_prefix must match the attachment OSS prefix")
	}
	pool, err := backend.OpenPool(connect, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = db.Ready(connect, pool); err != nil {
		return errors.New("purge worker database schema is not ready; run explicit migrations")
	}
	working, cancelWorking := context.WithCancel(context.Background())
	defer cancelWorking()
	worker, err := backend.StartPurgeWorker(working, pool, archive, objects, expiryStart)
	if err != nil {
		return err
	}
	slog.Info("collection purge worker started")
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}

func purgeExpiryStart(raw string) (pgtype.Timestamptz, error) {
	if raw == "" {
		return pgtype.Timestamptz{}, nil
	}
	const utcTimestamp = "2006-01-02T15:04:05Z"
	start, err := time.Parse(utcTimestamp, raw)
	if err != nil || start.Format(utcTimestamp) != raw {
		return pgtype.Timestamptz{}, errors.New("SPARK_PURGE_EXPIRY_START_AT must be a UTC timestamp in YYYY-MM-DDTHH:MM:SSZ format")
	}
	return pgtype.Timestamptz{Time: start.UTC(), Valid: true}, nil
}
