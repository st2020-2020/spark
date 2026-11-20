package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"spark/server/db"
	"spark/server/internal/backend"
)

func runMail() error {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("SPARK_ENCRYPTION_KEY"))
	if err != nil || len(key) != 32 {
		return errors.New("mail worker requires a base64 encoded 32-byte SPARK_ENCRYPTION_KEY")
	}
	mode := os.Getenv("SPARK_MAIL_MODE")
	sender, err := backend.LoadMailDelivery(mode)
	if err != nil {
		return err
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
		return errors.New("mail worker database schema is not ready; run explicit migrations")
	}
	working, cancelWorking := context.WithCancel(context.Background())
	defer cancelWorking()
	worker, err := backend.StartMailWorker(working, pool, key, sender)
	if err != nil {
		return err
	}
	slog.Info("mail worker started", "mail_adapter", mode)
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}
