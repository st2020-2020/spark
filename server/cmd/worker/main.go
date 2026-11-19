package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"spark/server/db"
	"spark/server/internal/backend"
)

func main() {
	if err := run(); err != nil {
		slog.Error("worker stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://127.0.0.1:9091/ready")
		if err != nil {
			return errors.New("worker is not ready")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return errors.New("worker is not ready")
		}
		return nil
	}
	if len(os.Args) == 2 && os.Args[1] == "assets" {
		return runAssets()
	}
	if len(os.Args) == 2 && os.Args[1] == "urls" {
		return runURLs()
	}
	if len(os.Args) == 2 && os.Args[1] == "images" {
		return runImages()
	}
	if len(os.Args) == 2 && os.Args[1] == "purge" {
		return runPurge()
	}
	if len(os.Args) != 1 {
		return errors.New("usage: spark-worker [assets|urls|images|purge|healthcheck]")
	}
	env := os.Getenv("SPARK_ENV")
	if env == "" {
		env = "production"
	}
	if env != "production" && env != "development" {
		return errors.New("SPARK_ENV must be development or production")
	}
	if env == "production" && os.Getenv("SPARK_AI_ENABLED") != "true" {
		return errors.New("production text worker requires SPARK_AI_ENABLED=true")
	}
	trial, err := backend.ParseAITrialScope(env, os.Getenv("SPARK_AI_TRIAL_USER_IDS"))
	if err != nil {
		return err
	}
	cfg, err := backend.LoadAIConfig(os.Getenv("SPARK_AI_CONFIG_FILE"), env)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	connect, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pcfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		return errors.New("invalid DATABASE_URL")
	}
	pcfg.MaxConns = 20
	pcfg.MinConns = 0
	pcfg.MaxConnLifetime = 30 * time.Minute
	pcfg.MaxConnIdleTime = 5 * time.Minute
	pcfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pcfg.ConnConfig.RuntimeParams["statement_timeout"] = "12000"
	pool, err := pgxpool.NewWithConfig(connect, pcfg)
	if err != nil {
		return errors.New("cannot create worker database pool")
	}
	defer pool.Close()
	if err = db.Ready(connect, pool); err != nil {
		return errors.New("worker database schema is not ready; run explicit migrations")
	}
	client := backend.NewTextClient()
	defer client.Close()
	// The working context is cancelled only after the graceful stop deadline,
	// allowing in-flight work to settle its budget before pool shutdown.
	working, cancelWorking := context.WithCancel(context.Background())
	defer cancelWorking()
	worker, err := backend.StartTextWorker(working, pool, cfg, trial, client)
	if err != nil {
		return err
	}
	slog.Info("text worker started", "config_version", cfg.Version, "route_count", len(cfg.Routes))
	return serveWorker(ctx, stop, cancelWorking, pool, worker)
}

func serveWorker(ctx context.Context, stop, cancelWorking context.CancelFunc, pool *pgxpool.Pool, worker *river.Client[pgx.Tx]) error {
	health := &http.Server{Addr: "127.0.0.1:9091", ReadHeaderTimeout: 2 * time.Second, WriteTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		check, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if r.URL.Path != "/ready" {
			http.NotFound(w, r)
			return
		}
		if ctx.Err() != nil || db.Ready(check, pool) != nil {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
	})}
	done := make(chan error, 1)
	go func() { done <- health.ListenAndServe() }()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-done:
		stop()
	}
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelShutdown()
	_ = health.Shutdown(shutdown)
	if err := worker.Stop(shutdown); err != nil {
		cancelWorking()
		forced, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(forced); err != nil {
			return errors.New("worker stop exceeded settlement deadline")
		}
	}
	if serveErr != nil && serveErr != http.ErrServerClosed {
		return errors.New("worker health listener stopped")
	}
	return nil
}
