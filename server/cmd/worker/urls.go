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
	"spark/server/internal/backend"
)

func runURLs() error {
	if os.Getenv("SPARK_URL_EXTRACT_ENABLED") != "true" {
		return errors.New("URL worker requires SPARK_URL_EXTRACT_ENABLED=true")
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
	worker, err := backend.StartURLWorker(working, pool)
	if err != nil {
		return err
	}
	slog.Info("URL extraction worker started")
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}
