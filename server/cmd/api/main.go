package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/backend"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		slog.Error("API stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := backend.LoadConfig()
	if err != nil {
		return err
	}
	storage, err := asset.Load(cfg.Env)
	if err != nil {
		return err
	}
	connect, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pool, err := backend.OpenPool(connect, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err = db.Ready(connect, pool); err != nil {
		return err
	}
	app, err := backend.New(connect, cfg, pool)
	if err != nil {
		return err
	}
	if storage != nil {
		app.Assets = storage
	}
	eventsDone := make(chan struct{})
	go func() { defer close(eventsDone); app.RunOrganizationEvents(ctx) }()
	defer func() { stop(); <-eventsDone }()
	srv := &http.Server{Addr: cfg.Addr, Handler: app.Router(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	done := make(chan error, 1)
	go func() { done <- srv.ListenAndServe() }()
	slog.Info("API listening", "addr", cfg.Addr, "environment", cfg.Env, "mail_adapter", cfg.MailMode)
	select {
	case err = <-done:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}
