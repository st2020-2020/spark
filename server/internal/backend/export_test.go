package backend

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestExportMarkdown(t *testing.T) {
	raw := json.RawMessage(`{"schema_version":1,"content":{"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"A","marks":[{"type":"bold"}]},
        {"type":"hardBreak"},{"type":"text","text":"B","marks":[{"type":"highlight"},{"type":"link","attrs":{"href":"https://example.test/a(b)"}}]}]},
        {"type":"orderedList","attrs":{"start":9},"content":[{"type":"listItem","content":[
            {"type":"paragraph","content":[{"type":"text","text":"C"}]},
            {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"[D]<i>"}]}]}]}]},
            {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"E"}]}]}]}]}}`)
	got, err := documentMarkdown(raw)
	want := "**A**  \n[==B==](<https://example.test/a(b)>)\n\n9. C\n   \n   - \\[D\\]&lt;i&gt;\n10. E"
	if err != nil || got != want {
		t.Fatalf("Markdown = %q, %v", got, err)
	}
}

func TestExportNames(t *testing.T) {
	m := newMarkdownArchive(nil)
	seen := map[string]bool{}
	for _, input := range []string{"../A", "..\\a", ".._A (2)", ".._a", "NUL.txt", "..", "a\x00b", strings.Repeat("界", 200), "é", "e\u0301"} {
		name := m.name("projects", input, "")
		base := path.Base(name)
		if path.Dir(name) != "projects" || strings.ContainsAny(base, "\\\x00") || len(base) > 100 || !utf8.ValidString(name) || seen[strings.ToLower(name)] || base == "NUL.txt" {
			t.Fatalf("unsafe or repeated path %q", name)
		}
		seen[strings.ToLower(name)] = true
	}
}

type exportAccount struct {
	*apiClient
	uid string
}

func (a exportAccount) download(t *testing.T, format string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, a.base+exportPath+"?format="+format, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-CSRF-Token", a.csrf)
	return a.http.Do(req)
}

func signedExportAccount(t *testing.T, s *Server, base, name string) exportAccount {
	t.Helper()
	email := name + "@example.test"
	if err := s.BootstrapAdmin(t.Context(), email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(t.Context(), `UPDATE users SET role='user' WHERE email_normalized=$1`, email); err != nil {
		t.Fatal(err)
	}
	a := newClient(t, s, base)
	a.signIn(email)
	id := a.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	return exportAccount{a, id}
}

func archiveFiles(t *testing.T, resp *http.Response) map[string]string {
	t.Helper()
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/zip" || resp.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("archive status=%d headers=%v", resp.StatusCode, resp.Header)
	}
	// The ZIP has no comment. Any bytes following EOCD indicate the HTTP
	// wrapper appended a second response after the streaming handler returned.
	if len(raw) < 22 || !bytes.Equal(raw[len(raw)-22:len(raw)-18], []byte{'P', 'K', 5, 6}) {
		t.Fatal("invalid ZIP ending")
	}
	r, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range r.File {
		if _, dup := files[f.Name]; dup {
			t.Fatal("repeated ZIP name", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[f.Name] = string(body)
	}
	return files
}

func expireExport(t *testing.T, a exportAccount) {
	t.Helper()
	_, err := a.app.Pool.Exec(t.Context(), `UPDATE auth_rate_limits SET window_start=now()-interval '11 minutes' WHERE key=$1`, a.app.mac("rate", "export:"+a.uid))
	if err != nil {
		t.Fatal(err)
	}
}

func TestExportAccountsAndFormats(t *testing.T) {
	s, base := testBackend(t)
	a := signedExportAccount(t, s, base, "owner")
	b := signedExportAccount(t, s, base, "other")
	newClient(t, s, base).do("GET", "/me/export?format=json", nil, "").want(t, 401)
	for _, query := range []string{"", "?format=tar", "?format=json&format=markdown"} {
		a.do("GET", "/me/export"+query, nil, "").want(t, 400)
	}
	for _, headers := range []map[string]string{
		{"Origin": "https://other.example.test"},
		{"Sec-Fetch-Site": "same-site"},
		{"Sec-Fetch-Site": "cross-site"},
	} {
		a.withHeaders("GET", "/me/export?format=json", nil, "", headers).want(t, 403)
	}
	for _, token := range []string{"", "wrong-token", b.csrf} {
		res := a.withHeaders("GET", "/me/export?format=json", nil, "", map[string]string{"X-CSRF-Token": token})
		if res.want(t, 403)["error"].(map[string]any)["code"] != "csrf_failed" || res.header.Get("Content-Disposition") != "" {
			t.Fatal("export did not reject a missing or invalid session token")
		}
	}
	// The first valid download below must succeed after the rejected requests.
	ctx := t.Context()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := s.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Cross page boundaries independently for projects, documents and the
	// decisions of a single collection. Include collisions after sanitization.
	exec(`INSERT INTO projects(id,user_id,name,state,description,focus_points)
        SELECT md5('p'||i)::uuid,$1,CASE WHEN i=202 THEN '空项目' ELSE '../A' END,'paused','项目简介','["关注点"]'
        FROM generate_series(1,202) i`, a.uid)
	exec(`INSERT INTO collections(id,user_id,document,plain_text,intent,original_url,manual_title)
        SELECT md5('c'||i)::uuid,$1,$2,'正文','用途','https://example.test/','../同名'
        FROM generate_series(1,33) i`, a.uid, jsonBytes(textDocument("正文")))
	exec(`INSERT INTO collection_projects(user_id,collection_id,project_id,decision)
        SELECT $1,md5('c1')::uuid,md5('p'||i)::uuid,
            CASE WHEN i=201 THEN 'rejected' WHEN i=200 THEN 'confirmed' ELSE 'manual' END FROM generate_series(1,201) i`, a.uid)
	exec(`INSERT INTO projects(id,user_id,name,description,focus_points) VALUES(gen_random_uuid(),$1,'其他账号项目','','[]')`, b.uid)
	exec(`INSERT INTO collections(id,user_id,document,plain_text,intent,deleted_at)
        VALUES(gen_random_uuid(),$1,$3,'回收站资料','',now()),(gen_random_uuid(),$2,$3,'其他账号资料','',NULL)`, a.uid, b.uid, jsonBytes(textDocument("不可见资料")))

	fetch := func(who exportAccount, format string) (map[string]string, *http.Response) {
		t.Helper()
		resp, err := who.download(t, format)
		if err != nil {
			t.Fatal(err)
		}
		return archiveFiles(t, resp), resp
	}
	files, resp := fetch(a, "json")
	raw := files["spark-export.json"]
	var out struct {
		Version     int
		ExportedAt  time.Time `json:"exported_at"`
		Projects    []struct{ ID, Name string }
		Collections []struct {
			exportCollection
			Projects []exportDecision
		}
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || out.Version != 1 || len(out.Projects) != 202 || len(out.Collections) != 33 {
		t.Fatal("incomplete snapshot")
	}
	wantName := fmt.Sprintf(`attachment; filename="spark-export-%s.zip"`, out.ExportedAt.In(budgetLocation).Format("20060102"))
	if resp.Header.Get("Content-Disposition") != wantName {
		t.Fatal("incorrect attachment date")
	}
	for _, secret := range []string{"回收站资料", "不可见资料", "其他账号", "user_id", "password_hash"} {
		if strings.Contains(raw, secret) {
			t.Fatal("non-export data in archive")
		}
	}
	decisions := 0
	seen := map[string]bool{}
	for _, c := range out.Collections {
		if c.ID == "" || seen[c.ID] || c.PlainText != "正文" || c.Intent != "用途" || c.OriginalURL != "https://example.test/" || c.ManualTitle != "../同名" || c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() || !bytes.Contains(c.Document, []byte("正文")) {
			t.Fatal("missing or repeated collection")
		}
		seen[c.ID] = true
		decisions += len(c.Projects)
	}
	if decisions != 201 || !strings.Contains(raw, `"decision":"rejected"`) {
		t.Fatal("decision page incomplete")
	}
	exec(`UPDATE auth_rate_limits SET window_start=now()-interval '5 minutes' WHERE key=$1`, s.mac("rate", "export:"+a.uid))
	limited := a.do("GET", "/me/export?format=markdown", nil, "")
	if limited.want(t, 429)["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatal("incorrect quota error")
	}
	retry, err := strconv.Atoi(limited.header.Get("Retry-After"))
	if err != nil || retry < 295 || retry > 300 {
		t.Fatal("incorrect remaining window", retry)
	}
	other, _ := fetch(b, "json")
	if !strings.Contains(other["spark-export.json"], "其他账号资料") || strings.Contains(other["spark-export.json"], "同名") {
		t.Fatal("account quota or ownership mismatch")
	}
	expireExport(t, a)
	files, _ = fetch(a, "markdown")
	if len(files) != 1+202+33 || !strings.Contains(files["projects/空项目/PROJECT.md"], "项目简介") || !strings.Contains(files["projects/空项目/PROJECT.md"], "关注点") {
		t.Fatal("missing Markdown project data")
	}
	assigned, unassigned := 0, 0
	for name, body := range files {
		if strings.Contains(body, "不可见资料") || strings.Contains(body, "其他账号") || strings.Contains(name, "../") {
			t.Fatal("unsafe Markdown entry")
		}
		switch {
		case strings.HasPrefix(name, "unclassified/"):
			unassigned++
		case strings.HasPrefix(name, "projects/") && !strings.HasSuffix(name, "/PROJECT.md"):
			assigned++
			if strings.Count(body, "（manual）") != 199 || !strings.Contains(body, "（confirmed）") || !strings.Contains(body, "（rejected）") || !strings.Contains(body, "正文") {
				t.Fatal("missing Markdown associations or content")
			}
		}
	}
	if assigned != 1 || unassigned != 32 {
		t.Fatal("incorrect Markdown filing")
	}
}

func TestExportSnapshotCapacityAndCancellation(t *testing.T) {
	s, base := testBackend(t)
	a := signedExportAccount(t, s, base, "reader")
	b := signedExportAccount(t, s, base, "cancel")
	c := signedExportAccount(t, s, base, "retry")
	ctx := t.Context()
	if _, err := s.Pool.Exec(ctx, `INSERT INTO projects(id,user_id,name,description,focus_points) VALUES(gen_random_uuid(),$1,'原项目','','[]')`, a.uid); err != nil {
		t.Fatal(err)
	}
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err = blocker.Exec(ctx, "LOCK TABLE projects IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	type requestResult struct {
		resp *http.Response
		err  error
	}
	// Scale down the normal HTTP write timeout so the held snapshot must
	// extend it to finish its download.
	shortServer := httptest.NewUnstartedServer(s.Router())
	shortServer.Config.WriteTimeout = 50 * time.Millisecond
	shortServer.Start()
	t.Cleanup(shortServer.Close)
	start := func(ctx context.Context, who exportAccount) <-chan requestResult {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, "GET", shortServer.URL+exportPath+"?format=json", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("X-CSRF-Token", who.csrf)
		ch := make(chan requestResult, 1)
		go func() {
			resp, err := who.http.Do(req)
			ch <- requestResult{resp, err}
		}()
		return ch
	}
	waitReaders := func(want int) {
		t.Helper()
		end := time.Now().Add(5 * time.Second)
		for time.Now().Before(end) {
			var n int
			if err := blocker.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE relation='projects'::regclass AND mode='AccessShareLock' AND NOT granted`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("expected %d readers waiting on isolated project table", want)
	}
	first := start(ctx, a)
	cancelCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	second := start(cancelCtx, b)
	waitReaders(2)
	time.Sleep(2 * shortServer.Config.WriteTimeout)
	c.do("GET", "/auth/session", nil, "").want(t, 200)
	c.withHeaders("GET", "/me/export?format=json", nil, "", map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	c.do("GET", "/me/export?format=json", nil, "").want(t, 503)
	cancel()
	if r := <-second; r.err == nil {
		r.resp.Body.Close()
		t.Fatal("cancelled export returned a response")
	}
	waitReaders(1)
	// The first export has pinned its read-only snapshot but has not read any
	// project or collection rows yet. Commit edits to both before unblocking it.
	if _, err = blocker.Exec(ctx, `UPDATE projects SET name='新项目' WHERE user_id=$1`, a.uid); err != nil {
		t.Fatal(err)
	}
	if _, err = blocker.Exec(ctx, `INSERT INTO collections(id,user_id,document,plain_text,intent) VALUES(gen_random_uuid(),$1,$2,'新收藏','')`, a.uid, jsonBytes(textDocument("新收藏"))); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	r := <-first
	if r.err != nil {
		t.Fatal(r.err)
	}
	raw := archiveFiles(t, r.resp)["spark-export.json"]
	if !strings.Contains(raw, "原项目") || strings.Contains(raw, "新项目") || strings.Contains(raw, "新收藏") {
		t.Fatal("mixed snapshots")
	}
	r = <-start(ctx, c)
	if r.err != nil {
		t.Fatal(r.err)
	}
	empty := archiveFiles(t, r.resp)["spark-export.json"]
	if !strings.Contains(empty, `"projects":[],"collections":[]`) {
		t.Fatal("empty account export")
	}
	if n := s.Pool.Stat().AcquiredConns(); n != 0 {
		t.Fatalf("%d connections remain checked out", n)
	}
}

func TestExportAbortsPartialDownload(t *testing.T) {
	s, base := testBackend(t)
	a := signedExportAccount(t, s, base, "broken")
	ctx := t.Context()
	// Write enough project entries for the client to receive response headers
	// and ZIP bytes before the invalid document is encountered.
	if _, err := s.Pool.Exec(ctx, `INSERT INTO projects(id,user_id,name,description,focus_points)
        SELECT gen_random_uuid(),$1,'项目'||i,'项目简介','[]' FROM generate_series(1,100) i`, a.uid); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `INSERT INTO collections(id,user_id,document,plain_text,intent)
        VALUES(gen_random_uuid(),$1,'{"schema_version":2}','待修复','')`, a.uid); err != nil {
		t.Fatal(err)
	}
	resp, err := a.download(t, "markdown")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	partial, err := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || len(partial) == 0 || err == nil {
		t.Fatalf("partial download status=%d bytes=%d err=%v", resp.StatusCode, len(partial), err)
	}
	if n := s.Pool.Stat().AcquiredConns(); n != 0 {
		t.Fatalf("%d connections remain checked out", n)
	}
	expireExport(t, a)
	resp, err = a.download(t, "json")
	if err != nil {
		t.Fatal(err)
	}
	archiveFiles(t, resp)
}

func TestExportQuotaConcurrent(t *testing.T) {
	s, _ := testBackend(t)
	results := make(chan int, 8)
	for range cap(results) {
		go func() {
			retry, err := s.reserveExport(t.Context(), "same-test-user")
			if err != nil {
				retry = -1
			}
			results <- retry
		}()
	}
	grants := 0
	for range cap(results) {
		switch retry := <-results; {
		case retry == 0:
			grants++
		case retry < 590 || retry > 600:
			t.Fatalf("unexpected remaining window %d", retry)
		}
	}
	if grants != 1 {
		t.Fatalf("simultaneous grants=%d", grants)
	}
}

type exportTestConn struct{ net.Conn }

func (exportTestConn) Header() http.Header { return nil }
func (exportTestConn) WriteHeader(int)     {}

func TestExportStalledWrite(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	// No reader drains the pipe. The remaining request lifetime is shorter
	// than the per-write timeout and must interrupt this write.
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	output := exportHTTPWriter{ctx, server, http.NewResponseController(exportTestConn{server}), time.Now().Add(40 * time.Millisecond)}
	if _, err := output.Write([]byte("data")); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("blocked write: %v", err)
	}
	cancel()
	if _, err := output.Write([]byte("data")); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled write: %v", err)
	}
}
