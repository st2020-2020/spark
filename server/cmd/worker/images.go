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

func runImages() error {
	if os.Getenv("SPARK_IMAGE_ANALYSIS_ENABLED") != "true" {
		return errors.New("image worker requires SPARK_IMAGE_ANALYSIS_ENABLED=true")
	}
	env := os.Getenv("SPARK_ENV")
	if env == "" {
		env = "production"
	}
	if env != "production" && env != "development" {
		return errors.New("SPARK_ENV must be development or production")
	}
	adminID, err := backend.ImageAdminID(env, true)
	if err != nil {
		return err
	}
	storage, err := asset.Load(env)
	if err != nil {
		return err
	}
	if storage == nil {
		return errors.New("image worker requires SPARK_OSS_ENABLED=true")
	}
	model, err := backend.LoadImageModel(env)
	if err != nil {
		return err
	}
	defer model.Close()
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
	trial, err := backend.ParseAITrialScope(env, os.Getenv("SPARK_AI_TRIAL_USER_IDS"))
	if err != nil {
		return err
	}
	organizer, err := backend.NewOrganizer(pool, os.Getenv("SPARK_AI_ENABLED") == "true", trial)
	if err != nil {
		return err
	}
	organizer.Images = backend.ImageOrganizationScope{Enabled: true, AdminID: adminID}
	working, cancelWorking := context.WithCancel(context.Background())
	defer cancelWorking()
	worker, err := backend.StartImageWorker(working, pool, storage, model, adminID, organizer)
	if err != nil {
		return err
	}
	slog.Info("image worker started")
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}
