package native

import (
	"testing"
	"time"
)

func TestClipboardSuggestionReadsOnlyFreshCopy(t *testing.T) {
	tr := NewClipboardTracker()
	now := time.Now()
	unexpected := func() RawClipboardSample { t.Fatal("read from ineligible pasteboard"); return RawClipboardSample{} }
	tr.Observe(10, now)
	tr.FreshSample(now, unexpected)
	tr.Observe(11, now)
	v := RawClipboardSample{ChangeCount: 11, Text: "synthetic"}
	read := func() RawClipboardSample { return v }
	if _, ok := tr.FreshSample(now.Add(time.Second), read); !ok {
		t.Fatal("fresh copy missing")
	}
	v.Concealed = true
	if _, ok := tr.FreshSample(now, read); ok {
		t.Fatal("concealed suggestion")
	}
	v.Concealed = false
	v.ChangeCount++
	if _, ok := tr.FreshSample(now, read); ok {
		t.Fatal("copy changed before read")
	}
	tr.FreshSample(now.Add(ClipboardFreshWindow), unexpected)
	tr.Dismiss()
	tr.FreshSample(now, unexpected)
}

func TestLateDismissPreservesNewCopy(t *testing.T) {
	tr := NewClipboardTracker()
	now := time.Now()
	for _, count := range []int{1, 2, 3} {
		tr.Observe(count, now)
	}
	tr.DismissSample(2)
	read := func() RawClipboardSample { return RawClipboardSample{ChangeCount: 3, Text: "current"} }
	if _, ok := tr.FreshSample(now, read); !ok {
		t.Fatal("late dismissal hid newer copy")
	}
	tr.DismissSample(3)
	if _, ok := tr.FreshSample(now, read); ok {
		t.Fatal("dismissed copy resurfaced")
	}
}
