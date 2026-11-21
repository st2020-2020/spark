package backend

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"spark/server/internal/webextract"
)

func TestSessionReportsURLExtractionCapability(t *testing.T) {
	app, addr := testBackend(t)
	const email = "url-capability@example.test"
	if err := app.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, addr)
	login := client.do("POST", "/auth/login", map[string]any{"email": email, "password": "test-password-12345"}, "").want(t, 200)
	if login["url_extraction_enabled"] != false {
		t.Fatalf("login should report extraction disabled by default: %v", login["url_extraction_enabled"])
	}
	client.csrf = login["csrf_token"].(string)
	id := uuid.NewString()
	input := collectionInput(id, "合成网页资料")
	input["original_url"] = "https://example.test/capability"
	client.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	path := "/collections/" + id + "/extractions"
	for _, enabled := range []bool{false, true, false} {
		app.Config.URLExtractEnabled = enabled
		session := client.do("GET", "/auth/session", nil, "").want(t, 200)
		if session["url_extraction_enabled"] != enabled {
			t.Fatalf("session url_extraction_enabled = %v, want %v", session["url_extraction_enabled"], enabled)
		}
		refresh := client.do("POST", path, nil, uuid.NewString())
		if enabled {
			if body := refresh.want(t, 202); body["status"] != "queued" || body["source_kind"] != "url" {
				t.Fatalf("enabled refresh did not queue the URL: %v", body)
			}
		} else {
			if body := refresh.want(t, 503); body["error"].(map[string]any)["code"] != "integration_not_configured" {
				t.Fatalf("disabled refresh reported an unexpected error: %v", body)
			}
		}
	}
}

func TestURLExtractionWithIsolatedRiver(t *testing.T) {
	app, addr := testBackend(t)
	ctx := t.Context()
	app.Config.URLExtractEnabled = true
	oldStarted, releaseOld := make(chan struct{}, 1), make(chan struct{})
	var recoveryRequests, slowRequests atomic.Int32
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.Path == "/slow" && slowRequests.Add(1) == 1 {
			select {
			case oldStarted <- struct{}{}:
			default:
			}
			select {
			case <-releaseOld:
				_, _ = io.WriteString(w, `<title>旧网页</title><main><p>过期提取片段</p></main>`)
			case <-r.Context().Done():
			}
			return
		}
		switch r.URL.Path {
		case "/restricted":
			w.WriteHeader(http.StatusForbidden)
		case "/recover":
			if recoveryRequests.Add(1) == 1 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = io.WriteString(w, `<meta property="og:title" content="已恢复"><main><p>重试可用</p></main>`)
		default:
			_, _ = io.WriteString(w, `<title>合成网页</title><meta property="og:site_name" content="合成站点">
				<meta name="description" content="来自网页描述"><main><p>预览检索专用中文短语</p></main>`)
		}
	}))
	t.Cleanup(fixture.Close)
	fetcher := webextract.Client{
		LookupIP: func(_ context.Context, network, host string) ([]netip.Addr, error) {
			if network != "ip" || host != "spark-preview.example.test." {
				return nil, errors.New("unexpected fixture hostname")
			}
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		},
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			if network != "tcp" || address != "93.184.216.34:80" {
				return nil, errors.New("unexpected fixture socket")
			}
			return (&net.Dialer{}).DialContext(ctx, network, fixture.Listener.Addr().String())
		},
	}
	worker, err := startURLWorker(context.Background(), app.Pool, fetcher)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := worker.StopAndCancel(stop); err != nil {
			t.Error(err)
		}
	})
	const email = "web-preview@example.test"
	if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, addr)
	client.signIn(email)
	client.invite("INVITE-PREVIEW-02")
	other := newClient(t, app, addr)
	other.csrf = other.do("POST", "/auth/register", other.registration("other-preview@example.test", "INVITE-PREVIEW-02"), "").want(t, 201)["csrf_token"].(string)

	const site = "http://spark-preview.example.test"
	save := func(path string) (string, map[string]any) {
		t.Helper()
		cid := uuid.NewString()
		input := collectionInput(cid, "手写正文示例")
		input["original_url"], input["manual_title"] = site+path, "手工命名"
		return cid, client.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	}
	waitFor := func(cid, desired string, version int) map[string]any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			items := client.do("GET", "/collections/"+cid+"/extractions", nil, "").want(t, 200)["items"].([]any)
			if len(items) == 1 {
				row := items[0].(map[string]any)
				if row["status"] == desired && row["content_version"] == float64(version) {
					return row
				}
				if row["status"] == "failed" || row["status"] == "blocked" {
					t.Fatalf("unexpected extraction outcome: %v %v", row["status"], row["error_code"])
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("extraction did not reach %s for version %d", desired, version)
			}
			time.Sleep(30 * time.Millisecond)
		}
	}

	// Holding the HTTP response open must not delay the save. Keep the
	// old fetch in flight while the next version completes independently.
	started := time.Now()
	cid, created := save("/slow")
	if time.Since(started) >= 3*time.Second || created["display_title"] != "手工命名" ||
		created["organization"].(map[string]any)["status"] != "skipped" {
		t.Fatal("save waited for the page or changed the manual title")
	}
	select {
	case <-oldStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the old fetch never started")
	}
	waitFor(cid, "running", 1)
	path := "/collections/" + cid
	other.do("GET", path+"/extractions", nil, "").want(t, 404)
	other.do("POST", path+"/extractions", nil, uuid.NewString()).want(t, 404)

	edit := map[string]any{"base_content_version": 1, "manual_title": "人工更新",
		"intent": "手工用途更新"}
	client.do("PATCH", path, edit, "").want(t, 200)
	latest := waitFor(cid, "succeeded", 2)
	if latest["source_id"] != site+"/slow" || latest["source_title"] != "合成网页" ||
		latest["site_name"] != "合成站点" || latest["summary"] != "来自网页描述" {
		t.Fatalf("unexpected current preview metadata: %+v", latest)
	}

	close(releaseOld)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var completed bool
		if err := app.Pool.QueryRow(ctx, `
			SELECT count(*)=2 FROM river_job
			WHERE kind='spark_extract_url' AND args->>'collection_id'=$1 AND state='completed'`, cid).Scan(&completed); err != nil {
			t.Fatal(err)
		}
		if completed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("old worker did not finish")
		}
		time.Sleep(30 * time.Millisecond)
	}
	var leaked bool
	if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM extractions
		WHERE collection_id=$1 AND content_version=1 AND (text IS NOT NULL OR source_title IS NOT NULL))`, cid).Scan(&leaked); err != nil || leaked {
		t.Fatalf("superseded fetch was written to storage: %v", err)
	}
	waitFor(cid, "succeeded", 2)
	saved := client.do("GET", path, nil, "").want(t, 200)
	if saved["display_title"] != "人工更新" || saved["intent"] != "手工用途更新" ||
		saved["original_url"] != site+"/slow" || !equalJSON(saved["document"], created["document"]) {
		t.Fatal("derived output changed manually saved data")
	}
	search := "/search?q=" + url.QueryEscape("预览检索专用中文短语")
	hits := client.do("GET", search, nil, "").want(t, 200)["items"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["snippets"].([]any)[0].(map[string]any)["field"] != "extraction" {
		t.Fatal("current web text was not searchable")
	}
	if len(other.do("GET", search, nil, "").want(t, 200)["items"].([]any)) != 0 {
		t.Fatal("web search crossed account boundary")
	}

	restricted, original := save("/restricted")
	failure := waitFor(restricted, "failed", 1)
	if failure["error_code"] != "fetch_restricted" || failure["source_title"] != nil ||
		client.do("GET", "/collections/"+restricted, nil, "").want(t, 200)["original_url"] != original["original_url"] {
		t.Fatal("restricted page did not degrade to the original URL")
	}

	blockedID := uuid.NewString()
	blocked := collectionInput(blockedID, "仅保留本机地址")
	blocked["original_url"] = "http://127.0.0.1/"
	client.do("POST", "/collections", blocked, uuid.NewString()).want(t, 201)
	if item := waitFor(blockedID, "blocked", 1); item["error_code"] != "unsafe_url" {
		t.Fatal("non-public link did not fall back")
	}

	recovering, _ := save("/recover")
	recoverPath := "/collections/" + recovering + "/extractions"
	previousID := waitFor(recovering, "failed", 1)["id"]
	key := uuid.NewString()
	currentID := client.do("POST", recoverPath, nil, key).want(t, 202)["id"]
	client.do("POST", recoverPath, nil, key).want(t, 202)
	if previousID == currentID || waitFor(recovering, "succeeded", 1)["id"] != currentID || recoveryRequests.Load() != 2 {
		t.Fatal("manual refresh did not replace the failed attempt exactly once")
	}
	var otherQueues int
	if err := app.Pool.QueryRow(ctx, "SELECT count(*) FROM river_job WHERE queue<>'url_extraction'").Scan(&otherQueues); err != nil || otherQueues != 0 {
		t.Fatalf("independent web extraction scheduled other processing: %v", err)
	}
}

func TestURLExtractionDeduplicatesLongPrimaryURL(t *testing.T) {
	app, addr := testBackend(t)
	app.Config.URLExtractEnabled = true
	client := imageTestAccount(t, app, addr, "long-primary")
	var query strings.Builder
	for i := range 60 {
		fmt.Fprintf(&query, "%x", sha256.Sum256([]byte(fmt.Sprint(i))))
	}
	source := "https://spark-preview.example.test/long?q=" + query.String()
	id := uuid.NewString()
	input := collectionInput(id, "synthetic long URL")
	input["original_url"] = source
	key := uuid.NewString()
	client.do("POST", "/collections", input, key).want(t, 201)
	client.do("POST", "/collections", input, key).want(t, 201)
	path := "/collections/" + id
	initial := client.do("GET", path+"/extractions", nil, "").want(t, 200)["items"].([]any)
	if len(initial) != 1 || initial[0].(map[string]any)["source_id"] != source {
		t.Fatalf("primary URL was duplicated or changed on writeback: %d rows", len(initial))
	}
	firstID := initial[0].(map[string]any)["id"]
	for range 2 {
		refresh := client.do("POST", path+"/extractions", nil, uuid.NewString()).want(t, 202)
		if refresh["id"] != firstID || refresh["source_id"] != source {
			t.Fatal("refresh did not reuse the queued extraction for the same raw URL")
		}
	}
	updated := source + "&revision=2"
	client.do("PATCH", path, map[string]any{"base_content_version": 1, "original_url": updated}, "").want(t, 200)
	latest := client.do("GET", path+"/extractions", nil, "").want(t, 200)["items"].([]any)
	if len(latest) != 1 {
		t.Fatalf("expected a single extraction for the current version, saw %d", len(latest))
	}
	current := latest[0].(map[string]any)
	if current["source_id"] != updated || current["id"] == firstID || current["content_version"] != float64(2) {
		t.Fatal("an older URL or version was returned as the current extraction")
	}
}

func TestURLExtractionDisabledKeepsSaving(t *testing.T) {
	app, addr := testBackend(t)
	const email = "preview-off@example.test"
	if err := app.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, addr)
	client.signIn(email)
	id := uuid.NewString()
	input := collectionInput(id, "只保存网址说明")
	input["original_url"] = "https://disabled-preview.example.test/"
	client.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	path := "/collections/" + id + "/extractions"
	if len(client.do("GET", path, nil, "").want(t, 200)["items"].([]any)) != 0 {
		t.Fatal("disabled extraction produced a row")
	}
	client.do("POST", path, nil, uuid.NewString()).want(t, 503)
	var jobs int
	if err := app.Pool.QueryRow(t.Context(), "SELECT count(*) FROM river_job WHERE queue='url_extraction'").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("disabled feature scheduled work: %v", err)
	}
}
