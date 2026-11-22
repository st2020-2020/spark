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
