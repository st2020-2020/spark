package main

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestDropRejectsFIFOWithoutWaitingForWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "picture.png")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := readImage(path); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("accepted special file")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("drop blocked waiting for a writer")
	}
}
