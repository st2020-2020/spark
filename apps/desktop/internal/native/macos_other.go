//go:build !darwin

package native

import (
	"context"
	"errors"
)

func RegisterTrayDropHandlers(_ func(string) bool, _ func([]string) bool, _ func([]byte) bool, _ func()) {
}
func RememberFrontApp()                       {}
func RestoreFrontApp()                        {}
func SetDockVisible(_ bool)                   {}
func ReadClipboardSample() RawClipboardSample { return RawClipboardSample{} }
func CopyTextToClipboard(_ string) bool       { return false }
func CaptureInteractiveScreenshot(_ context.Context) ([]byte, error) {
	return nil, errors.New("interactive screenshot is only supported on macOS")
}
func OpenSystemBrowser(_ string) error {
	return errors.New("system browser open is only supported on macOS")
}

func ClipboardCount() int      { return 0 }
func CopyImage(_ []byte) error { return errors.New("需要 macOS 系统剪贴板") }
