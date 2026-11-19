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
)

func runAssets() error {
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
	if storage == nil {
		return errors.New("asset worker requires SPARK_OSS_ENABLED=true")
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
		return errors.New("worker database schema is not ready; run explicit migrations")
	}
	working, cancelWorking := context.WithCancel(context.Background())
	defer cancelWorking()
	worker, err := backend.StartAssetWorker(working, pool, storage)
	if err != nil {
		return err
	}
	slog.Info("asset worker started")
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}
