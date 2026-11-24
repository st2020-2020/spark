package gui

import "sync"

// CaptureTasks reserves work before a native drop is acknowledged or a bridge
// request reads attachments. Shutdown closes admission before waiting for disk I/O.
type CaptureTasks struct {
	mu     sync.Mutex
	closed bool
	active sync.WaitGroup
}

func (c *CaptureTasks) Begin() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.active.Add(1)
	return true
}

func (c *CaptureTasks) Done() { c.active.Done() }

func (c *CaptureTasks) Shutdown(cancel func()) {
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	cancel()
	c.active.Wait()
}
