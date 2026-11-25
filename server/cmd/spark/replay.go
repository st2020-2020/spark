package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"spark/server/db"
	"spark/server/internal/backend"
	"spark/server/internal/purgearchive"
)

func runDeletionReplay() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	archive, err := purgearchive.OpenConfigured(ctx)
	if err != nil {
		return err
	}
	defer archive.Close()
	pool, err := backend.OpenPool(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Ready(ctx, pool); err != nil {
		return err
	}
	applied, err := backend.ReplayDeletions(ctx, pool, archive)
	if err != nil {
		return fmt.Errorf("replay stopped after %d applied receipts: %w", applied, err)
	}
	fmt.Printf("replayed %d deletion receipts into PostgreSQL\n", applied)
	return nil
}
