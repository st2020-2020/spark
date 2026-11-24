//go:build darwin

package native

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestQuitReapsScreenshotAndRemovesTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	tool := filepath.Join(dir, "capture")
	ready := filepath.Join(dir, "ready")
	t.Setenv("SPARK_TEST_READY", ready)
	if err := os.WriteFile(tool, []byte("#!/bin/sh\nprintf '%s' \"$5\" > \"$SPARK_TEST_READY\"\nexec /bin/sleep 60\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := captureInteractiveScreenshot(ctx, tool); done <- err }()
	var output []byte
	for len(output) == 0 {
		if ctx.Err() != nil {
			t.Fatal("capture did not start")
		}
		output, _ = os.ReadFile(ready)
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("unexpected exit: %v", err)
	}
	if _, err := os.Stat(filepath.Dir(string(output))); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("temporary screenshot directory remains", err)
	}
}

func TestPanelFitsScreenVisibleFrame(t *testing.T) {
	for _, tt := range []struct {
		name        string
		frame, area panelRect
		height      float64
		mouse       bool
		want        panelRect
	}{
		{"preserve top", panelRect{100, 400, 460, 170}, panelRect{0, 40, 1280, 680}, 300, false, panelRect{100, 270, 460, 300}},
		{"short secondary display", panelRect{-500, 110, 460, 178}, panelRect{-640, 60, 640, 300}, 560, false, panelRect{-500, 60, 460, 300}},
		{"dock on left", panelRect{}, panelRect{48, -250, 400, 250}, 560, true, panelRect{48, -250, 400, 250}},
		{"move to taller display", panelRect{-500, 60, 460, 300}, panelRect{0, 40, 1280, 800}, 560, true, panelRect{410, 104, 460, 560}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := fitPanel(tt.frame, tt.area, tt.height, tt.mouse); got != tt.want {
				t.Fatalf("frame %+v want %+v", got, tt.want)
			}
		})
	}
}

func TestFrontAppSamplePrecedesActivation(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "front-app")
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "xcrun", "clang", "-fobjc-arc", "-framework", "Cocoa", "-framework", "WebKit", "-framework", "CoreGraphics", "desktop_darwin.m", "testdata/front_app.m", "-o", executable)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("compile AppKit test: %v\n%s", err, out)
	}
	if out, err := exec.CommandContext(ctx, executable).CombinedOutput(); err != nil {
		t.Fatalf("focus restoration: %v\n%s", err, out)
	}
}
