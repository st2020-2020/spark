package main

import (
	"strings"
	"testing"
	"time"
)

func TestPurgeExpiryStartConfiguration(t *testing.T) {
	if cutoff, err := purgeExpiryStart(""); err != nil || cutoff.Valid {
		t.Fatalf("unset expiry start should preserve daily sweep: %v, %v", cutoff, err)
	}
	cutoff, err := purgeExpiryStart("2026-11-24T22:00:00Z")
	want := time.Date(2026, 11, 24, 22, 0, 0, 0, time.UTC)
	if err != nil || !cutoff.Valid || cutoff.Time != want {
		t.Fatalf("fixed cutover should be interpreted in UTC: %v, %v", cutoff, err)
	}
	t.Setenv("SPARK_PURGE_ENABLED", "true")
	for _, raw := range []string{"now", "2026-02-31T22:00:00Z", "2026-11-24T22:00:00", " 2026-11-24T22:00:00Z"} {
		t.Setenv("SPARK_PURGE_EXPIRY_START_AT", raw)
		if err := runPurge(); err == nil || !strings.Contains(err.Error(), "SPARK_PURGE_EXPIRY_START_AT") {
			t.Fatalf("worker did not refuse malformed expiry start %q: %v", raw, err)
		}
	}
}
