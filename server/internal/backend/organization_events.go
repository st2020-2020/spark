package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

const (
	organizationEventsPath     = "/api/v1/organization/events"
	maxOrganizationStreams     = 256
	maxUserOrganizationStreams = 6
	organizationStreamBuffer   = 16
)

type organizationSubscription struct {
	session string
	events  chan contract.OrganizationEvent
	done    chan struct{}
}

type organizationHub struct {
	mu     sync.Mutex
	online bool
	count  int
	users  map[string]map[*organizationSubscription]struct{}
}

func newOrganizationHub() *organizationHub {
	return &organizationHub{users: make(map[string]map[*organizationSubscription]struct{})}
}

func (h *organizationHub) subscribe(user, session string) (*organizationSubscription, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.online {
		return nil, problem(503, "service_unavailable", "实时更新暂不可用，请稍后重试。")
	}
	if h.count >= maxOrganizationStreams || len(h.users[user]) >= maxUserOrganizationStreams {
		return nil, problem(429, "rate_limited", "实时连接数已达上限。")
	}
	if h.users[user] == nil {
		h.users[user] = make(map[*organizationSubscription]struct{})
	}
	sub := &organizationSubscription{session: session, events: make(chan contract.OrganizationEvent, organizationStreamBuffer), done: make(chan struct{})}
	h.users[user][sub] = struct{}{}
	h.count++
	return sub, nil
}

func (h *organizationHub) remove(user string, sub *organizationSubscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeLocked(user, sub)
}

func (h *organizationHub) removeLocked(user string, sub *organizationSubscription) {
	if _, exists := h.users[user][sub]; !exists {
		return
	}
	delete(h.users[user], sub)
	if len(h.users[user]) == 0 {
		delete(h.users, user)
	}
	h.count--
	stopOrganizationStream(sub)
}

// Closing streams still count toward limits until their handlers return.
func stopOrganizationStream(sub *organizationSubscription) {
	if !streamClosed(sub.done) {
		close(sub.done)
	}
}

func (h *organizationHub) setOnline(online bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.online = online
	if !online {
		for _, subs := range h.users {
			for sub := range subs {
				stopOrganizationStream(sub)
			}
		}
	}
}

type organizationNotification struct {
	Schema       string     `json:"schema"`
	UserID       uuid.UUID  `json:"user_id"`
	CloseUser    bool       `json:"close_user"`
	CloseSession *uuid.UUID `json:"close_session"`
	Resync       bool       `json:"resync"`
	contract.OrganizationEvent
}

func (h *organizationHub) dispatch(schema, payload string) {
	var n organizationNotification
	if err := json.Unmarshal([]byte(payload), &n); err != nil || n.Schema != schema || n.UserID == uuid.Nil {
		return
	}
	closeStreams := n.CloseUser || n.CloseSession != nil || n.Resync
	if !closeStreams {
		switch n.Status {
		case "queued", "running", "succeeded", "partial", "failed", "skipped", "blocked", "superseded":
		default:
			return
		}
		if n.CollectionId == uuid.Nil {
			return
		}
	}
	user := n.UserID.String()
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.users[user] {
		if streamClosed(sub.done) {
			continue
		}
		if closeStreams {
			if n.CloseUser || n.Resync || n.CloseSession.String() == sub.session {
				stopOrganizationStream(sub)
			}
			continue
		}
		select {
		case sub.events <- n.OrganizationEvent:
		default:
			// A reconnect and its ready event repair missed invalidations.
			stopOrganizationStream(sub)
		}
	}
}

// RunOrganizationEvents owns one dedicated LISTEN connection for this API process.
func (s *Server) RunOrganizationEvents(ctx context.Context) {
	for ctx.Err() == nil {
		err := s.listenOrganizationEvents(ctx)
		if ctx.Err() != nil {
			return
		}
		slog.Warn("organization listener reconnecting", "error_type", fmt.Sprintf("%T", err))
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (s *Server) listenOrganizationEvents(ctx context.Context) error {
	connect, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(connect, s.Pool.Config().ConnConfig.Copy())
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = conn.Close(closeCtx)
	}()
	var schema string
	if err := conn.QueryRow(connect, "SELECT current_schema()").Scan(&schema); err != nil {
		return err
	}
	if _, err := conn.Exec(connect, "LISTEN spark_organization_events"); err != nil {
		return err
	}
	s.events.setOnline(true)
	defer s.events.setOnline(false)
	for {
		wait, cancel := context.WithTimeout(ctx, 10*time.Second)
		n, err := conn.WaitForNotification(wait)
		cancel()
		if err == nil {
			s.events.dispatch(schema, n.Payload)
			continue
		}
		if ctx.Err() != nil || !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		// A probe detects half-open connections without querying per subscriber.
		probe, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = conn.Ping(probe)
		cancel()
		if err != nil {
			return err
		}
	}
}

func (s *Server) crossOriginRead(c *gin.Context) bool {
	origin, site := c.GetHeader("Origin"), c.GetHeader("Sec-Fetch-Site")
	return (origin != "" && origin != s.Config.Origin) || site == "cross-site" || site == "same-site"
}

func (s *Server) organizationEvents(c *gin.Context) (any, error) {
	if s.crossOriginRead(c) {
		return nil, problem(403, "forbidden", "实时更新仅支持同源连接。")
	}
	session := current(c)
	user := session.User.ID
	sub, err := s.events.subscribe(user, session.ID)
	if err != nil {
		return nil, err
	}
	defer s.events.remove(user, sub)
	// Subscribe before rechecking to cover revocation between authentication
	// and registration with the hub, without polling active sessions.
	check, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	var expires time.Time
	err = s.Pool.QueryRow(check, `SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`, session.ID, user).Scan(&expires)
	cancel()
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem(401, "session_expired", "请重新登录。")
	}
	if err != nil {
		return nil, err
	}
	if streamClosed(sub.done) {
		return nil, problem(503, "service_unavailable", "请重新连接实时更新。")
	}

	var target http.ResponseWriter = c.Writer
	if unwrapped, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		target = unwrapped.Unwrap()
	}
	writer := http.NewResponseController(target)
	if err := writer.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, problem(503, "service_unavailable", "当前连接不支持实时更新。")
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-store, no-transform")
	c.Header("X-Accel-Buffering", "no")
	// Finite streams refresh authentication even if an intermediary hides a disconnect.
	deadline := time.NewTimer(min(time.Until(expires), 5*time.Minute))
	defer deadline.Stop()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	send := func(frame string) bool {
		if streamClosed(sub.done) || c.Request.Context().Err() != nil || !time.Now().Before(expires) {
			return false
		}
		if err := writer.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return false
		}
		if _, err := io.WriteString(c.Writer, frame); err != nil {
			return false
		}
		if err := writer.Flush(); err != nil {
			return false
		}
		return writer.SetWriteDeadline(time.Time{}) == nil
	}
	if !send("retry: 3000\nevent: ready\ndata: {}\n\n") {
		return nil, nil
	}
	for {
		select {
		case <-c.Request.Context().Done():
			return nil, nil
		case <-sub.done:
			return nil, nil
		case <-deadline.C:
			return nil, nil
		case <-heartbeat.C:
			if !send(": heartbeat\n\n") {
				return nil, nil
			}
		case event := <-sub.events:
			if !send("event: organization\ndata: " + string(jsonBytes(event)) + "\n\n") {
				return nil, nil
			}
		}
	}
}

func streamClosed(done <-chan struct{}) bool {
	select {
	case <-done:
		return true
	default:
		return false
	}
}
