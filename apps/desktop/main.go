//go:build darwin

package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/config"
	"spark/apps/desktop/internal/gui"
	"spark/apps/desktop/internal/native"
	"spark/apps/desktop/internal/store"
	"spark/apps/desktop/internal/syncer"
)

//go:embed frontend/dist
var frontend embed.FS

//go:embed packaging/tray.png
var trayIcon []byte

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	service := cfg.CredentialService()
	sessions, err := auth.OpenSessions(auth.NewKeychainStore(service), cfg.APIBaseURL)
	if err != nil {
		return err
	}
	db, err := store.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	client, err := api.NewClient(cfg.APIBaseURL, cfg.AllowLoopbackHTTP)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	var workers sync.WaitGroup

	engine := syncer.New(db, sessions, client)
	host := &gui.Host{Store: db, API: client, Engine: engine, Sessions: sessions, Clipboard: native.NewClipboardTracker(), CopyText: native.CopyTextToClipboard, OpenURL: native.OpenSystemBrowser}
	defer func() { host.Captures.Shutdown(cancel); workers.Wait() }()
	static, err := fs.Sub(frontend, "frontend/dist")
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/local/", host.Handler())
	mux.Handle("/", http.FileServerFS(static))
	var app *application.App
	var panel, book *application.WebviewWindow
	var openBook func(string)
	app = application.New(application.Options{Name: "Spark", Description: "灵光手帐", LogLevel: slog.LevelWarn, OnShutdown: func() { host.Captures.Shutdown(cancel) },
		Assets:         application.AssetOptions{Handler: mux, DisableLogging: true},
		Mac:            application.MacOptions{ActivationPolicy: application.ActivationPolicyAccessory},
		SingleInstance: &application.SingleInstanceOptions{UniqueID: service, OnSecondInstanceLaunch: func(application.SecondInstanceData) { application.InvokeAsync(func() { openBook("") }) }},
	})
	refreshTray := func() {
		session, _ := sessions.Load()
		counts, err := db.Counts(session.AccountID)
		if err == nil {
			native.SetTrayIndicator(counts[store.OutboxLocalSaved]+counts[store.OutboxSyncing] > 0, session.Public(time.Now()).Expired || counts[store.OutboxNeedsReview]+counts[store.OutboxAuthPaused] > 0)
		}
	}
	host.Change = func() {
		if ctx.Err() != nil {
			return
		}
		refreshTray()
		application.InvokeAsync(func() {
			if panel != nil {
				signal(panel, "spark-state", nil)
			}
			if book != nil {
				signal(book, "spark-state", nil)
			}
		})
	}
	client.OnUnauthorized = func(token string) error {
		changed, err := sessions.Expire(token)
		if changed {
			host.Change()
		}
		return err
	}
	engine.SetOnChange(host.Change)
	first, _ := sessions.Load()
	panel = app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "随手记", Title: "Spark · 随手记", URL: "/?mode=panel", Width: 460, Height: 260, Hidden: first.AccountID != "", Frameless: true, DisableResize: true, BackgroundType: application.BackgroundTypeTransparent,
		Mac: application.MacWindow{WindowClass: application.MacWindowClassPanel, PanelPreferences: application.MacPanelPreferences{NonActivating: true, FloatingPanel: true}, Backdrop: application.MacBackdropTransparent, WindowLevel: application.MacWindowLevelFloating, CollectionBehavior: application.MacWindowCollectionBehaviorCanJoinAllSpaces | application.MacWindowCollectionBehaviorFullScreenAuxiliary}})
	host.PanelVisible = func() bool { return application.InvokeSyncWithResult(panel.IsVisible) }
	hide := func() { panel.Hide(); native.RestoreFrontApp() }
	panelHeight := 260
	show := func() {
		if ctx.Err() != nil {
			return
		}
		engine.RequestCatalog()
		if !panel.IsVisible() {
			native.RememberFrontApp()
		}
		native.PositionPanel(panel.NativeWindow(), panelHeight)
		panel.Show()
		panel.Focus()
		signal(panel, "spark-show", nil)
	}
	panel.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) { e.Cancel(); hide() })
	panel.OnWindowEvent(events.Common.WindowLostFocus, func(e *application.WindowEvent) {
		application.InvokeAsync(func() {
			if panel.IsVisible() && !panel.IsFocused() {
				panel.Hide()
			}
		})
	})
	openBook = func(id string) {
		panel.Hide()
		native.SetDockVisible(true)
		if book == nil {
			path := "/?mode=main&id=" + url.QueryEscape(id)
			// CSS marks the two title-bar drag regions and excludes their controls.
			book = app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "灵光手帐", Title: "Spark · 灵光手帐", URL: path, Width: 1080, Height: 740, MinWidth: 720, MinHeight: 500, Mac: application.MacWindow{TitleBar: application.MacTitleBarHiddenInset, CollectionBehavior: application.MacWindowCollectionBehaviorMoveToActiveSpace | application.MacWindowCollectionBehaviorFullScreenPrimary}})
			current := book
			closingFullscreen := false
			current.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
				if current.IsFullscreen() {
					e.Cancel()
					closingFullscreen = true
					current.UnFullscreen()
					return
				}
				application.InvokeAsync(func() {
					if book == current {
						book = nil
						native.SetDockVisible(false)
					}
				})
			})
			current.OnWindowEvent(events.Mac.WindowDidExitFullScreen, func(e *application.WindowEvent) {
				if closingFullscreen {
					current.Close()
				}
			})
		} else if id != "" {
			signal(book, "spark-detail", id)
		}
		book.Show()
		book.Focus()
	}
	tray := app.SystemTray.New()
	tray.SetTemplateIcon(trayIcon)
	tray.SetTooltip("Spark · 随手记")
	toggle := func() {
		application.InvokeAsync(func() {
			if panel.IsVisible() {
				hide()
			} else if book != nil && book.IsFocused() {
				signal(book, "spark-compose", nil)
			} else {
				show()
			}
		})
	}
	tray.OnClick(func() {
		application.InvokeAsync(func() {
			if panel.IsVisible() {
				hide()
				return
			}
			show()
			if err := tray.PositionWindow(panel, 6); err != nil {
				native.PositionPanel(panel.NativeWindow(), panelHeight)
			} else {
				native.ResizePanel(panel.NativeWindow(), panelHeight)
			}
		})
	})
	menu := app.NewMenu()
	menu.Add("随手记").OnClick(func(*application.Context) { application.InvokeAsync(show) })
	menu.Add("打开灵光手帐").OnClick(func(*application.Context) { application.InvokeAsync(func() { openBook("") }) })
	menu.AddSeparator()
	menu.Add("退出 Spark").OnClick(func(*application.Context) { app.Quit() })
	tray.SetMenu(menu)
	tray.OnRightClick(tray.OpenMenu)
	var taking atomic.Bool
	screenshot := func() {
		application.InvokeAsync(func() {
			if ctx.Err() != nil || !taking.CompareAndSwap(false, true) {
				return
			}
			if !host.Captures.Begin() {
				taking.Store(false)
				return
			}
			was := panel.IsVisible()
			owner, _ := sessions.Load()
			if owner.AccountID == "" {
				host.Captures.Done()
				taking.Store(false)
				show()
				return
			}
			panel.Hide()
			go func() {
				defer host.Captures.Done()
				defer taking.Store(false)
				data, err := native.CaptureInteractiveScreenshot(ctx)
				if ctx.Err() != nil {
					return
				}
				application.InvokeAsync(func() {
					if ctx.Err() != nil {
						return
					}
					current, _ := sessions.Load()
					if current.AccountID != owner.AccountID {
						return
					}
					if was || len(data) > 0 || err != nil {
						show()
					}
					if err != nil {
						signal(panel, "spark-error", err.Error())
					} else if len(data) > 0 {
						signal(panel, "spark-image", map[string]any{"account": owner.AccountID, "data": data, "filename": "选区截图.png"})
					}
				})
			}()
		})
	}

	var shortcutMu sync.Mutex
	host.Rebind = func(kind, value string) error {
		shortcutMu.Lock()
		defer shortcutMu.Unlock()
		fn := toggle
		original := "Option+Space"
		if kind == "screenshot" {
			fn = screenshot
			original = "Option+Shift+4"
		}
		old := db.GetPref(kind+"_key", original)
		if old == value {
			return nil
		}
		if err := app.GlobalShortcut.Register(value, fn); err != nil {
			return errors.New("快捷键已被占用，请选择其他组合")
		}
		if err := db.SetPref(kind+"_key", value); err != nil {
			_ = app.GlobalShortcut.Unregister(value)
			return err
		}
		if app.GlobalShortcut.IsRegistered(old) {
			return app.GlobalShortcut.Unregister(old)
		}
		return nil
	}
	host.Action = func(act, arg string) error {
		switch act {
		case "panel":
			application.InvokeAsync(show)
		case "hide":
			application.InvokeAsync(hide)
		case "main":
			application.InvokeAsync(func() { openBook(arg) })
		case "screenshot":
			screenshot()
		case "settings":
			return native.OpenSystemBrowser("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
		case "resize":
			n, e := strconv.Atoi(arg)
			if e != nil {
				return e
			}
			application.InvokeAsync(func() {
				panelHeight = min(560, max(n, 80))
				native.ResizePanel(panel.NativeWindow(), panelHeight)
			})
		}
		return nil
	}
	drop := func(text string, paths []string, png []byte) bool {
		if !host.Captures.Begin() {
			return false
		}
		owner, err := sessions.Load()
		if err != nil {
			host.Captures.Done()
			application.InvokeAsync(show)
			return false
		}
		go func() {
			defer host.Captures.Done()
			in := store.EnqueueInput{AccountID: owner.AccountID, RawText: text}
			if len(png) > 0 {
				in.Attachments = []store.PendingAttachmentInput{{Filename: "拖入图片.png", Data: png}}
			}
			if len(paths) > api.MaxImagesPerCol {
				err = errors.New("单条收藏最多附带 9 张图片。")
			}
			for _, path := range paths {
				if err != nil {
					break
				}
				var raw []byte
				raw, err = readImage(path)
				if err == nil {
					in.Attachments = append(in.Attachments, store.PendingAttachmentInput{Filename: filepath.Base(path), Data: raw})
				}
			}
			if err == nil {
				_, err = host.Capture(in)
			}
			if ctx.Err() != nil {
				return
			}
			application.InvokeAsync(func() {
				if ctx.Err() != nil {
					return
				}
				if err != nil {
					show()
					signal(panel, "spark-error", "无法收下拖入的内容，请检查图片格式、大小和数量。")
					return
				}
				tray.SetLabel("✓")
				time.AfterFunc(450*time.Millisecond, func() {
					if ctx.Err() == nil {
						tray.SetLabel("")
					}
				})
			})
		}()
		return true
	}
	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		workers.Add(2)
		go func() { defer workers.Done(); refreshTray(); engine.Run(ctx) }()
		go func() {
			defer workers.Done()
			count := native.ClipboardCount()
			host.Clipboard.Observe(count, time.Now())
			t := time.NewTicker(time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					next := native.ClipboardCount()
					if next != count {
						count = next
						host.Clipboard.Observe(next, time.Now())
					}
				}
			}
		}()
		native.RegisterTrayDropHandlers(func(t string) bool { return drop(t, nil, nil) }, func(p []string) bool { return drop("", p, nil) }, func(data []byte) bool { return drop("", nil, data) }, func() { application.InvokeAsync(show) })
		for _, binding := range []struct {
			key string
			fn  func()
		}{{db.GetPref("capture_key", "Option+Space"), toggle}, {db.GetPref("screenshot_key", "Option+Shift+4"), screenshot}} {
			if err := app.GlobalShortcut.Register(binding.key, binding.fn); err != nil {
				tray.SetTooltip("快捷键已被占用，可点菜单栏瓶子打开随手记")
				log.Print("无法注册桌面快捷键 ", binding.key)
			}
		}
	})
	return app.Run()
}
func signal(w *application.WebviewWindow, name string, data any) {
	raw, err := json.Marshal(data)
	if err == nil {
		w.ExecJS(fmt.Sprintf("window.dispatchEvent(new CustomEvent(%q,{detail:%s}))", name, raw))
	}
}
func readImage(path string) ([]byte, error) {
	// Inspect special files without waiting for a FIFO writer during shutdown.
	f, e := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > api.MaxImageBytes {
		return nil, errors.New("请选择 5 MiB 以内的图片文件")
	}
	return io.ReadAll(io.LimitReader(f, api.MaxImageBytes+1))
}
