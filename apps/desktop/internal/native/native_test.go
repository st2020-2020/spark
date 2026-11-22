package native

import (
	"testing"
	"time"
)

func TestClipboardTrackerFreshnessAndConcealedFilter(t *testing.T) {
	tr := NewClipboardTracker()
	t0 := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

	// Baseline observation on launch is ignored so stale pre-launch clipboard isn't surfaced.
	tr.Observe(RawClipboardSample{ChangeCount: 10, Text: "old text"}, t0)
	if _, _, ok := tr.FreshSample(t0.Add(time.Second)); ok {
		t.Fatalf("expected baseline sample not to be treated as freshly copied")
	}

	// New copy is fresh for 20 seconds.
	tr.Observe(RawClipboardSample{ChangeCount: 11, Text: "https://example.com/a", URL: "https://example.com/a"}, t0.Add(2*time.Second))
	s, _, ok := tr.FreshSample(t0.Add(15 * time.Second))
	if !ok || s.URL != "https://example.com/a" {
		t.Fatalf("expected fresh URL sample, got %+v ok=%v", s, ok)
	}

	// Expired past 20s.
	if _, _, ok := tr.FreshSample(t0.Add(25 * time.Second)); ok {
		t.Fatalf("expected suggestion expired after 20s")
	}

	// Concealed password manager copy clears suggestion immediately and is never surfaced.
	tr.Observe(RawClipboardSample{ChangeCount: 12, Text: "fresh note"}, t0.Add(30*time.Second))
	tr.Observe(RawClipboardSample{ChangeCount: 13, Concealed: true, Text: "super-secret-password"}, t0.Add(31*time.Second))
	if _, _, ok := tr.FreshSample(t0.Add(32 * time.Second)); ok {
		t.Fatalf("expected concealed clipboard item to be filtered out")
	}
}
