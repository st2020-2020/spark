package app

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"testing"

	"github.com/egoist/mygo/ui"

	"spark/internal/db"
	"spark/internal/entries"
	"spark/internal/model"
)

func newTestApp(t *testing.T) *App {
	t.Helper()
	t.Setenv("AI_PROVIDER", "rules")
	conn, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	svc := entries.NewService(conn)
	return New(context.Background(), svc)
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{40, 123, 89, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSparkNativeUIFlow(t *testing.T) {
	a := newTestApp(t)
	tt := ui.NewTester(a.View, 1080, 740)

	if !tt.HasText("还没有记录") {
		t.Fatalf("expected empty state on first launch, texts=%q", tt.Texts())
	}

	if err := tt.Click("记录想法"); err != nil {
		t.Fatal(err)
	}
	tt.Type("用 MyGo 重构桌面端 #开发")
	if err := tt.Click("记录"); err != nil {
		t.Fatal(err)
	}

	if len(a.entries) != 1 {
		t.Fatalf("expected 1 saved entry, got %d", len(a.entries))
	}
	if !tt.HasText("用 MyGo 重构桌面端 #开发") {
		t.Fatalf("expected new card in inbox, texts=%q", tt.Texts())
	}

	// Open detail view and test edit + unsaved confirm + delete.
	id := a.entries[0].ID
	if err := tt.Click("打开记录 " + id); err != nil {
		t.Fatal(err)
	}
	if !tt.HasText("记录详情") {
		t.Fatalf("expected detail view, texts=%q", tt.Texts())
	}

	if err := tt.Click("编辑内容"); err != nil {
		t.Fatal(err)
	}
	tt.Type(" 补充内容")

	// Navigating back while dirty must open discard confirmation.
	if err := tt.Click("返回收件箱"); err != nil {
		t.Fatal(err)
	}
	if !a.discardDialog {
		t.Fatalf("expected discard confirmation dialog when navigating with unsaved changes")
	}
	if err := tt.Click("取消"); err != nil {
		t.Fatal(err)
	}
	if a.detailID != id || !a.editing {
		t.Fatalf("expected to stay in edit mode after cancel")
	}

	if err := tt.Click("保存修改"); err != nil {
		t.Fatal(err)
	}
	if a.editing {
		t.Fatalf("expected edit mode to close after save")
	}

	if err := tt.Click("删除记录"); err != nil {
		t.Fatal(err)
	}
	if !a.deleteDialog {
		t.Fatalf("expected delete confirmation dialog")
	}
	a.deleteCurrent(nil)
	if len(a.entries) != 0 || a.detailID != "" {
		t.Fatalf("expected entry deleted and returned to inbox, len=%d detailID=%q", len(a.entries), a.detailID)
	}
}

func TestSparkSearchTagAndImageFlow(t *testing.T) {
	a := newTestApp(t)

	e1, err := a.svc.CreateEntry("研究 Go Metal 渲染 #开发", nil)
	if err != nil {
		t.Fatal(err)
	}
	a.svc.EnrichEntry(context.Background(), e1.ID)

	e2, err := a.svc.CreateEntry("周末去公园散步 #生活", nil)
	if err != nil {
		t.Fatal(err)
	}
	a.svc.EnrichEntry(context.Background(), e2.ID)

	e3, err := a.svc.CreateEntry("附带截图", &model.ImagePayload{
		Data: tinyPNG(t),
		Type: "image/png",
		Name: "shot.png",
	})
	if err != nil {
		t.Fatal(err)
	}
	a.svc.EnrichEntry(context.Background(), e3.ID)

	a.RefreshEntries()
	tt := ui.NewTester(a.View, 1080, 740)

	if !tt.HasText("研究 Go Metal 渲染 #开发") || !tt.HasText("周末去公园散步 #生活") || !tt.HasText("附带截图") {
		t.Fatalf("expected all entries rendered, texts=%q", tt.Texts())
	}

	// Filter by tag from sidebar.
	if err := tt.Click("标签 开发"); err != nil {
		t.Fatal(err)
	}
	if a.selectedTag != "开发" {
		t.Fatalf("expected selectedTag=开发, got %q", a.selectedTag)
	}
	if tt.HasText("周末去公园散步 #生活") {
		t.Fatalf("expected non-matching entry filtered out")
	}

	// Clear filter.
	if err := tt.Click("清除筛选"); err != nil {
		t.Fatal(err)
	}
	if a.selectedTag != "" || !tt.HasText("周末去公园散步 #生活") {
		t.Fatalf("expected all entries restored after clearing filter")
	}

	// Search by keyword.
	if err := tt.Click("搜索记录"); err != nil {
		t.Fatal(err)
	}
	tt.Type("散步")
	if tt.HasText("研究 Go Metal 渲染 #开发") || !tt.HasText("周末去公园散步 #生活") {
		t.Fatalf("unexpected search results, texts=%q", tt.Texts())
	}
}

func TestSparkCmdEnterAndDiscardConfirm(t *testing.T) {
	a := newTestApp(t)
	tt := ui.NewTester(a.View, 1080, 740)

	if err := tt.Click("记录想法"); err != nil {
		t.Fatal(err)
	}
	tt.Type("快捷保存测试 #灵感")
	tt.Key(ui.Cmd, ui.KeyEnter)

	if len(a.entries) != 1 || a.entries[0].Content != "快捷保存测试 #灵感" {
		t.Fatalf("expected Cmd+Enter to create entry, got %+v", a.entries)
	}

	// Enter detail, edit, trigger discard confirmation and accept discard.
	if err := tt.Click("打开记录 " + a.entries[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := tt.Click("编辑内容"); err != nil {
		t.Fatal(err)
	}
	tt.Type("未保存追加")
	if err := tt.Click("返回收件箱"); err != nil {
		t.Fatal(err)
	}
	if !a.discardDialog {
		t.Fatalf("expected discardDialog open")
	}
	if err := tt.Click("放弃修改"); err != nil {
		t.Fatal(err)
	}
	if a.detailID != "" || a.editing {
		t.Fatalf("expected return to inbox after confirming discard")
	}
}
