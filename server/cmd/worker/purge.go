package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/backend"
	"spark/server/internal/purgearchive"
)

func runPurge() error {
	if os.Getenv("SPARK_PURGE_ENABLED") != "true" {
		return errors.New("purge worker requires SPARK_PURGE_ENABLED=true")
	}
	archive, err := purgearchive.Open(os.Getenv("SPARK_DELETION_LEDGER_DIR"))
	if err != nil {
		return err
	}
	defer archive.Close()
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
	worker, err := backend.StartPurgeWorker(working, pool, archive, objects)
	if err != nil {
		return err
	}
	slog.Info("collection purge worker started")
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}
