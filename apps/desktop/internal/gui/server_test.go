package gui

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/store"
	"spark/apps/desktop/internal/syncer"
)

func testHost(t *testing.T, origin string) (*Host, string) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sessions, err := auth.OpenSessions(auth.NewMemoryStore(), origin)
	if err != nil {
		t.Fatal(err)
	}
	owner := uuid.NewString()
	if err = sessions.Save(auth.StoredSession{Origin: origin, AccountID: owner, Token: "device", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	client, err := api.NewClient(origin, true)
	if err != nil {
		t.Fatal(err)
	}
	return &Host{Sessions: sessions, Store: st, API: client, Engine: syncer.New(st, sessions, client), Change: func() {}}, owner
}

func localRequest(h http.Handler, owner, method, path string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/local/"+path, body)
	req.Header.Set("X-Spark-Desktop", "1")
	req.Header.Set("X-Spark-Account", owner)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRemoteDeletionEvictsOnlyThatAccountsCache(t *testing.T) {
	for _, status := range []int{200, 404} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			id := uuid.NewString()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				if status == 200 {
					deleted := time.Now().Format(time.RFC3339)
					_ = json.NewEncoder(w).Encode(api.Collection{ID: id, DeletedAt: &deleted})
				}
			}))
			defer server.Close()
			host, owner := testHost(t, server.URL)
			for _, account := range []string{owner, "another"} {
				read := host.Store.BeginCollectionRead(account)
				defer read.Close()
				if _, err := read.ApplyDetail(api.Collection{ID: id, DisplayTitle: "旧记录"}); err != nil {
					t.Fatal(err)
				}
			}
			h := host.Handler()
			res := localRequest(h, owner, "GET", "collections/"+id, nil)
			if res.Code != 404 {
				t.Fatal(res.Code, res.Body.String())
			}
			rows, err := host.Store.ListCachedCollections(owner, "", 30)
			if err != nil || len(rows) != 0 {
				t.Fatal("deleted record in list", err)
			}
			hits, err := host.Store.SearchLocal(owner, "旧记录", 30)
			if err != nil || len(hits) != 0 {
				t.Fatal("deleted record in search", err)
			}
			if _, ok, err := host.Store.GetCachedCollectionDetail("another", id); err != nil || !ok {
				t.Fatal("other account cache removed", err)
			}
		})
	}
}

func TestExpiredViewsOnlyReadSQLite(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(401) }))
	defer server.Close()
	host, owner := testHost(t, server.URL)
	id := uuid.NewString()
	read := host.Store.BeginCollectionRead(owner)
	defer read.Close()
	if _, err := read.ApplyDetail(api.Collection{ID: id, PlainText: "本机内容"}); err != nil {
		t.Fatal(err)
	}
	var transitions atomic.Int32
	host.API.OnUnauthorized = func(token string) error {
		changed, err := host.Sessions.Expire(token)
		if changed {
			transitions.Add(1)
		}
		return err
	}
	h := host.Handler()
	for range 3 {
		res := localRequest(h, owner, "GET", "collections/"+id, nil)
		if res.Code != 200 || !strings.Contains(res.Body.String(), "本机内容") {
			t.Fatal(res.Code, res.Body.String())
		}
	}
	for _, path := range []string{"collections/page", "search/remote?q=abc", "image/" + id} {
		if res := localRequest(h, owner, "GET", path, nil); res.Code != 401 {
			t.Fatal(path, res.Code)
		}
	}
	if calls.Load() != 1 || transitions.Load() != 1 {
		t.Fatalf("%d requests, %d transitions", calls.Load(), transitions.Load())
	}
}

func TestCopyReflectsPasteboardResult(t *testing.T) {
	host := &Host{}
	h := host.Handler()
	for _, success := range []bool{false, true} {
		host.CopyText = func(s string) bool {
			if s != "正文\x00链接" {
				t.Fatal("text changed")
			}
			return success
		}
		res := localRequest(h, "", "POST", "clipboard/copy", strings.NewReader(`{"Text":"正文\u0000链接"}`))
		if success && res.Code != 204 || !success && (res.Code != 503 || !strings.Contains(res.Body.String(), "剪贴板")) {
			t.Fatal(res.Code, res.Body.String())
		}
	}
}

type observedReader struct {
	io.Reader
	started chan struct{}
	once    sync.Once
}

func (r *observedReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	return r.Reader.Read(p)
}

func TestQuitDrainsAcceptedCaptureBeforeStoreClose(t *testing.T) {
	host, owner := testHost(t, "https://example.test")
	h := host.Handler()
	pr, pw := io.Pipe()
	defer pw.Close()
	reader := &observedReader{Reader: pr, started: make(chan struct{})}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- localRequest(h, owner, "POST", "capture", reader) }()
	<-reader.started
	stopping, done := make(chan struct{}), make(chan struct{})
	go func() { host.Captures.Shutdown(func() { close(stopping) }); close(done) }()
	<-stopping
	if res := localRequest(h, owner, "POST", "capture", strings.NewReader("{}")); res.Code != 503 {
		t.Fatal("new capture admitted during shutdown")
	}
	select {
	case <-done:
		t.Fatal("shutdown returned with pending write")
	default:
	}
	_, err := io.WriteString(pw, `{"raw_text":"草稿","attachments":[{"filename":"note.png","data_b64":"iVBORw0KGgo="}]}`)
	if err != nil {
		t.Fatal(err)
	}
	pw.Close()
	res := <-result
	if res.Code != 201 {
		t.Fatal(res.Code, res.Body.String())
	}
	<-done
	pending, err := host.Store.ListPending(owner)
	if err != nil || len(pending) != 1 || len(pending[0].Attachments) != 1 {
		t.Fatal("missing persisted draft", err)
	}
	data, err := host.Store.ReadAttachmentBytes(pending[0].Attachments[0])
	if err != nil || len(data) != 8 {
		t.Fatal("missing staged bytes", err)
	}
}

func TestLateRefresh401AfterSameAccountLogin(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var posted atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v1/collections":
			if r.Header.Get("Authorization") != "Bearer device" {
				t.Error("refresh used unexpected credential")
			}
			close(started)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			w.WriteHeader(401)
		case r.Method == "POST" && r.URL.Path == "/api/v1/collections":
			if r.Header.Get("Authorization") != "Bearer renewed" {
				t.Error("draft used stale credential")
			}
			var draft api.CollectionCreate
			if err := json.NewDecoder(r.Body).Decode(&draft); err != nil {
				t.Error(err)
				return
			}
			posted.Add(1)
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(api.Collection{ID: draft.ID})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	host, owner := testHost(t, server.URL)
	host.API.OnUnauthorized = host.Engine.HandleUnauthorized
	done := make(chan error, 1)
	go func() { done <- host.Engine.RefreshRemoteCache(ctx) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("old refresh never started")
	}
	// A different request discovers expiry; the same account signs in again
	// while the first request still holds its original bearer.
	if err := host.Engine.HandleUnauthorized("device"); err != nil {
		t.Fatal(err)
	}
	if err := host.Sessions.Save(auth.StoredSession{Origin: server.URL, AccountID: owner, Token: "renewed", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	draft, err := host.Store.EnqueueCapture(store.EnqueueInput{AccountID: owner, RawText: "重新登录后的草稿"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	if ae, ok := api.AsAPIError(<-done); !ok || ae.Status != 401 {
		t.Fatal("old refresh did not report its own 401")
	}
	current, err := host.Sessions.Load()
	if err != nil || !current.Public(time.Now()).Connected {
		t.Fatal("new session expired", err)
	}
	item, _, err := host.Store.GetOutboxItem(owner, draft.ID)
	if err != nil || item.State != store.OutboxLocalSaved {
		t.Fatalf("late 401 changed new draft to %s: %v", item.State, err)
	}
	host.Engine.SyncOnce(ctx)
	item, _, err = host.Store.GetOutboxItem(owner, draft.ID)
	if err != nil || item.State != store.OutboxSynced || posted.Load() != 1 {
		t.Fatalf("new session failed to send draft: %s, %v", item.State, err)
	}
}

func TestLateCollectionReadsAfterDeletionAndRestore(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusOK} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			id := uuid.NewString()
			var lists, details atomic.Int32
			listStarted, detailStarted := make(chan struct{}), make(chan struct{})
			releaseList, releaseDetail := make(chan struct{}), make(chan struct{})
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/collections":
					title := "已恢复"
					if lists.Add(1) == 1 {
						title = "旧列表"
						close(listStarted)
						select {
						case <-releaseList:
						case <-ctx.Done():
							return
						}
					}
					_ = json.NewEncoder(w).Encode(api.CollectionPage{Items: []api.CollectionSummary{{ID: id, DisplayTitle: title}}})
				case "/api/v1/collections/" + id:
					if details.Add(1) == 1 {
						close(detailStarted)
						select {
						case <-releaseDetail:
						case <-ctx.Done():
							return
						}
						_ = json.NewEncoder(w).Encode(api.Collection{ID: id, DisplayTitle: "旧详情"})
						return
					}
					w.WriteHeader(status)
					if status == 200 {
						deleted := time.Now().Format(time.RFC3339)
						_ = json.NewEncoder(w).Encode(api.Collection{ID: id, DeletedAt: &deleted})
					}
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			defer cancel()
			host, owner := testHost(t, server.URL)
			h := host.Handler()
			request := func(path string) *httptest.ResponseRecorder { return localRequest(h, owner, "GET", path, nil) }
			lateList, lateDetail := make(chan *httptest.ResponseRecorder, 1), make(chan *httptest.ResponseRecorder, 1)
			go func() { lateList <- request("collections/page") }()
			go func() { lateDetail <- request("collections/" + id) }()
			for _, started := range []chan struct{}{listStarted, detailStarted} {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("remote read never started")
				}
			}
			if res := request("collections/" + id); res.Code != 404 {
				t.Fatal("missing confirmed deletion", res.Code)
			}
			close(releaseList)
			res := <-lateList
			var page api.CollectionPage
			if err := json.Unmarshal(res.Body.Bytes(), &page); res.Code != 200 || err != nil || len(page.Items) != 0 {
				t.Fatal("old list returned deleted record", res.Body.String())
			}
			hits, err := host.Store.SearchLocal(owner, "", 10)
			if err != nil || len(hits) != 0 {
				t.Fatal("old list revived deleted record", hits, err)
			}
			if res := request("collections/page"); res.Code != 200 || !strings.Contains(res.Body.String(), "已恢复") {
				t.Fatal("new list could not restore item", res.Body.String())
			}
			close(releaseDetail)
			if res := <-lateDetail; res.Code != 404 {
				t.Fatal("old detail surfaced after restore", res.Body.String())
			}
			rows, err := host.Store.ListCachedCollections(owner, "", 10)
			if err != nil || len(rows) != 1 || rows[0].DisplayTitle != "已恢复" {
				t.Fatal("old detail overwrote restored record", rows, err)
			}
		})
	}
}
