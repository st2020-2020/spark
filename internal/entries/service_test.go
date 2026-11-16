package entries

import (
	"context"
	"slices"
	"strings"
	"testing"

	"spark/internal/db"
	"spark/internal/model"
)

func TestSQLiteLifecycle(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AI_PROVIDER", "rules")

	conn, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(conn)

	first, err := svc.CreateEntry("明天阅读一本设计书", nil)
	if err != nil {
		t.Fatal(err)
	}
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0}
	imgEntry, err := svc.CreateEntry("", &model.ImagePayload{
		Data: png,
		Type: "image/png",
		Name: "note.png",
	})
	if err != nil {
		t.Fatal(err)
	}

	list, err := svc.ListEntries()
	if err != nil || len(list) != 2 || list[0].ID != imgEntry.ID {
		t.Fatalf("unexpected list: %+v, err=%v", list, err)
	}

	svc.EnrichEntry(context.Background(), first.ID)
	gotFirst, ok, err := svc.GetEntry(first.ID)
	if err != nil || !ok || gotFirst.Status != model.StatusReady || !slices.Contains(gotFirst.Tags, "设计") {
		t.Fatalf("unexpected enriched entry: %+v ok=%v err=%v", gotFirst, ok, err)
	}

	edited, err := svc.UpdateEntry(first.ID, "AI 编程 #灵感", first.Version)
	if err != nil || edited.Status != model.StatusPending {
		t.Fatalf("unexpected edited entry: %+v err=%v", edited, err)
	}
	if _, err := svc.UpdateEntry(first.ID, "不应覆盖", first.Version); err == nil || !strings.Contains(err.Error(), "其他位置更新") {
		t.Fatalf("expected optimistic lock conflict, got %v", err)
	}

	svc.EnrichEntry(context.Background(), first.ID)
	reloaded, _, _ := svc.GetEntry(first.ID)
	if !slices.Contains(reloaded.Tags, "AI") {
		t.Fatalf("expected AI tag after re-enrich, got %v", reloaded.Tags)
	}

	// Reopen DB to verify persistence across restarts.
	_ = conn.Close()
	conn2, err := db.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	svc2 := NewService(conn2)

	persisted, ok, err := svc2.GetEntry(first.ID)
	if err != nil || !ok || persisted.Content != "AI 编程 #灵感" {
		t.Fatalf("persistence failed: %+v ok=%v err=%v", persisted, ok, err)
	}

	if err := svc2.DeleteEntry(first.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc2.DeleteEntry(imgEntry.ID); err != nil {
		t.Fatal(err)
	}
	remaining, _ := svc2.ListEntries()
	if len(remaining) != 0 {
		t.Fatalf("expected empty db after delete, got %d", len(remaining))
	}
}
