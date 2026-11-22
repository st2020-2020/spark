//go:build darwin

package native

import (
	"bytes"
	"errors"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInteractiveScreenshotResult(t *testing.T) {
	var valid bytes.Buffer
	if err := png.Encode(&valid, image.NewGray(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	// Model the utility's nonzero exit without entering interactive capture.
	exitErr := exec.Command("/usr/bin/false").Run()
	if _, ok := exitErr.(*exec.ExitError); !ok {
		t.Fatalf("expected an exit status, got %v", exitErr)
	}

	for _, tt := range []struct {
		name          string
		file          []byte
		runErr        error
		stderr        string
		accessGranted bool
		wantRequest   bool
		wantPNG       bool
		wantError     string
	}{
		{name: "valid PNG wins over exit status and stderr", file: valid.Bytes(), runErr: exitErr, stderr: "diagnostic", wantPNG: true},
		{name: "silent cancellation"},
		{name: "silent nonzero cancellation", runErr: exitErr, stderr: "\n"},
		{name: "denied", runErr: exitErr, stderr: "could not create image from display", wantRequest: true, wantError: "屏幕录制"},
		{name: "empty file with diagnostic", file: []byte{}, stderr: "permission denied", wantRequest: true, wantError: "屏幕录制"},
		{name: "system failure with permission", runErr: exitErr, stderr: "display unavailable", wantRequest: true, accessGranted: true, wantError: "display unavailable"},
		{name: "tool could not start", runErr: os.ErrNotExist, wantError: "无法运行系统截屏工具"},
		{name: "empty file without diagnostic", file: []byte{}, wantError: "图片内容为空"},
		{name: "wrong image type", file: []byte("GIF89a"), wantError: "不是 PNG"},
		{name: "unrecognised file", file: []byte("text"), wantError: "仅支持"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "screenshot.png")
			if tt.file != nil {
				if err := os.WriteFile(path, tt.file, 0600); err != nil {
					t.Fatal(err)
				}
			}
			requested := false
			data, err := interactiveScreenshotResult(path, tt.runErr, tt.stderr, func() bool {
				requested = true
				return tt.accessGranted
			})
			if requested != tt.wantRequest || (data != nil) != tt.wantPNG || (tt.wantPNG && !bytes.Equal(data, valid.Bytes())) {
				t.Fatalf("requested=%v, PNG bytes=%d", requested, len(data))
			}
			if (err == nil) != (tt.wantError == "") || (err != nil && !strings.Contains(err.Error(), tt.wantError)) {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.runErr == os.ErrNotExist && !errors.Is(err, os.ErrNotExist) {
				t.Fatal("missing cause of launch failure")
			}
		})
	}
}
