package app

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"spark/internal/entries"
	"spark/internal/model"
	"spark/internal/validation"
)

type tagCount struct {
	Tag   string
	Count int
}

type App struct {
	svc *entries.Service
	win *mygo.Window
	ctx context.Context

	entries   []model.Entry
	bitmaps   map[string]*ui.Bitmap
	loadError string

	// Route / filter
	detailID    string
	query       string
	selectedTag string

	// Capture form
	draft        string
	draftSession int
	draftImage   *model.ImagePayload
	draftBitmap  *ui.Bitmap
	captureErr   string
	submitting   bool

	// Detail / edit state
	editing     bool
	editContent string
	editSession int
	editErr     string
	busy        bool

	// Confirmations
	deleteDialog  bool
	discardDialog bool
	pendingAction func()

	// Persistent UI identity / scroll state
	captureHandle ui.Handle
	searchHandle  ui.Handle
	editHandle    ui.Handle
	listState     ui.ListState
	detailScroll  ui.ScrollState
}

func New(ctx context.Context, svc *entries.Service) *App {
	a := &App{
		svc:     svc,
		ctx:     ctx,
		bitmaps: make(map[string]*ui.Bitmap),
	}
	a.RefreshEntries()
	return a
}

func (a *App) SetWindow(win *mygo.Window) {
	a.win = win
	a.svc.SetOnUpdated(func(id string) {
		if a.win == nil {
			return
		}
		a.win.Update(func() {
			a.RefreshEntries()
		})
	})
}

func (a *App) RefreshEntries() {
	list, err := a.svc.ListEntries()
	if err != nil {
		a.loadError = "读取本地记录失败：" + err.Error()
		return
	}
	a.loadError = ""
	a.entries = list

	// Evict stale bitmaps for deleted entries.
	live := make(map[string]struct{}, len(list))
	for _, e := range list {
		if e.HasImage {
			live[e.ID] = struct{}{}
		}
	}
	for id := range a.bitmaps {
		if _, ok := live[id]; !ok {
			delete(a.bitmaps, id)
		}
	}
}

func (a *App) bitmapForEntry(id string) *ui.Bitmap {
	if bmp, ok := a.bitmaps[id]; ok {
		return bmp
	}
	data, _, ok, err := a.svc.GetEntryImage(id)
	if err != nil || !ok {
		a.bitmaps[id] = nil
		return nil
	}
	bmp, err := ui.DecodeBitmap(data)
	if err != nil {
		a.bitmaps[id] = nil
		return nil
	}
	a.bitmaps[id] = bmp
	return bmp
}

func (a *App) FocusCapture(c *ui.Context) {
	if a.detailID != "" {
		a.requestNavigate(func() {
			a.detailID = ""
			a.editing = false
			a.editErr = ""
			a.captureHandle.Focus(c)
		})
		return
	}
	a.captureHandle.Focus(c)
}

func (a *App) FocusSearch(c *ui.Context) {
	if a.detailID != "" {
		a.requestNavigate(func() {
			a.detailID = ""
			a.editing = false
			a.editErr = ""
			a.searchHandle.SelectAll(c)
		})
		return
	}
	a.searchHandle.SelectAll(c)
}

func (a *App) isDirtyDetail() bool {
	if a.detailID == "" || !a.editing {
		return false
	}
	cur, ok := a.findEntry(a.detailID)
	if !ok {
		return false
	}
	return a.editContent != cur.Content
}

func (a *App) requestNavigate(fn func()) {
	if a.isDirtyDetail() {
		a.pendingAction = fn
		a.discardDialog = true
		return
	}
	fn()
}

func (a *App) findEntry(id string) (model.Entry, bool) {
	for _, e := range a.entries {
		if e.ID == id {
			return e, true
		}
	}
	return model.Entry{}, false
}

func (a *App) tagCounts() []tagCount {
	counts := make(map[string]int)
	for _, e := range a.entries {
		for _, tag := range e.Tags {
			counts[tag]++
		}
	}
	out := make([]tagCount, 0, len(counts))
	for tag, n := range counts {
		out = append(out, tagCount{Tag: tag, Count: n})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Tag < out[j].Tag
	})
	return out
}

func (a *App) visibleEntries() []model.Entry {
	needle := strings.ToLower(strings.TrimSpace(a.query))
	if needle == "" && a.selectedTag == "" {
		return a.entries
	}
	var out []model.Entry
	for _, e := range a.entries {
		if a.selectedTag != "" && !containsString(e.Tags, a.selectedTag) {
			continue
		}
		if needle != "" {
			haystack := strings.ToLower(strings.Join([]string{
				e.Content,
				e.Title,
				e.Summary,
				strings.Join(e.Tags, " "),
			}, " "))
			if !strings.Contains(haystack, needle) {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

func (a *App) submitCapture(c *ui.Context, rawText string) bool {
	if a.submitting {
		return false
	}
	a.submitting = true
	defer func() { a.submitting = false }()

	entry, err := a.svc.CreateEntry(rawText, a.draftImage)
	if err != nil {
		a.captureErr = err.Error()
		a.captureHandle.Focus(c)
		return false
	}

	a.captureErr = ""
	a.draft = ""
	a.draftSession++
	a.draftImage = nil
	a.draftBitmap = nil
	a.query = ""
	a.selectedTag = ""
	a.RefreshEntries()
	c.Toast("已保存，摘要和标签会自动补上。")

	go a.svc.EnrichEntry(a.ctx, entry.ID)
	return true
}

func (a *App) openImagePicker(c *ui.Context) {
	if a.submitting {
		return
	}
	win := a.win
	go func() {
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
			Parent: win,
			Title:  "选择图片",
			Filters: []mygo.FileFilter{
				{Name: "图片 (JPG/PNG/GIF/WebP)", Extensions: []string{"jpg", "jpeg", "png", "gif", "webp"}},
			},
		})
		if err != nil || len(paths) == 0 {
			return
		}
		data, err := os.ReadFile(paths[0])
		if err != nil {
			if win != nil {
				win.Update(func() { a.captureErr = "读取图片文件失败，请重试。" })
			}
			return
		}
		mimeType, cleanName, err := validation.ValidateImage(data, paths[0])
		if err != nil {
			if win != nil {
				win.Update(func() { a.captureErr = err.Error() })
			}
			return
		}
		bmp, err := ui.DecodeBitmap(data)
		if err != nil {
			if win != nil {
				win.Update(func() { a.captureErr = "图片解码失败，请更换有效的图片。" })
			}
			return
		}
		if win != nil {
			win.Update(func() {
				a.draftImage = &model.ImagePayload{Data: data, Type: mimeType, Name: cleanName}
				a.draftBitmap = bmp
				a.captureErr = ""
			})
		}
	}()
}

func (a *App) attachPastedImage(png []byte) {
	mimeType, cleanName, err := validation.ValidateImage(png, "剪贴板图片.png")
	if err != nil {
		a.captureErr = err.Error()
		return
	}
	bmp, err := ui.DecodeBitmap(png)
	if err != nil {
		a.captureErr = "剪贴板图片解码失败。"
		return
	}
	a.draftImage = &model.ImagePayload{Data: png, Type: mimeType, Name: cleanName}
	a.draftBitmap = bmp
	a.captureErr = ""
}

func (a *App) saveEdit(c *ui.Context, entry model.Entry) {
	if a.busy {
		return
	}
	a.busy = true
	defer func() { a.busy = false }()

	updated, err := a.svc.UpdateEntry(entry.ID, a.editContent, entry.Version)
	if err != nil {
		a.editErr = err.Error()
		a.editHandle.Focus(c)
		return
	}
	a.editErr = ""
	a.editing = false
	a.editContent = updated.Content
	a.RefreshEntries()
	c.Toast("修改已保存，摘要与标签会重新整理。")

	go a.svc.EnrichEntry(a.ctx, updated.ID)
}

func (a *App) deleteCurrent(c *ui.Context) {
	if a.busy || a.detailID == "" {
		return
	}
	a.busy = true
	defer func() { a.busy = false }()

	id := a.detailID
	if err := a.svc.DeleteEntry(id); err != nil {
		a.editErr = err.Error()
		return
	}
	delete(a.bitmaps, id)
	a.detailID = ""
	a.editing = false
	a.editErr = ""
	a.deleteDialog = false
	a.RefreshEntries()
	c.Toast("记录已永久删除。")
}

func (a *App) View(c *ui.Context) {
	p := applySparkTheme(c)

	if c.Shortcut(ui.Cmd, ui.KeyN) {
		a.FocusCapture(c)
	}
	if c.Shortcut(ui.Cmd, ui.KeyF) {
		a.FocusSearch(c)
	}
	if c.Shortcut(0, ui.KeyEscape) && a.detailID != "" && !a.deleteDialog && !a.discardDialog {
		if a.editing {
			a.requestNavigate(func() {
				a.editing = false
				a.editErr = ""
			})
		} else {
			a.detailID = ""
		}
	}

	ui.Row(c).Fill().AlignItems(ui.Stretch).Background(p.bg).Children(func() {
		a.renderSidebar(c, p)
		ui.Box(c).Width(1).FillHeight().Background(p.border)
		ui.Column(c).Grow(1).MinWidth(0).FillHeight().Children(func() {
			a.renderTopbar(c, p)
			ui.Box(c).Height(1).FillWidth().Background(p.border)
			if a.detailID != "" {
				a.renderDetail(c, p)
			} else {
				a.renderInbox(c, p)
			}
		})
	})

	switch ui.AlertDialog(c, &a.deleteDialog, "删除这条记录？", "原始内容、图片、摘要和标签将永久删除，无法恢复。", "取消", "删除记录") {
	case 1:
		a.deleteCurrent(c)
	}

	switch ui.AlertDialog(c, &a.discardDialog, "放弃未保存的修改？", "你的修改还未保存。放弃后，仍会保留上一次保存的内容。", "取消", "放弃修改") {
	case 1:
		a.editing = false
		a.editErr = ""
		if a.pendingAction != nil {
			fn := a.pendingAction
			a.pendingAction = nil
			fn()
		}
	case 0, ui.AlertDismissed:
		a.pendingAction = nil
	}
}

func (a *App) renderSidebar(c *ui.Context, p palette) {
	tags := a.tagCounts()

	ui.Column(c).Width(232).Shrink(0).FillHeight().Background(p.sidebarBg).Padding(16, 14).Gap(12).Children(func() {
		// Brand
		ui.Row(c).Gap(10).AlignItems(ui.Center).Padding(2, 4).Children(func() {
			ui.Box(c).Size(32, 32).Radius(8).Background(p.accentSoft).Center().Children(func() {
				ui.Icon(c, iconSpark).FontSize(18).TextColor(p.primary)
			})
			ui.Column(c).Gap(1).Children(func() {
				ui.Text(c, "Spark").FontSize(16).Bold().TextColor(p.text)
				ui.Text(c, "随手记，慢慢想").FontSize(11).TextColor(p.muted)
			})
		})

		// Stats
		ui.Row(c).Gap(8).Children(func() {
			statBox := func(value int, label string) {
				ui.Column(c).Grow(1).Padding(8, 10).Radius(8).Background(p.cardBg).Border(1, p.border).Gap(2).Children(func() {
					ui.Textf(c, "%d", value).FontSize(17).Bold().TextColor(p.text)
					ui.Text(c, label).FontSize(11).TextColor(p.muted)
				})
			}
			statBox(len(a.entries), "笔记")
			statBox(len(tags), "标签")
		})

		// 12-week heatmap
		a.renderHeatmap(c, p)

		// New record button
		if ui.Button(c, "").Label("新建记录").FillWidth().Padding(8, 12).Radius(6).Background(p.cardBg).Border(1, p.border).OnClick(func() {
			a.FocusCapture(c)
		}).Children(func() {
			ui.Icon(c, iconPlus).FontSize(15).TextColor(p.primary)
			ui.Text(c, "新建记录").FontSize(13).FontWeight(500).TextColor(p.text)
		}).Clicked() {
			// handled by OnClick
		}

		// All notes nav
		allActive := a.detailID == "" && a.selectedTag == ""
		allBtn := ui.Button(c, "").Label("全部笔记").FillWidth().Padding(7, 10).Radius(6).Justify(ui.Start)
		if allActive {
			allBtn.Background(p.accentSoft).Border(1, p.primary.Alpha(0.25))
		} else {
			allBtn.Background(ui.Transparent).Border(0, ui.Transparent)
		}
		allBtn.OnClick(func() {
			a.requestNavigate(func() {
				a.detailID = ""
				a.editing = false
				a.selectedTag = ""
				a.query = ""
			})
		}).Children(func() {
			fg := p.text
			if allActive {
				fg = p.primary
			}
			ui.Icon(c, iconInbox).FontSize(15).TextColor(fg)
			ui.Text(c, "全部笔记").FontSize(13).FontWeight(500).TextColor(fg).Grow(1)
			ui.Textf(c, "%d", len(a.entries)).FontSize(12).TextColor(p.muted)
		})

		// Tags section header
		ui.Row(c).Padding(4, 6, 0, 6).Children(func() {
			ui.Text(c, "标签").FontSize(11).FontWeight(600).TextColor(p.muted).Grow(1)
			ui.Textf(c, "%d", len(tags)).FontSize(11).TextColor(p.muted)
		})

		// Scrollable tags list
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).Gap(3).Children(func() {
				if len(tags) == 0 {
					ui.Text(c, "保存记录后，标签会自动出现在这里。").FontSize(12).TextColor(p.muted).Padding(4, 6)
					return
				}
				for _, item := range tags {
					tag := item.Tag
					count := item.Count
					active := a.detailID == "" && a.selectedTag == tag
					btn := ui.Button(c.Key("sidebar-tag-"+tag), "").Label("标签 "+tag).FillWidth().Padding(6, 8).Radius(6).Justify(ui.Start)
					if active {
						btn.Background(p.accentSoft).Border(1, p.primary.Alpha(0.25))
					} else {
						btn.Background(ui.Transparent).Border(0, ui.Transparent)
					}
					btn.OnClick(func() {
						a.requestNavigate(func() {
							a.detailID = ""
							a.editing = false
							if a.selectedTag == tag {
								a.selectedTag = ""
							} else {
								a.selectedTag = tag
							}
						})
					}).Children(func() {
						fg := p.text
						if active {
							fg = p.primary
						}
						ui.Icon(c, iconHash).FontSize(13).TextColor(fg)
						ui.Text(c, tag).FontSize(13).TextColor(fg).SingleLine().Grow(1)
						ui.Textf(c, "%d", count).FontSize(11).TextColor(p.muted)
					})
				}
			})
		})

		// Local storage footer badge
		ui.Row(c).Gap(6).Padding(8, 10).Radius(6).Background(p.cardBg).Border(1, p.border).AlignItems(ui.Center).Children(func() {
			ui.Icon(c, iconShield).FontSize(14).TextColor(p.primary)
			ui.Text(c, "保存在本机 · SQLite").FontSize(11).TextColor(p.muted).Grow(1)
			ui.Box(c).Size(6, 6).Radius(3).Background(p.primary)
		})
	})
}

func (a *App) renderHeatmap(c *ui.Context, p palette) {
	dayCounts := make(map[string]int)
	for _, e := range a.entries {
		if ts, ok := parseTimestamp(e.CreatedAt); ok {
			dayCounts[ts.Local().Format("2006-01-02")]++
		}
	}

	now := time.Now().Local()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -83)

	ui.Column(c).Padding(10).Radius(8).Background(p.cardBg).Border(1, p.border).Gap(6).Children(func() {
		ui.Row(c).Gap(4).Justify(ui.SpaceBetween).Children(func() {
			for col := 0; col < 12; col++ {
				ui.Column(c).Gap(4).Children(func() {
					for row := 0; row < 7; row++ {
						day := start.AddDate(0, 0, col*7+row)
						key := day.Format("2006-01-02")
						cnt := dayCounts[key]
						level := cnt
						if level > 4 {
							level = 4
						}
						tip := fmt.Sprintf("%s · %d 条记录", day.Format("2006-01-02"), cnt)
						ui.Box(c.Key("hm-"+key)).Size(10, 10).Radius(2).Background(p.heatmapLevels[level]).Tooltip(tip)
					}
				})
			}
		})
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "近 12 周").FontSize(10).TextColor(p.muted).Grow(1)
			ui.Row(c).Gap(3).AlignItems(ui.Center).Children(func() {
				ui.Text(c, "少").FontSize(10).TextColor(p.muted)
				ui.Box(c).Size(8, 8).Radius(2).Background(p.heatmapLevels[0])
				ui.Box(c).Size(8, 8).Radius(2).Background(p.heatmapLevels[2])
				ui.Box(c).Size(8, 8).Radius(2).Background(p.heatmapLevels[4])
				ui.Text(c, "多").FontSize(10).TextColor(p.muted)
			})
		})
	})
}

func (a *App) renderTopbar(c *ui.Context, p palette) {
	ui.Row(c).Height(42).Padding(0, 24).AlignItems(ui.Center).Background(p.cardBg).Children(func() {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Grow(1).Children(func() {
			ui.Text(c, "我的空间").FontSize(12).TextColor(p.muted)
			ui.Text(c, "/").FontSize(12).TextColor(p.muted)
			if a.detailID != "" {
				ui.Button(c, "").Label("返回收件箱").Padding(2, 6).Radius(4).Background(ui.Transparent).Border(0, ui.Transparent).OnClick(func() {
					a.requestNavigate(func() {
						a.detailID = ""
						a.editing = false
						a.editErr = ""
					})
				}).Children(func() {
					ui.Text(c, "收件箱").FontSize(12).TextColor(p.primary)
				})
				ui.Text(c, "/").FontSize(12).TextColor(p.muted)
				ui.Text(c, "记录详情").FontSize(12).FontWeight(500).TextColor(p.text)
			} else if a.selectedTag != "" {
				ui.Text(c, "收件箱").FontSize(12).TextColor(p.muted)
				ui.Text(c, "/").FontSize(12).TextColor(p.muted)
				ui.Text(c, "# "+a.selectedTag).FontSize(12).FontWeight(500).TextColor(p.primary)
			} else {
				ui.Text(c, "收件箱").FontSize(12).FontWeight(500).TextColor(p.text)
			}
		})
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(6, 6).Radius(3).Background(p.primary)
			ui.Text(c, "个人桌面空间").FontSize(12).TextColor(p.muted)
		})
	})
}

func (a *App) renderInbox(c *ui.Context, p palette) {
	visible := a.visibleEntries()

	ui.Column(c).Grow(1).FillWidth().Padding(20, 28, 0, 28).Gap(16).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Grow(1).FillWidth().MaxWidth(760).Gap(16).Children(func() {
			// Page header + search
			ui.Row(c).Gap(12).AlignItems(ui.Center).Children(func() {
				title := "全部笔记"
				if a.selectedTag != "" {
					title = "# " + a.selectedTag
				}
				ui.Text(c, title).FontSize(22).Bold().TextColor(p.text).Grow(1)
				ui.SearchField(c.Key("inbox-search"), &a.query).
					Bind(&a.searchHandle).
					Placeholder("搜索内容、摘要或标签 (⌘F)").
					Label("搜索记录").
					Width(260)
			})

			if a.loadError != "" {
				ui.Row(c).Padding(10, 12).Radius(6).Background(p.dangerSoft).Border(1, p.danger.Alpha(0.35)).Children(func() {
					ui.Text(c, a.loadError).FontSize(13).TextColor(p.danger).Grow(1)
				})
			}

			// Capture card
			a.renderCaptureCard(c, p)

			// List heading & filter banner
			ui.Row(c).AlignItems(ui.Center).Gap(10).Children(func() {
				ui.Text(c, "最近记录").FontSize(13).FontWeight(600).TextColor(p.muted).Grow(1)
				ui.Textf(c, "%d 条笔记", len(visible)).FontSize(12).TextColor(p.muted)
			})

			if a.query != "" || a.selectedTag != "" {
				ui.Row(c).Padding(8, 12).Radius(6).Background(p.accentSoft).Border(1, p.primary.Alpha(0.25)).AlignItems(ui.Center).Children(func() {
					msg := fmt.Sprintf("找到 %d 条记录", len(visible))
					if a.query != "" {
						msg += fmt.Sprintf(" · “%s”", a.query)
					}
					if a.selectedTag != "" {
						msg += fmt.Sprintf(" · #%s", a.selectedTag)
					}
					ui.Text(c, msg).FontSize(12).TextColor(p.primary).Grow(1)
					if ui.Button(c, "清除筛选").Padding(3, 8).Radius(4).Clicked() {
						a.query = ""
						a.selectedTag = ""
					}
				})
			}

			// Entries stream or empty state
			if len(visible) == 0 {
				a.renderEmptyState(c, p)
			} else {
				ui.List(c.Key("inbox-entries"), &a.listState, len(visible)).
					ItemKey(func(i int) any { return visible[i].ID }).
					Grow(1).
					Gap(12).
					Padding(0, 2, 24, 0).
					Rows(func(row ui.ListRow) {
						a.renderEntryCard(row.Context, p, visible[row.Index])
					})
			}
		})
	})
}

func (a *App) renderCaptureCard(c *ui.Context, p palette) {
	ui.Column(c).Padding(14).Radius(8).Background(p.cardBg).Border(1, p.borderStrong).Gap(10).Children(func() {
		area := ui.TextArea(c.Key(a.draftSession), &a.draft).
			Bind(&a.captureHandle).
			Placeholder("现在的想法是… 支持粘贴链接、#标签 或图片 (⌘↵ 保存)").
			Label("记录想法").
			Lines(3, 9).
			MaxLength(validation.MaxContent).
			Disabled(a.submitting).
			OnPaste(func(text string) bool {
				if text == "" {
					if png := mygo.Clipboard.ReadImage(); len(png) > 0 {
						a.attachPastedImage(png)
						return true
					}
				}
				return false
			}).
			OnTextKey(func(k ui.TextKey) bool {
				if k.Key == ui.KeyEnter && (k.Mods == ui.Cmd || k.Mods == ui.Ctrl) {
					if a.submitCapture(c, k.Text()) {
						k.SetText("")
					}
					return true
				}
				return false
			})
		if area.Changed() && a.captureErr != "" {
			a.captureErr = ""
		}

		// Image preview strip
		if a.draftImage != nil {
			ui.Row(c).Padding(8, 10).Radius(6).Background(p.subtleBg).Border(1, p.border).Gap(10).AlignItems(ui.Center).Children(func() {
				if a.draftBitmap != nil {
					ui.Image(c, a.draftBitmap).Size(48, 48).Fit(ui.Cover).Radius(4)
				}
				ui.Column(c).Gap(2).Grow(1).Children(func() {
					ui.Text(c, a.draftImage.Name).FontSize(13).FontWeight(500).TextColor(p.text).SingleLine()
					ui.Textf(c, "%.0f KB · 待保存", float64(len(a.draftImage.Data))/1024).FontSize(11).TextColor(p.muted)
				})
				ui.Button(c, "").Label("移除待上传图片").Padding(5).Radius(4).OnClick(func() {
					a.draftImage = nil
					a.draftBitmap = nil
				}).Children(func() {
					ui.Icon(c, iconClose).FontSize(14).TextColor(p.muted)
				})
			})
		}

		if a.captureErr != "" {
			ui.Row(c).Padding(8, 10).Radius(6).Background(p.dangerSoft).Border(1, p.danger.Alpha(0.35)).Children(func() {
				ui.Text(c, a.captureErr).FontSize(12).TextColor(p.danger).Grow(1)
			})
		}

		// Action row
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Button(c, "").Label("添加标签").Tooltip("插入 # 标签").Padding(6, 9).Radius(6).Disabled(a.submitting).OnClick(func() {
				if a.draft != "" && !strings.HasSuffix(a.draft, " ") && !strings.HasSuffix(a.draft, "\n") {
					a.draft += " "
				}
				a.draft += "#"
				a.captureHandle.Focus(c)
			}).Children(func() {
				ui.Icon(c, iconHash).FontSize(15).TextColor(p.muted)
				ui.Text(c, "标签").FontSize(12).TextColor(p.muted)
			})

			ui.Button(c, "").Label("添加图片").Tooltip("选择 JPG/PNG/GIF/WebP 图片 (≤ 5 MB)").Padding(6, 9).Radius(6).Disabled(a.submitting).OnClick(func() {
				a.openImagePicker(c)
			}).Children(func() {
				ui.Icon(c, iconImage).FontSize(15).TextColor(p.muted)
				ui.Text(c, "图片").FontSize(12).TextColor(p.muted)
			})

			ui.Spacer(c)

			ui.Text(c, "⌘ ↵").FontSize(11).TextColor(p.muted)

			ui.PrimaryButton(c, "").Label("记录").Padding(7, 14).Radius(6).Disabled(a.submitting).OnClick(func() {
				a.submitCapture(c, a.draft)
			}).Children(func() {
				ui.Text(c, "记录").FontSize(13).FontWeight(600).TextColor(ui.Hex("#ffffff"))
				ui.Icon(c, iconSend).FontSize(14).TextColor(ui.Hex("#ffffff"))
			})
		})
	})
}

func (a *App) renderEntryCard(c *ui.Context, p palette, entry model.Entry) {
	ui.Column(c).FillWidth().Padding(16).Radius(8).Background(p.cardBg).Border(1, p.border).Gap(10).Children(func() {
		// Meta row
		ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
			a.renderSourceBadge(c, p, entry.Source)
			ui.Text(c, formatLocalTime(entry.CreatedAt)).FontSize(12).TextColor(p.muted).Grow(1)
			ui.Button(c, "").Label("打开记录 "+entry.ID).Padding(4, 8).Radius(5).Background(ui.Transparent).Border(0, ui.Transparent).OnClick(func() {
				a.detailID = entry.ID
				a.editing = false
				a.editContent = entry.Content
				a.editErr = ""
				a.detailScroll = ui.ScrollState{}
			}).Children(func() {
				ui.Text(c, "打开").FontSize(12).TextColor(p.primary)
				ui.Icon(c, iconArrowUR).FontSize(13).TextColor(p.primary)
			})
		})

		if entry.Title != "" {
			ui.Text(c, entry.Title).FontSize(15).FontWeight(600).TextColor(p.text).MaxLines(2)
		}

		if entry.HasImage {
			if bmp := a.bitmapForEntry(entry.ID); bmp != nil {
				if w, h := ui.ImageSize(bmp); w > 0 && h > 0 {
					ui.Image(c, bmp).MaxWidthPercent(100).MaxHeight(240).AspectRatio(w / h).Fit(ui.Contain).Radius(6).Label(entry.ImageName)
				}
			}
		}

		if entry.Content != "" {
			ui.Text(c, entry.Content).FontSize(14).LineHeight(1.7).TextColor(p.text).MaxLines(8)
		}

		if entry.Status == model.StatusPending {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				spin := ui.Icon(c, iconLoader).FontSize(12).TextColor(p.primary)
				spin.Rotate(spin.Loop("spin-"+entry.ID, time.Second, ui.Linear) * 360)
				ui.Text(c, "正在整理…").FontSize(12).TextColor(p.muted)
			})
		}

		if len(entry.Tags) > 0 {
			ui.Row(c).Gap(6).Wrap().Children(func() {
				for _, tag := range entry.Tags {
					t := tag
					ui.Button(c.Key("card-tag-"+entry.ID+"-"+t), "").Label("筛选标签 "+t).Padding(3, 8).Radius(4).Background(p.accentSoft).Border(0, ui.Transparent).OnClick(func() {
						if a.selectedTag == t {
							a.selectedTag = ""
						} else {
							a.selectedTag = t
						}
					}).Children(func() {
						ui.Text(c, "# "+t).FontSize(12).TextColor(p.primary)
					})
				}
			})
		}
	})
}

func (a *App) renderSourceBadge(c *ui.Context, p palette, src model.Source) {
	var ic *ui.SVG
	switch src {
	case model.SourceURL:
		ic = iconLink
	case model.SourceImage:
		ic = iconImage
	default:
		ic = iconFileText
	}
	ui.Row(c).Gap(4).Padding(2, 7).Radius(4).Background(p.subtleBg).Border(1, p.border).AlignItems(ui.Center).Children(func() {
		ui.Icon(c, ic).FontSize(12).TextColor(p.muted)
		ui.Text(c, model.SourceLabel(src)).FontSize(11).TextColor(p.muted)
	})
}

func (a *App) renderEmptyState(c *ui.Context, p palette) {
	ui.Column(c).FillWidth().Padding(40, 24).Radius(8).Background(p.cardBg).Border(1, p.border).Center().Gap(10).Children(func() {
		ui.Box(c).Size(48, 48).Radius(12).Background(p.accentSoft).Center().Children(func() {
			ui.Icon(c, iconInbox).FontSize(24).TextColor(p.primary)
		})
		title := "还没有记录"
		desc := "从一句想法开始。文字、链接和图片都能保存。"
		btnLabel := "写下第一条"
		if a.query != "" || a.selectedTag != "" {
			title = "还没找到匹配的记录"
			desc = "换个关键词，或清除筛选再看看。"
			btnLabel = "清除筛选"
		}
		ui.Text(c, title).FontSize(16).Bold().TextColor(p.text)
		ui.Text(c, desc).FontSize(13).TextColor(p.muted)
		if ui.Button(c, btnLabel).Padding(7, 14).Radius(6).Clicked() {
			a.query = ""
			a.selectedTag = ""
			a.captureHandle.Focus(c)
		}
	})
}

func (a *App) renderDetail(c *ui.Context, p palette) {
	entry, ok := a.findEntry(a.detailID)
	if !ok {
		a.detailID = ""
		a.editing = false
		return
	}

	ui.Scroll(c).TrackScroll(&a.detailScroll).Grow(1).FillWidth().Padding(20, 28, 36, 28).Children(func() {
		ui.Column(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Column(c).FillWidth().MaxWidth(760).Gap(16).Children(func() {
				// Back row
				ui.Row(c).AlignItems(ui.Center).Children(func() {
					ui.Button(c, "").Label("返回收件箱").Padding(6, 10).Radius(6).OnClick(func() {
						a.requestNavigate(func() {
							a.detailID = ""
							a.editing = false
							a.editErr = ""
						})
					}).Children(func() {
						ui.Icon(c, iconBack).FontSize(15).TextColor(p.text)
						ui.Text(c, "返回收件箱").FontSize(13).TextColor(p.text)
					})
					ui.Spacer(c)
					stateText := "已保存在本机"
					if entry.Status == model.StatusPending {
						stateText = "已保存 · 整理中"
					}
					ui.Text(c, stateText).FontSize(12).TextColor(p.muted)
				})

				// Detail header
				ui.Row(c).AlignItems(ui.Center).Gap(12).Children(func() {
					ui.Column(c).Gap(2).Grow(1).Children(func() {
						ui.Text(c, "我的收件箱").FontSize(12).TextColor(p.muted)
						ui.Text(c, "记录详情").FontSize(22).Bold().TextColor(p.text)
					})
					a.renderSourceBadge(c, p, entry.Source)
				})

				// Main content card
				ui.Column(c).FillWidth().Padding(20).Radius(8).Background(p.cardBg).Border(1, p.border).Gap(14).Children(func() {
					ui.Row(c).Gap(16).Children(func() {
						ui.Text(c, "创建于 "+formatLocalTime(entry.CreatedAt)).FontSize(12).TextColor(p.muted)
						if entry.UpdatedAt != entry.CreatedAt {
							ui.Text(c, "编辑于 "+formatLocalTime(entry.UpdatedAt)).FontSize(12).TextColor(p.muted)
						}
					})

					if entry.Title != "" {
						ui.Text(c, entry.Title).FontSize(18).Bold().TextColor(p.text)
					}

					if entry.HasImage {
						if bmp := a.bitmapForEntry(entry.ID); bmp != nil {
							if w, h := ui.ImageSize(bmp); w > 0 && h > 0 {
								ui.Image(c, bmp).MaxWidthPercent(100).MaxHeight(460).AspectRatio(w / h).Fit(ui.Contain).Radius(6).Label(entry.ImageName)
							}
						}
					}

					if a.editing {
						ui.Text(c, "原始内容").FontSize(12).FontWeight(600).TextColor(p.muted)
						ui.TextArea(c.Key("edit-"+entry.ID+"-"+fmt.Sprint(a.editSession)), &a.editContent).
							Bind(&a.editHandle).
							Label("编辑原始内容").
							Lines(6, 16).
							MaxLength(validation.MaxContent).
							Disabled(a.busy).
							AutoFocus()

						if a.editErr != "" {
							ui.Row(c).Padding(8, 10).Radius(6).Background(p.dangerSoft).Border(1, p.danger.Alpha(0.35)).Children(func() {
								ui.Text(c, a.editErr).FontSize(12).TextColor(p.danger).Grow(1)
							})
						}

						ui.Row(c).Gap(10).Justify(ui.End).Children(func() {
							ui.Button(c, "取消编辑").Padding(7, 14).Radius(6).Disabled(a.busy).OnClick(func() {
								a.requestNavigate(func() {
									a.editing = false
									a.editContent = entry.Content
									a.editErr = ""
								})
							})
							ui.PrimaryButton(c, "保存修改").Padding(7, 14).Radius(6).Disabled(a.busy).OnClick(func() {
								a.saveEdit(c, entry)
							})
						})
					} else {
						ui.Text(c, "原始内容").FontSize(12).FontWeight(600).TextColor(p.muted)
						body := entry.Content
						if body == "" {
							body = "这条记录只有图片。可添加说明，帮助自动整理。"
						}
						ui.Column(c).Selectable().Children(func() {
							ui.Text(c, body).FontSize(15).LineHeight(1.8).TextColor(p.text)
						})

						if entry.URL != "" {
							ui.Button(c, "").Label("打开原网页").Padding(5, 10).Radius(6).Background(p.accentSoft).Border(0, ui.Transparent).OnClick(func() {
								c.Services().OpenURL(entry.URL)
							}).Children(func() {
								ui.Text(c, "打开原网页").FontSize(12).TextColor(p.primary)
								ui.Icon(c, iconExternal).FontSize(13).TextColor(p.primary)
							})
						}

						ui.Box(c).Height(1).FillWidth().Background(p.border)

						ui.Row(c).Gap(10).Children(func() {
							ui.Button(c, "").Label("编辑内容").Padding(7, 14).Radius(6).OnClick(func() {
								a.editContent = entry.Content
								a.editSession++
								a.editErr = ""
								a.editing = true
							}).Children(func() {
								ui.Icon(c, iconPencil).FontSize(14).TextColor(p.text)
								ui.Text(c, "编辑内容").FontSize(13).TextColor(p.text)
							})
							ui.Spacer(c)
							ui.Button(c, "").Label("删除记录").Padding(7, 14).Radius(6).Background(p.dangerSoft).Border(1, p.danger.Alpha(0.35)).OnClick(func() {
								a.deleteDialog = true
							}).Children(func() {
								ui.Icon(c, iconTrash).FontSize(14).TextColor(p.danger)
								ui.Text(c, "删除记录").FontSize(13).TextColor(p.danger)
							})
						})
					}
				})

				// Auto-organization card
				ui.Column(c).FillWidth().Padding(20).Radius(8).Background(p.cardBg).Border(1, p.border).Gap(12).Children(func() {
					ui.Row(c).AlignItems(ui.Center).Children(func() {
						ui.Row(c).Gap(6).AlignItems(ui.Center).Grow(1).Children(func() {
							ui.Icon(c, iconSpark).FontSize(16).TextColor(p.primary)
							ui.Text(c, "自动整理").FontSize(15).Bold().TextColor(p.text)
						})
						providerLabel := "规则整理"
						switch {
						case entry.Status == model.StatusPending:
							providerLabel = "整理中"
						case entry.Provider == "openai":
							providerLabel = "OpenAI"
						case entry.Provider == "anthropic":
							providerLabel = "Anthropic"
						}
						ui.Text(c, providerLabel).FontSize(12).TextColor(p.muted).Padding(2, 8).Radius(4).Background(p.subtleBg)
					})

					summary := entry.Summary
					if entry.Status == model.StatusPending {
						summary = "原始内容已保存，摘要和标签正在整理中…"
					}
					ui.Text(c, summary).FontSize(14).LineHeight(1.7).TextColor(p.text)

					if len(entry.Tags) > 0 {
						ui.Row(c).Gap(6).Wrap().Children(func() {
							for _, tag := range entry.Tags {
								t := tag
								ui.Button(c.Key("detail-tag-"+t), "").Label("按标签筛选 "+t).Padding(3, 8).Radius(4).Background(p.accentSoft).Border(0, ui.Transparent).OnClick(func() {
									a.requestNavigate(func() {
										a.detailID = ""
										a.editing = false
										a.selectedTag = t
									})
								}).Children(func() {
									ui.Text(c, "# "+t).FontSize(12).TextColor(p.primary)
								})
							}
						})
					}

					if entry.Status == model.StatusFallback {
						ui.Text(c, "模型暂时不可用，已使用本地规则完成整理。").FontSize(12).TextColor(p.muted)
					}
					if entry.Source == model.SourceImage {
						ui.Text(c, "标签根据文字说明生成；当前版本不识别图片内容。").FontSize(12).TextColor(p.muted)
					}
					if entry.URL != "" && entry.Status != model.StatusPending && entry.Title == "" {
						ui.Text(c, "暂未获取到网页标题，原始链接已保留。").FontSize(12).TextColor(p.muted)
					}
				})
			})
		})
	})
}

func parseTimestamp(raw string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if ts, err := time.Parse(layout, raw); err == nil {
			return ts, true
		}
	}
	return time.Time{}, false
}

func formatLocalTime(raw string) string {
	ts, ok := parseTimestamp(raw)
	if !ok {
		if len(raw) >= 10 {
			return raw[:10]
		}
		return raw
	}
	return ts.Local().Format("2006-01-02 15:04")
}
