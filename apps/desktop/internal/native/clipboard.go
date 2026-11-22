package native

import (
	"sync"
	"time"
)

const ClipboardFreshWindow = 20 * time.Second

// ClipboardSuggestion is the non-intrusive 20-second clipboard suggestion shown in Quick Capture.
// It is kept strictly in memory, never stored as clipboard history, and excludes concealed items.
type ClipboardSuggestion struct {
	Available    bool   `json:"available"`
	Kind         string `json:"kind,omitempty"` // "url" | "text" | "image"
	Label        string `json:"label,omitempty"`
	Preview      string `json:"preview,omitempty"`
	Text         string `json:"text,omitempty"`
	ImageDataB64 string `json:"image_data_b64,omitempty"`
	ImageMime    string `json:"image_mime,omitempty"`
	ImageName    string `json:"image_name,omitempty"`
	AgeSeconds   int    `json:"age_seconds,omitempty"`
}

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
	latest      RawClipboardSample
}

func NewClipboardTracker() *ClipboardTracker {
	return &ClipboardTracker{}
}

// Observe records a new pasteboard sample. On the very first observation at app launch,
// we record the baseline changeCount without treating pre-existing clipboard data as freshly copied.
func (t *ClipboardTracker) Observe(sample RawClipboardSample, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.initialized {
		t.initialized = true
		t.lastCount = sample.ChangeCount
		return
	}
	if sample.ChangeCount == t.lastCount {
		return
	}
	t.lastCount = sample.ChangeCount
	if sample.Concealed {
		// Password manager / concealed copy: clear any previous suggestion immediately.
		t.latest = RawClipboardSample{}
		t.changedAt = time.Time{}
		return
	}
	t.latest = sample
	t.changedAt = now
}

// FreshSample returns the latest non-concealed sample if copied within ClipboardFreshWindow (20s).
func (t *ClipboardTracker) FreshSample(now time.Time) (RawClipboardSample, time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.changedAt.IsZero() || t.latest.Concealed {
		return RawClipboardSample{}, 0, false
	}
	age := now.Sub(t.changedAt)
	if age < 0 || age > ClipboardFreshWindow {
		return RawClipboardSample{}, 0, false
	}
	if t.latest.Text == "" && t.latest.URL == "" && len(t.latest.ImagePNG) == 0 {
		return RawClipboardSample{}, 0, false
	}
	return t.latest, age, true
}

// Dismiss clears the currently offered suggestion after the user accepts or dismisses it.
func (t *ClipboardTracker) Dismiss() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.latest = RawClipboardSample{}
	t.changedAt = time.Time{}
}
