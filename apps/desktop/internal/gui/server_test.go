package gui

import (
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
				if err := host.Store.UpsertCachedCollectionDetail(account, api.Collection{ID: id, DisplayTitle: "旧记录"}); err != nil {
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
	if err := host.Store.UpsertCachedCollectionDetail(owner, api.Collection{ID: id, PlainText: "本机内容"}); err != nil {
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
