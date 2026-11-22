package gui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/native"
	"spark/apps/desktop/internal/store"
	"spark/apps/desktop/internal/syncer"
)

func TestLoginThroughLocalForm(t *testing.T) {
	token := strings.Repeat("A", 43)
	account := uuid.NewString()
	input := api.LoginRequest{Email: "sample@example.test", Password: " synthetic password "}
	serverStatus := 401
	hits := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Method != "POST" || r.URL.RequestURI() != "/api/v1/desktop/login" || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Content-Type") != "application/json" {
			t.Error("incorrect desktop login transport")
		}
		var got api.LoginRequest
		if json.NewDecoder(r.Body).Decode(&got) != nil || got != input {
			t.Error("credentials not submitted exactly once in JSON")
		}
		if serverStatus != 200 {
			w.Header().Set("Retry-After", "12")
			w.WriteHeader(serverStatus)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "authentication_failed", "message": input.Password}})
			return
		}
		_ = json.NewEncoder(w).Encode(api.DesktopTokenResult{Token: token, AccountID: account, AccountLabel: input.Email, ExpiresAt: time.Now().Add(time.Hour)})
	}))
	defer upstream.Close()
	sessions, err := auth.OpenSessions(auth.NewMemoryStore())
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	client, err := api.NewClient(upstream.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	host := Host{API: client, Store: db, Sessions: sessions, Engine: syncer.New(db, sessions, client), Clipboard: native.NewClipboardTracker(), Change: func() {}}
	handler := host.Handler()
	login := func(expectedAccount string) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(input)
		req := httptest.NewRequest("POST", "/local/session/login", strings.NewReader(string(raw)))
		req.Header.Set("X-Spark-Desktop", "1")
		req.Header.Set("X-Spark-Account", expectedAccount)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if strings.Contains(rec.Body.String(), token) || strings.Contains(rec.Body.String(), input.Password) {
			t.Fatal("local bridge disclosed credentials")
		}
		return rec
	}
	for _, tc := range []struct {
		status, local int
		msg           string
	}{{401, 401, "邮箱或密码"}, {404, 503, "尚未开放"}, {422, 422, "格式"}, {429, 429, "12 秒"}, {500, 502, "稍后重试"}} {
		serverStatus = tc.status
		res := login("")
		if res.Code != tc.local || !strings.Contains(res.Body.String(), tc.msg) {
			t.Errorf("unexpected status/message for %d", tc.status)
		}
		if _, err := sessions.Load(); err != auth.ErrNoSession {
			t.Fatal("failed login changed current session")
		}
	}
	serverStatus = 200
	if login("").Code != 204 {
		t.Fatal("valid login failed")
	}
	sess, err := sessions.Load()
	if err != nil || sess.AccountID != account || sess.Token != token {
		t.Fatal("device session missing")
	}
	before := hits
	if login("").Code != 409 || hits != before {
		t.Fatal("stale form switched the account")
	}
	if err := sessions.Expire(token); err != nil {
		t.Fatal(err)
	}
	upstream.Close()
	if res := login(account); res.Code != 503 || !strings.Contains(res.Body.String(), "检查网络") {
		t.Fatal("offline login feedback missing")
	}
	sess, _ = sessions.Load()
	if sess.AccountID != account || !sess.Public(time.Now()).Expired {
		t.Fatal("failed reauthentication discarded old owner")
	}
}
