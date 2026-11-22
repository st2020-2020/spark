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
void sparkCopyText(const char*);
void sparkAttachTrayDrop(void);
void sparkTrayState(int);
int sparkCopyImage(void *,size_t);
int sparkScreenAllowed(void);
int sparkClipboardCount(void);
void sparkPositionPanel(void *);
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
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
	onTrayDropTextCB  func(text string)
	onTrayDropFilesCB func(paths []string)
	onTrayDropImageCB func([]byte)
	onTrayHoverExpand func()
)

//export sparkGoTrayDropText
func sparkGoTrayDropText(cText *C.char) {
	if cText == nil {
		return
	}
	text := C.GoString(cText)
	callbackMu.RLock()
	fn := onTrayDropTextCB
	callbackMu.RUnlock()
	if fn != nil {
		go fn(text)
	}
}

//export sparkGoTrayDropFiles
func sparkGoTrayDropFiles(cJoined *C.char) {
	if cJoined == nil {
		return
	}
	var paths []string
	if json.Unmarshal([]byte(C.GoString(cJoined)), &paths) != nil {
		return
	}
	callbackMu.RLock()
	fn := onTrayDropFilesCB
	callbackMu.RUnlock()
	if fn != nil && len(paths) > 0 {
		go fn(paths)
	}
}

//export sparkGoTrayDropImage
func sparkGoTrayDropImage(data unsafe.Pointer, size C.size_t) {
	if data == nil || size == 0 || size > api.MaxImageBytes {
		return
	}
	callbackMu.RLock()
	fn := onTrayDropImageCB
	callbackMu.RUnlock()
	if fn != nil {
		b := C.GoBytes(data, C.int(size))
		go fn(b)
	}
}

//export sparkGoTrayHoverExpand
func sparkGoTrayHoverExpand() {
	callbackMu.RLock()
	fn := onTrayHoverExpand
	callbackMu.RUnlock()
	if fn != nil {
		go fn()
	}
}

func RegisterTrayDropHandlers(onText func(string), onFiles func([]string), onImage func([]byte), onHover func()) {
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

func CopyTextToClipboard(text string) {
	cStr := C.CString(text)
	defer C.free(unsafe.Pointer(cStr))
	C.sparkCopyText(cStr)
}

// CaptureInteractiveScreenshot invokes macOS native region screencapture (-i -x).
// Returns (nil, nil) if the user cancels with Escape.
func CaptureInteractiveScreenshot(ctx context.Context) ([]byte, error) {
	if C.sparkScreenAllowed() == 0 {
		return nil, errors.New("需要开启系统“屏幕录制”权限才能使用选区截屏。")
	}
	tmpDir, err := os.MkdirTemp("", "spark-shot-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)

	outPath := filepath.Join(tmpDir, "screenshot.png")
	cmd := exec.CommandContext(ctx, "/usr/sbin/screencapture", "-i", "-x", "-t", "png", outPath)
	if err := cmd.Run(); err != nil {
		// Exit code 1 or missing file indicates user cancelled with Esc.
		if _, statErr := os.Stat(outPath); os.IsNotExist(statErr) {
			return nil, nil
		}
		return nil, err
	}
	f, err := os.Open(outPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, api.MaxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if _, _, err := api.ValidateImageBytes(data, "screenshot.png"); err != nil {
		return nil, err
	}
	return data, nil
}

// OpenSystemBrowser opens a validated URL in the user's default macOS browser.
func OpenSystemBrowser(rawURL string) error {
	return exec.Command("/usr/bin/open", rawURL).Run()
}

func PositionPanel(win unsafe.Pointer) { C.sparkPositionPanel(win) }

func CopyImage(data []byte) error {
	if len(data) == 0 || C.sparkCopyImage(unsafe.Pointer(&data[0]), C.size_t(len(data))) == 0 {
		return errors.New("图片无法复制")
	}
	return nil
}
