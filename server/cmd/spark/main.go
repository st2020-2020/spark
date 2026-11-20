package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"spark/server/db"
	"spark/server/internal/backend"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "spark:", err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: spark migrate | admin EMAIL | dev-mail CHALLENGE_ID | maintenance | retry-upload-cleanup | replay-deletions | invalidate-restored-mail")
	}
	if os.Args[1] == "healthcheck" && len(os.Args) == 2 {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://127.0.0.1:8080/api/v1/health/ready")
		if err != nil {
			return errors.New("API is not ready")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return errors.New("API is not ready")
		}
		return nil
	}
	if len(os.Args) == 2 && os.Args[1] == "replay-deletions" {
		return runDeletionReplay()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := backend.OpenPool(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if os.Args[1] == "migrate" && len(os.Args) == 2 {
		if err = db.Migrate(ctx, pool); err != nil {
			return fmt.Errorf("migration failed: %w", err)
		}
		fmt.Printf("schema version %d ready\n", db.Version)
		return nil
	}
	if os.Args[1] == "retry-upload-cleanup" {
		if len(os.Args) != 2 {
			return errors.New("usage: spark retry-upload-cleanup")
		}
		if err := db.Ready(ctx, pool); err != nil {
			return err
		}
		count, err := backend.RequeueUploadCleanup(ctx, pool)
		if err != nil {
			return err
		}
		fmt.Printf("queued %d upload cleanup jobs\n", count)
		return nil
	}
	if os.Args[1] == "invalidate-restored-mail" {
		if len(os.Args) != 2 {
			return errors.New("usage: spark invalidate-restored-mail")
		}
		if err := db.Ready(ctx, pool); err != nil {
			return err
		}
		challenges, jobs, err := backend.InvalidateRestoredMail(ctx, pool)
		if err != nil {
			return err
		}
		fmt.Printf("invalidated %d restored challenges and cancelled %d mail jobs\n", challenges, jobs)
		return nil
	}
	cfg, err := backend.LoadConfig()
	if err != nil {
		return err
	}
	if err = db.Ready(ctx, pool); err != nil {
		return err
	}
	app, err := backend.New(ctx, cfg, pool)
	if err != nil {
		return err
	}
	switch os.Args[1] {
	case "admin":
		if len(os.Args) != 3 {
			return errors.New("usage: spark admin EMAIL (password from stdin)")
		}
		password, err := io.ReadAll(io.LimitReader(os.Stdin, 1025))
		if err != nil {
			return err
		}
		if len(password) > 1024 {
			return errors.New("password input too large")
		}
		p := strings.TrimSuffix(strings.TrimSuffix(string(password), "\n"), "\r")
		if err = app.BootstrapAdmin(ctx, os.Args[2], p); err != nil {
			return errors.New("admin creation failed; email may already exist or input is invalid")
		}
		fmt.Println("administrator created")
		return nil
	case "dev-mail":
		if len(os.Args) != 3 {
			return errors.New("usage: spark dev-mail CHALLENGE_ID")
		}
		payload, err := app.DevelopmentMail(ctx, os.Args[2])
		if err != nil {
			return errors.New("development message unavailable (disabled, expired, consumed, or unknown)")
		}
		fmt.Println(string(payload))
		return nil
	case "maintenance":
		if len(os.Args) != 2 {
			return errors.New("usage: spark maintenance")
		}
		return app.Maintenance(ctx)
	default:
		return errors.New("unknown command")
	}
}
