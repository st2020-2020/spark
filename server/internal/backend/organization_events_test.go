package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/server/internal/contract"
)

type eventFrame struct{ name, data string }

func openOrganizationStream(t *testing.T, user *apiClient, base string) <-chan eventFrame {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+organizationEventsPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	res, err := (&http.Client{Jar: user.http.Jar}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" || res.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("unexpected stream response: %d", res.StatusCode)
	}
	frames := make(chan eventFrame, 32)
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(res.Body)
		frame := eventFrame{}
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				frame.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				frame.data = strings.TrimPrefix(line, "data: ")
			case strings.HasPrefix(line, ": heartbeat"):
				frame.name = "heartbeat"
			case line == "" && frame.name != "":
				select {
				case frames <- frame:
				case <-ctx.Done():
					return
				}
				frame = eventFrame{}
			}
		}
	}()
	return frames
}

func nextOrganizationFrame(t *testing.T, frames <-chan eventFrame, wait time.Duration) eventFrame {
	t.Helper()
	select {
	case frame, ok := <-frames:
		if !ok {
			t.Fatal("SSE closed before next event")
		}
		return frame
	case <-time.After(wait):
		t.Fatal("SSE event timed out")
	}
	return eventFrame{}
}

func expectOrganizationStreamClosed(t *testing.T, frames <-chan eventFrame) {
	t.Helper()
	select {
	case frame, ok := <-frames:
		if ok {
			t.Fatalf("received unexpected frame: %s", frame.name)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("SSE did not close")
	}
}

func startOrganizationListener(t *testing.T, app *Server) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); app.RunOrganizationEvents(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		app.events.mu.Lock()
		online := app.events.online
		app.events.mu.Unlock()
		if online {
			return cancel
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("organization listener unavailable")
	return cancel
}

func expectReady(t *testing.T, frames <-chan eventFrame) {
	t.Helper()
	if v := nextOrganizationFrame(t, frames, 4*time.Second); v.name != "ready" || v.data != "{}" {
		t.Fatal("missing ready compensation event")
	}
}

func TestOrganizationStreamAndPendingSuggestions(t *testing.T) {
	app, base := testBackend(t)
	app.Organizer.Enabled = true
	ctx := context.Background()
	for _, email := range []string{"stream-a@example.test", "stream-b@example.test"} {
		if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
			t.Fatal(err)
		}
	}
	a, b := newClient(t, app, base), newClient(t, app, base)
	a.signIn("stream-a@example.test")
	b.signIn("stream-b@example.test")
	stopListener := startOrganizationListener(t, app)
	newClient(t, app, base).do("GET", "/organization/events", nil, "").want(t, 401)
	a.withHeaders("GET", "/organization/events", nil, "", map[string]string{"Origin": "https://foreign.example.test"}).want(t, 403)
	a.withHeaders("GET", "/organization/events", nil, "", map[string]string{"Sec-Fetch-Site": "same-site"}).want(t, 403)
	session := a.do("GET", "/auth/session", nil, "").want(t, 200)
	if session["ai_trial_eligible"] != true || session["ai_platform_enabled"] != true {
		t.Fatal("session did not report platform capabilities")
	}
	scope, err := ParseAITrialScope("production", session["user"].(map[string]any)["id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	app.Organizer.Trial = scope
	if b.do("GET", "/auth/session", nil, "").want(t, 200)["ai_trial_eligible"] != false {
		t.Fatal("outside account was reported as eligible")
	}
	a.do("PUT", "/admin/budgets", map[string]any{"base_version": 1, "platform_daily_units": 1000000, "user_daily_units": 1000000, "worker_concurrency": 1}, "").want(t, 200)
	a.do("PATCH", "/me/preferences", map[string]any{"ai_enabled": true, "consent_version": "spark-ai-v1"}, "").want(t, 200)
	project := a.do("POST", "/projects", map[string]any{"name": "并发同步", "description": "合成项目", "focus_points": []string{}}, uuid.NewString()).want(t, 201)
	streamA, streamB := openOrganizationStream(t, a, base), openOrganizationStream(t, b, base)
	expectReady(t, streamA)
	expectReady(t, streamB)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		content := map[string]any{"title": "整理结果", "tag_candidates": []any{}, "project_candidates": []any{map[string]any{
			"project_id": project["id"], "confidence": 0.9, "reason": "原文提到同步", "evidence": []any{map[string]any{"source_id": "original_text", "quote": "同步"}}}}}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(jsonBytes(content))}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 10}})
	}))
	defer provider.Close()
	cfg := AIConfig{Version: "stream-test", MaxAttempts: 1, TimeoutSeconds: 2, MaxInputChars: 1000, Routes: []AIRoute{{Name: "primary", Endpoint: provider.URL + "/v1/chat/completions", Model: "synthetic", OutputMode: "json_object", MaxOutputTokens: 500, MaxContextTokens: 32768, InputPrice: 1, OutputPrice: 1}}}
	client := NewTextClient()
	defer client.Close()
	worker, err := StartTextWorker(ctx, app.Pool, cfg, app.Organizer.Trial, client)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := worker.Stop(shutdown); err != nil {
			t.Error(err)
		}
	}()

	ids := []string{uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		a.do("POST", "/collections", collectionInput(id, "同步材料和合成证据"), uuid.NewString()).want(t, 201)
		for {
			frame := nextOrganizationFrame(t, streamA, 5*time.Second)
			var e contract.OrganizationEvent
			var keys map[string]any
			if frame.name != "organization" || json.Unmarshal([]byte(frame.data), &e) != nil || json.Unmarshal([]byte(frame.data), &keys) != nil || len(keys) != 3 || e.CollectionId.String() != id {
				t.Fatalf("unexpected notification %s", frame.name)
			}
			if e.Status == "succeeded" {
				if !e.HasSuggestion {
					t.Fatal("notification omitted committed suggestion")
				}
				row := a.do("GET", "/collections/"+id, nil, "").want(t, 200)
				if row["has_suggestion"] != true || row["organization"].(map[string]any)["status"] != "succeeded" {
					t.Fatal("notification sent before commit")
				}
				break
			}
		}
	}
	select {
	case <-streamB:
		t.Fatal("another account received the event")
	case <-time.After(100 * time.Millisecond):
	}
	tx, err := app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "UPDATE organization_runs SET status='failed' WHERE collection_id=$1", ids[0]); err != nil {
		t.Fatal(err)
	}
	// Execute the deferred publisher inside the transaction and discard it.
	if _, err = tx.Exec(ctx, "SET CONSTRAINTS ALL IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-streamA:
		t.Fatal("rolled-back transaction published an event")
	case <-time.After(100 * time.Millisecond):
	}
	first := a.do("GET", "/collections?has_suggestion=true&limit=1", nil, "").want(t, 200)
	second := a.do("GET", "/collections?has_suggestion=true&limit=1&cursor="+url.QueryEscape(first["next_cursor"].(string)), nil, "").want(t, 200)
	if first["total"] != float64(2) || second["total"] != float64(2) || len(first["items"].([]any)) != 1 || len(second["items"].([]any)) != 1 || first["items"].([]any)[0].(map[string]any)["id"] == second["items"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("suggestion filter/count does not paginate the matched set")
	}
	if b.do("GET", "/collections?has_suggestion=true", nil, "").want(t, 200)["total"] != float64(0) {
		t.Fatal("suggestion count leaked cross-account")
	}

	a.do("PATCH", "/collections/"+ids[0]+"/projects", map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": project["id"], "action": "include"}}}, "").want(t, 200)
	frame := nextOrganizationFrame(t, streamA, 4*time.Second)
	var applied contract.OrganizationEvent
	if frame.name != "organization" || json.Unmarshal([]byte(frame.data), &applied) != nil || applied.HasSuggestion || applied.CollectionId.String() != ids[0] {
		t.Fatal("manual confirmation did not invalidate the pending suggestion")
	}
	if a.do("GET", "/collections?has_suggestion=true", nil, "").want(t, 200)["total"] != float64(1) {
		t.Fatal("confirmed suggestion still pending")
	}
	a.do("PATCH", "/projects/"+project["id"].(string), map[string]any{"base_version": 1, "state": "paused"}, "").want(t, 200)
	expectOrganizationStreamClosed(t, streamA)
	streamA = openOrganizationStream(t, a, base)
	expectReady(t, streamA)
	if a.do("GET", "/collections?has_suggestion=true", nil, "").want(t, 200)["total"] != float64(0) {
		t.Fatal("stale project suggestion remained pending")
	}
	a.do("POST", "/auth/logout", nil, "").want(t, 204)
	expectOrganizationStreamClosed(t, streamA)
	a.do("GET", "/organization/events", nil, "").want(t, 401)
	stopListener()
	expectOrganizationStreamClosed(t, streamB)
	b.do("GET", "/organization/events", nil, "").want(t, 503)
	startOrganizationListener(t, app)
	streamB = openOrganizationStream(t, b, base)
	expectReady(t, streamB)
	sessions := b.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any)
	b.do("DELETE", "/sessions/"+sessions[0].(map[string]any)["id"].(string), nil, "").want(t, 204)
	expectOrganizationStreamClosed(t, streamB)
}

func TestOrganizationStreamHeartbeatsAndExpiresWithoutSessionPolling(t *testing.T) {
	app, base := testBackend(t)
	if err := app.BootstrapAdmin(context.Background(), "expiring@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	user := newClient(t, app, base)
	user.signIn("expiring@example.test")
	sessions := user.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any)
	id := sessions[0].(map[string]any)["id"]
	if _, err := app.Pool.Exec(context.Background(), "UPDATE sessions SET expires_at=now()+interval '18 seconds' WHERE id=$1", id); err != nil {
		t.Fatal(err)
	}
	startOrganizationListener(t, app)
	// Exercise the stream through net/http's real server write deadline.
	httpServer := httptest.NewUnstartedServer(app.Router())
	httpServer.Config.WriteTimeout = time.Second
	httpServer.Start()
	t.Cleanup(httpServer.Close)
	stream := openOrganizationStream(t, user, httpServer.URL)
	expectReady(t, stream)
	if nextOrganizationFrame(t, stream, 17*time.Second).name != "heartbeat" {
		t.Fatal("stream did not survive the ordinary request and write deadlines")
	}
	expectOrganizationStreamClosed(t, stream)
	user.do("GET", "/organization/events", nil, "").want(t, 401)
}

func TestOrganizationHubBoundsAndDisconnectsSlowSubscribers(t *testing.T) {
	hub := newOrganizationHub()
	hub.setOnline(true)
	user, session, collection := uuid.NewString(), uuid.NewString(), uuid.NewString()
	var last *organizationSubscription
	for range maxUserOrganizationStreams {
		var err error
		last, err = hub.subscribe(user, session)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := hub.subscribe(user, session); err == nil {
		t.Fatal("per-account connection limit was exceeded")
	}
	payload := string(jsonBytes(map[string]any{"schema": "test", "user_id": user, "collection_id": collection, "status": "succeeded", "has_suggestion": false}))
	for range organizationStreamBuffer + 1 {
		hub.dispatch("test", payload)
	}
	if !streamClosed(last.done) {
		t.Fatal("slow subscriber was left connected with an incomplete event history")
	}
	hub.remove(user, last)
	if _, err := hub.subscribe(user, session); err != nil {
		t.Fatal("closed handler did not release a connection slot")
	}
}
