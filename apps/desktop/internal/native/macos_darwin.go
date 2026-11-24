//go:build darwin

package native

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit -framework CoreGraphics
#include <stdlib.h>
void sparkRememberFrontApp(void);
void sparkRestoreFrontApp(void);
void sparkSetDockVisible(int);
int sparkReadClipboard(int*,int*,char**,void**,size_t*);
int sparkCopyText(const char*,size_t);
void sparkAttachTrayDrop(void);
void sparkTrayState(int);
int sparkCopyImage(void *,size_t);
int sparkRequestScreenAccess(void);
int sparkClipboardCount(void);
#include <CoreGraphics/CoreGraphics.h>
CGRect sparkPanelFrame(void *);
CGRect sparkPanelVisibleFrame(void *,int);
void sparkApplyPanelFrame(void *,CGRect,int);

*/
import "C"

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"spark/apps/desktop/internal/api"
)

var (
	callbackMu        sync.RWMutex
	onTrayDropTextCB  func(text string) bool
	onTrayDropFilesCB func(paths []string) bool
	onTrayDropImageCB func([]byte) bool
	onTrayHoverExpand func()
)

//export sparkGoTrayDropText
func sparkGoTrayDropText(cText *C.char) C.int {
	if cText == nil {
		return 0
	}
	text := C.GoString(cText)
	callbackMu.RLock()
	fn := onTrayDropTextCB
	callbackMu.RUnlock()
	if fn != nil {
		if fn(text) {
			return 1
		}
	}
	return 0
}

//export sparkGoTrayDropFiles
func sparkGoTrayDropFiles(cJoined *C.char) C.int {
	if cJoined == nil {
		return 0
	}
	var paths []string
	if json.Unmarshal([]byte(C.GoString(cJoined)), &paths) != nil {
		return 0
	}
	callbackMu.RLock()
	fn := onTrayDropFilesCB
	callbackMu.RUnlock()
	if fn != nil && len(paths) > 0 {
		if fn(paths) {
			return 1
		}
	}
	return 0
}

//export sparkGoTrayDropImage
func sparkGoTrayDropImage(data unsafe.Pointer, size C.size_t) C.int {
	if data == nil || size == 0 || size > api.MaxImageBytes {
		return 0
	}
	callbackMu.RLock()
	fn := onTrayDropImageCB
	callbackMu.RUnlock()
	if fn != nil {
		b := C.GoBytes(data, C.int(size))
		if fn(b) {
			return 1
		}
	}
	return 0
}

//export sparkGoTrayHoverExpand
func sparkGoTrayHoverExpand() {
	callbackMu.RLock()
	fn := onTrayHoverExpand
	callbackMu.RUnlock()
	if fn != nil {
		fn()
	}
}

func RegisterTrayDropHandlers(onText func(string) bool, onFiles func([]string) bool, onImage func([]byte) bool, onHover func()) {
	callbackMu.Lock()
	onTrayDropTextCB = onText
	onTrayDropFilesCB = onFiles
	onTrayDropImageCB = onImage
	onTrayHoverExpand = onHover
	callbackMu.Unlock()
	C.sparkAttachTrayDrop()
}

func SetTrayIndicator(pending, attention bool) {
	state := 0
	if attention {
		state = 2
	} else if pending {
		state = 1
	}
	C.sparkTrayState(C.int(state))
}

func RememberFrontApp()   { C.sparkRememberFrontApp() }
func RestoreFrontApp()    { C.sparkRestoreFrontApp() }
func ClipboardCount() int { return int(C.sparkClipboardCount()) }

func SetDockVisible(visible bool) {
	if visible {
		C.sparkSetDockVisible(1)
	} else {
		C.sparkSetDockVisible(0)
	}
}

func ReadClipboardSample() RawClipboardSample {
	var changeCount, concealed C.int
	var cText *C.char
	var cPNG unsafe.Pointer
	var pngLen C.size_t

	C.sparkReadClipboard(&changeCount, &concealed, &cText, &cPNG, &pngLen)
	sample := RawClipboardSample{
		ChangeCount: int(changeCount),
		Concealed:   concealed != 0,
	}
	if cText != nil {
		sample.Text = strings.TrimSpace(C.GoString(cText))
		C.free(unsafe.Pointer(cText))
		sample.URL = api.ExtractFirstURL(sample.Text)
	}
	if cPNG != nil && pngLen > 0 {
		sample.ImagePNG = C.GoBytes(cPNG, C.int(pngLen))
		C.free(cPNG)
	}
	return sample
}

func CopyTextToClipboard(text string) bool {
	cStr := C.CString(text)
	defer C.free(unsafe.Pointer(cStr))
	return C.sparkCopyText(cStr, C.size_t(len(text))) != 0
}

// CaptureInteractiveScreenshot invokes macOS native region screencapture (-i -x).
// Returns (nil, nil) if the user cancels with Escape.
func CaptureInteractiveScreenshot(ctx context.Context) ([]byte, error) {
	return captureInteractiveScreenshot(ctx, "/usr/sbin/screencapture")
}

func captureInteractiveScreenshot(ctx context.Context, executable string) ([]byte, error) {
	tmpDir, err := os.MkdirTemp("", "spark-shot-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	outPath := filepath.Join(tmpDir, "screenshot.png")
	cmd := exec.CommandContext(ctx, executable, "-i", "-x", "-t", "png", outPath)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return interactiveScreenshotResult(outPath, runErr, stderr.String(), func() bool {
		return C.sparkRequestScreenAccess() != 0
	})
}

func interactiveScreenshotResult(path string, runErr error, stderr string, requestAccess func() bool) ([]byte, error) {
	f, err := os.Open(path)
	if err == nil {
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, api.MaxImageBytes+1))
		if err != nil {
			return nil, err
		}
		if len(data) > 0 || strings.TrimSpace(stderr) == "" {
			mime, _, err := api.ValidateImageBytes(data, "screenshot.png")
			if err != nil {
				return nil, err
			}
			if mime != "image/png" {
				return nil, errors.New("选区截图不是 PNG 图片，请重新截取。")
			}
			return data, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	// Escape can produce either a successful exit or exit status 1 with no
	// output. A launch error or a signal is not an interactive cancellation.
	var exitErr *exec.ExitError
	if runErr != nil && (!errors.As(runErr, &exitErr) || exitErr.ExitCode() < 0) {
		return nil, fmt.Errorf("无法运行系统截屏工具：%w", runErr)
	}
	if detail := strings.TrimSpace(stderr); detail != "" {
		if !requestAccess() {
			return nil, errors.New("需要开启系统“屏幕录制”权限才能使用选区截屏。")
		}
		return nil, fmt.Errorf("系统截屏未完成：%s", detail)
	}
	return nil, nil
}

// OpenSystemBrowser opens a validated URL in the user's default macOS browser.
func OpenSystemBrowser(rawURL string) error {
	return exec.Command("/usr/bin/open", rawURL).Run()
}

// AppKit coordinates grow upwards. Prefer the current top edge, moving it
// only as far as necessary to keep the entire panel inside the usable screen.
type panelRect struct{ x, y, w, h float64 }

func fitPanel(frame, area panelRect, height float64, atMouse bool) panelRect {
	w, h := min(460, area.w), min(height, area.h)
	x, top := frame.x, frame.y+frame.h
	if atMouse {
		x = area.x + (area.w-w)/2
		top = area.y + area.h*.78
	}
	return panelRect{max(area.x, min(x, area.x+area.w-w)), max(area.y, min(top-h, area.y+area.h-h)), w, h}
}
func panelFrame(win unsafe.Pointer, height int, atMouse bool) {
	if win == nil {
		return
	}
	var mouse C.int
	if atMouse {
		mouse = 1
	}
	rect := func(r C.CGRect) panelRect {
		return panelRect{float64(r.origin.x), float64(r.origin.y), float64(r.size.width), float64(r.size.height)}
	}
	frame, area := rect(C.sparkPanelFrame(win)), rect(C.sparkPanelVisibleFrame(win, mouse))
	if area.w <= 0 || area.h <= 0 {
		return
	}
	next := fitPanel(frame, area, float64(height), atMouse)
	C.sparkApplyPanelFrame(win, C.CGRectMake(C.CGFloat(next.x), C.CGFloat(next.y), C.CGFloat(next.w), C.CGFloat(next.h)), 1-mouse)
}
func PositionPanel(win unsafe.Pointer, height int) { panelFrame(win, height, true) }
func ResizePanel(win unsafe.Pointer, height int)   { panelFrame(win, height, false) }

func CopyImage(data []byte) error {
	if len(data) == 0 || C.sparkCopyImage(unsafe.Pointer(&data[0]), C.size_t(len(data))) == 0 {
		return errors.New("图片无法复制")
	}
	return nil
}
