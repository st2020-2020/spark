package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/google/uuid"
	"spark/server/internal/purgearchive"
)

func runDeletionLedger(command string, args []string) error {
	var probe uuid.UUID
	if len(args) > 1 || command == "check-deletion-ledger" && len(args) != 0 || command == "probe-deletion-ledger" && len(args) != 1 {
		return errors.New("usage: spark check-deletion-ledger | verify-deletion-ledger [PROBE_UUID] | probe-deletion-ledger PROBE_UUID")
	}
	if len(args) == 1 {
		id, err := uuid.Parse(args[0])
		if err != nil || id == uuid.Nil || id.String() != args[0] {
			return errors.New("a canonical, non-nil probe UUID is required")
		}
		probe = id
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	archive, err := purgearchive.OpenConfigured(ctx)
	if err != nil {
		return err
	}
	defer archive.Close()

	ledger, ossMode := archive.(*purgearchive.OSS)
	if probe != uuid.Nil && !ossMode {
		return errors.New("synthetic ledger probes require the OSS backend")
	}
	switch command {
	case "probe-deletion-ledger":
		if err := ledger.Probe(ctx, probe); err != nil {
			return err
		}
	case "verify-deletion-ledger":
		if probe != uuid.Nil {
			if err := ledger.VerifyProbe(ctx, probe); err != nil {
				return err
			}
		}
		if err := archive.Each(ctx, func(purgearchive.Receipt) error { return nil }); err != nil {
			return err
		}
	}
	if ossMode {
		return json.NewEncoder(os.Stdout).Encode(ledger.Location())
	}
	fmt.Println("file deletion ledger ready")
	return nil
}
