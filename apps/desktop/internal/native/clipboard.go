package native

import (
	"sync"
	"time"
)

const ClipboardFreshWindow = 20 * time.Second

// RawClipboardSample represents one instant snapshot from NSPasteboard.
type RawClipboardSample struct {
	ChangeCount int
	Concealed   bool
	Text        string
	URL         string
	ImagePNG    []byte
}

// ClipboardTracker observes NSPasteboard changeCount transitions in memory without hoarding history.
type ClipboardTracker struct {
	mu          sync.Mutex
	initialized bool
	lastCount   int
	changedAt   time.Time
}

func NewClipboardTracker() *ClipboardTracker {
	return &ClipboardTracker{}
}

// Observe records only the change counter, never the clipboard contents. On the very first observation at app launch,
// we record the baseline changeCount without treating pre-existing clipboard data as freshly copied.
func (t *ClipboardTracker) Observe(count int, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.initialized {
		t.initialized = true
		t.lastCount = count
		return
	}
	if count == t.lastCount {
		return
	}
	t.lastCount = count
	t.changedAt = now
}

// FreshSample reads the current pasteboard only for an eligible foreground suggestion.
// A second count check prevents exposing a later copy under the previous timestamp.
func (t *ClipboardTracker) FreshSample(now time.Time, read func() RawClipboardSample) (RawClipboardSample, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	age := now.Sub(t.changedAt)
	if t.changedAt.IsZero() || age < 0 || age >= ClipboardFreshWindow {
		return RawClipboardSample{}, false
	}
	v := read()
	if v.Concealed || v.ChangeCount != t.lastCount || (v.Text == "" && len(v.ImagePNG) == 0) {
		return RawClipboardSample{}, false
	}
	return v, true
}

func (t *ClipboardTracker) Dismiss() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.changedAt = time.Time{}
}

// DismissSample ignores only the copy the user saw, even if a newer one arrived.
func (t *ClipboardTracker) DismissSample(count int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if count == t.lastCount {
		t.changedAt = time.Time{}
	}
}
