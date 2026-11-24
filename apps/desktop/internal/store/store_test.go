package store

import (
	"os"
	"path/filepath"
	"spark/apps/desktop/internal/api"
	"strconv"
	"testing"
	"time"
)

func tinyPNG() []byte {
	return []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82}
}

func TestAtomicOutboxPersistenceAndAccountIsolation(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)

	// Account A captures a note with an attached PNG.
	itemA, err := st.EnqueueCapture(EnqueueInput{
		AccountID: "acc-A",
		RawText:   "离线的灵感参考 https://example.com/spec",
		Intent:    "参考离线队列状态机",
		Attachments: []PendingAttachmentInput{
			{Filename: "shot.png", Data: tinyPNG()},
		},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if itemA.State != OutboxLocalSaved || itemA.OriginalURL != "https://example.com/spec" {
		t.Fatalf("unexpected itemA: %+v", itemA)
	}
	if len(itemA.Attachments) != 1 || itemA.Attachments[0].MimeType != "image/png" {
		t.Fatalf("unexpected attachments: %+v", itemA.Attachments)
	}

	// Verify file exists atomically on disk and restart recovers it cleanly.
	raw, err := st.ReadAttachmentBytes(itemA.Attachments[0])
	if err != nil || len(raw) != len(tinyPNG()) {
		t.Fatalf("expected staged bytes, got len=%d err=%v", len(raw), err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate app restart.
	st2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()

	// Account B must NEVER see Account A's queue or local search hits.
	listB, err := st2.ListDueOutbox("acc-B", now.Add(time.Minute))
	if err != nil || len(listB) != 0 {
		t.Fatalf("account B saw leaked outbox items: %+v err=%v", listB, err)
	}
	hitsB, err := st2.SearchLocal("acc-B", "离线", 10)
	if err != nil || len(hitsB) != 0 {
		t.Fatalf("account B saw leaked search hits: %+v err=%v", hitsB, err)
	}

	// Account A recovers its exact item and can search it locally immediately.
	listA, err := st2.ListDueOutbox("acc-A", now.Add(time.Minute))
	if err != nil || len(listA) != 1 || listA[0].ID != itemA.ID {
		t.Fatalf("expected itemA recovered after restart, got %+v err=%v", listA, err)
	}
	hitsA, err := st2.SearchLocal("acc-A", "离线", 10)
	if err != nil || len(hitsA) != 1 || hitsA[0].SyncState != "local_saved" {
		t.Fatalf("expected local search hit for acc-A, got %+v err=%v", hitsA, err)
	}

	// Marking synced cleans up staged binary file.
	stagedFullPath := filepath.Join(st2.StagingDir(), itemA.Attachments[0].LocalPath)
	if err := st2.MarkOutboxSynced("acc-A", itemA.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagedFullPath); !os.IsNotExist(err) {
		t.Fatalf("expected staged attachment cleaned up after sync, stat err=%v", err)
	}
}

func TestCachedBodyIsSearchableBeyondRecentSummaries(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	doc := api.BuildDocument("first paragraph\nneedle near the end")
	note := api.Collection{ID: "older", UpdatedAt: "2026-11-01", Document: &doc, Projects: []api.ProjectAssociation{{ProjectID: "sketch", ProjectName: "速写", Decision: "manual"}}}
	read := st.BeginCollectionRead("a")
	defer read.Close()
	if _, err := read.ApplyDetail(note); err != nil {
		t.Fatal(err)
	}
	summaries := []api.CollectionSummary{{ID: note.ID, UpdatedAt: note.UpdatedAt, PlainText: "first paragraph", Projects: note.Projects}}
	for i := range 501 {
		summaries = append(summaries, api.CollectionSummary{ID: strconv.Itoa(i), CreatedAt: "2026-11-02"})
	}
	if _, err := read.ApplyPage(summaries); err != nil {
		t.Fatal(err)
	}
	hits, err := st.SearchLocal("a", "needle end", 5)
	if err != nil || len(hits) != 1 || hits[0].ID != note.ID {
		t.Fatalf("older full text missing: %v %v", hits, err)
	}
	if len(hits[0].Projects) != 1 || hits[0].Projects[0].ProjectID != "sketch" || hits[0].Projects[0].ProjectName != "速写" {
		t.Fatalf("missing cached project on hit: %+v", hits[0])
	}
}
