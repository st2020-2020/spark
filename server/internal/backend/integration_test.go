package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"spark/server/db"
)

// Every test gets its own schema inside an explicitly selected test database.
// There is no truncate/drop-database path and the persistent dev database is refused.
func testBackend(t *testing.T) (*Server, string) {
	t.Helper()
	raw := os.Getenv("SPARK_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("SPARK_TEST_DATABASE_URL is not set; PostgreSQL integration tests skipped")
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(cfg.ConnConfig.Database, "_test") {
		t.Fatal("integration database name must end with _test")
	}
	ctx := context.Background()
	root, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(root.Close)
	schema := "spark_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = root.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := root.Exec(context.Background(), `DROP SCHEMA `+pgx.Identifier{schema}.Sanitize()+` CASCADE`); err != nil {
			t.Errorf("remove isolated test schema: %v", err)
		}
	})
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err = db.Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err = db.Migrate(ctx, pool); err != nil {
		t.Fatal("repeat migration:", err)
	}
	if err = db.Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	app, err := New(ctx, Config{Env: "development", Addr: "127.0.0.1:8080", Origin: "http://127.0.0.1:5173", Secret: bytes.Repeat([]byte{1}, 32), EncryptionKey: bytes.Repeat([]byte{2}, 32), MailMode: "development", AITrial: AITrialScope{development: true}}, pool)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Router())
	t.Cleanup(srv.Close)
	return app, srv.URL
}

type apiClient struct {
	t    *testing.T
	app  *Server
	base string
	http *http.Client
	csrf string
}
type apiResponse struct {
	status int
	body   map[string]any
	header http.Header
}

func newClient(t *testing.T, s *Server, base string) *apiClient {
	jar, _ := cookiejar.New(nil)
	return &apiClient{t: t, app: s, base: base, http: &http.Client{Jar: jar, Timeout: 20 * time.Second}}
}
func (a *apiClient) do(method, path string, body any, key string) apiResponse {
	return a.withHeaders(method, path, body, key, map[string]string{})
}
func (a *apiClient) withHeaders(method, path string, body any, key string, headers map[string]string) apiResponse {
	a.t.Helper()
	var content io.Reader
	if body != nil {
		content = bytes.NewReader(jsonBytes(body))
	}
	req, err := http.NewRequest(method, a.base+"/api/v1"+path, content)
	if err != nil {
		a.t.Fatal(err)
	}
	req.Header.Set("Origin", a.app.Config.Origin)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", a.csrf)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := a.http.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		a.t.Fatal(err)
	}
	out := apiResponse{status: resp.StatusCode, header: resp.Header}
	if len(b) > 0 {
		if err = json.Unmarshal(b, &out.body); err != nil {
			a.t.Fatalf("invalid JSON response (%s %s)", method, path)
		}
		route := strings.SplitN(path, "?", 2)[0]
		for _, p := range strings.Split(route, "/") {
			if _, e := uuid.Parse(p); e == nil {
				route = strings.ReplaceAll(route, p, "{id}")
			}
		}
		if p := a.app.spec.Paths.Value(route); p != nil {
			if op := p.GetOperation(method); op != nil {
				r := op.Responses.Status(resp.StatusCode)
				if r == nil {
					r = op.Responses.Default()
				}
				if r != nil {
					if media := r.Value.Content.Get("application/json"); media != nil {
						if e := media.Schema.Value.VisitJSON(out.body); e != nil {
							a.t.Errorf("response violates contract: %s %s status %d: %v", method, route, resp.StatusCode, e)
						}
					}
				}
			}
		}
	}
	return out
}
func (r apiResponse) want(t *testing.T, status int) map[string]any {
	t.Helper()
	if r.status != status {
		code := ""
		if e, ok := r.body["error"].(map[string]any); ok {
			code, _ = e["code"].(string)
		}
		t.Fatalf("HTTP status=%d want=%d error_code=%s", r.status, status, code)
	}
	return r.body
}
func (a *apiClient) signIn(email string) {
	r := a.do("POST", "/auth/login", map[string]any{"email": email, "password": "test-password-12345"}, "").want(a.t, 200)
	a.csrf = r["csrf_token"].(string)
}
func (a *apiClient) challenge(email, purpose string) (string, string) {
	a.t.Helper()
	res := a.do("POST", "/auth/verification", map[string]any{"email": email, "purpose": purpose}, "")
	body := res.want(a.t, 202)
	if res.header.Get("X-Spark-Mail-Adapter") != "development" {
		a.t.Fatal("development delivery must be marked")
	}
	id := body["challenge_id"].(string)
	raw, err := a.app.DevelopmentMail(context.Background(), id)
	if err != nil {
		a.t.Fatal(err)
	}
	var mail map[string]any
	if json.Unmarshal(raw, &mail) != nil {
		a.t.Fatal("invalid development message")
	}
	if _, err = a.app.DevelopmentMail(context.Background(), id); err == nil {
		a.t.Fatal("development message must only be read once")
	}
	return id, mail["verification_code"].(string)
}
func (a *apiClient) registration(email, invite string) map[string]any {
	id, code := a.challenge(email, "register")
	return map[string]any{"email": email, "password": "test-password-12345", "challenge_id": id, "verification_code": code, "invite_code": invite}
}
func (a *apiClient) invite(codes ...string) string {
	a.t.Helper()
	csv := "code,expires_at,max_uses\n"
	for _, code := range codes {
		csv += code + ",,1\n"
	}
	preview := a.do("POST", "/admin/invite-imports", map[string]any{"name": "Isolated integration batch", "csv": csv}, uuid.NewString()).want(a.t, 201)
	if len(preview["errors"].([]any)) != 0 {
		a.t.Fatal("unexpected preview errors")
	}
	id := preview["id"].(string)
	key := uuid.NewString()
	batch := a.do("POST", "/admin/invite-imports/"+id+"/commit", nil, key).want(a.t, 201)
	again := a.do("POST", "/admin/invite-imports/"+id+"/commit", nil, key)
	again.want(a.t, 201)
	if again.header.Get("Idempotent-Replayed") != "true" {
		a.t.Fatal("commit should replay")
	}
	return batch["id"].(string)
}
func textDocument(text string) map[string]any {
	return map[string]any{"schema_version": 1, "content": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": text}}}}}}
}
func collectionInput(id, text string) map[string]any {
	return map[string]any{"id": id, "document": textDocument(text), "intent": "参考搜索用途", "upload_ids": []string{}, "project_ids": []string{}, "tag_ids": []string{}}
}
func TestPostgresWorkflow(t *testing.T) {
	app, base := testBackend(t)
	ctx := context.Background()
	if err := app.BootstrapAdmin(ctx, "admin@example.test", "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	admin := newClient(t, app, base)
	admin.signIn("admin@example.test")
	t.Run("health and browser security", func(t *testing.T) {
		admin.do("GET", "/health/live", nil, "").want(t, 200)
		admin.do("GET", "/health/ready", nil, "").want(t, 200)
		admin.withHeaders("POST", "/auth/login", map[string]any{"email": "admin@example.test", "password": "test-password-12345"}, "", map[string]string{"Origin": "https://attacker.invalid"}).want(t, 403)
		admin.withHeaders("POST", "/projects", map[string]any{"name": "project", "description": "", "focus_points": []string{}}, uuid.NewString(), map[string]string{"X-CSRF-Token": "bad"}).want(t, 403)
		session := admin.do("GET", "/auth/session", nil, "").want(t, 200)
		if session["csrf_token"] != admin.csrf {
			t.Fatal("refresh must restore CSRF token")
		}
		admin.do("POST", "/projects", map[string]any{"name": "project", "description": "", "focus_points": []string{}, "unknown": true}, uuid.NewString()).want(t, 422)
		u, _ := url.Parse(base)
		cookie := admin.http.Jar.Cookies(u)
		if len(cookie) != 1 || cookie[0].Name != "spark_session" {
			t.Fatal("session cookie missing")
		}
	})
	admin.invite("INVITE-USER-0001", "INVITE-USER-0002")
	alice := newClient(t, app, base)
	reg := alice.registration("alice@example.test", "INVITE-USER-0001")
	res := alice.do("POST", "/auth/register", reg, "")
	registered := res.want(t, 201)
	alice.csrf = registered["csrf_token"].(string)
	if !strings.Contains(res.header.Get("Set-Cookie"), "HttpOnly") || !strings.Contains(res.header.Get("Set-Cookie"), "SameSite=Lax") || strings.Contains(res.header.Get("Set-Cookie"), "Secure") {
		t.Fatal("development cookie attributes incorrect")
	}
	bob := newClient(t, app, base)
	registered = bob.do("POST", "/auth/register", bob.registration("bob@example.test", "INVITE-USER-0002"), "").want(t, 201)
	bob.csrf = registered["csrf_token"].(string)
	project := map[string]any{"name": "Spark 产品开发", "description": "检索和同步", "focus_points": []string{"搜索"}}
	key := uuid.NewString()
	p := alice.do("POST", "/projects", project, key).want(t, 201)
	pid := p["id"].(string)
	replay := alice.do("POST", "/projects", project, key)
	replay.want(t, 201)
	if replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("project replay missing")
	}
	t.Run("user isolation and project versions", func(t *testing.T) {
		bob.do("GET", "/projects/"+pid, nil, "").want(t, 404)
		bob.do("PATCH", "/projects/"+pid, map[string]any{"base_version": 1, "name": "stolen"}, "").want(t, 404)
		if len(bob.do("GET", "/projects", nil, "").want(t, 200)["items"].([]any)) != 0 {
			t.Fatal("projects leaked")
		}
		alice.do("PATCH", "/projects/"+pid, map[string]any{"base_version": 1, "state": "paused"}, "").want(t, 200)
		alice.do("PATCH", "/projects/"+pid, map[string]any{"base_version": 1, "name": "stale"}, "").want(t, 409)
	})
	id := uuid.NewString()
	input := collectionInput(id, "离线同步方案 100% _keyword MixedCASE")
	saved := alice.do("POST", "/collections", input, uuid.NewString()).want(t, 201)
	if saved["organization"].(map[string]any)["status"] != "skipped" {
		t.Fatal("unconfigured organization cannot claim success")
	}
	t.Run("content decisions and conflict boundaries", func(t *testing.T) {
		bob.do("GET", "/collections/"+id, nil, "").want(t, 404)
		bob.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "intent": "stolen"}, "").want(t, 404)
		bob.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": pid, "action": "include"}}}, "").want(t, 404)
		foreign := collectionInput(uuid.NewString(), "foreign reference")
		foreign["project_ids"] = []string{pid}
		bob.do("POST", "/collections", foreign, uuid.NewString()).want(t, 404)
		assoc := alice.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": pid, "action": "include"}}}, "").want(t, 200)
		if assoc["content_version"] != float64(1) || assoc["decision_version"] != float64(2) {
			t.Fatal("decision must not change content version")
		}
		alice.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 1, "operations": []any{map[string]any{"id": pid, "action": "exclude"}}}, "").want(t, 409)
		assoc = alice.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 2, "operations": []any{map[string]any{"id": pid, "action": "exclude"}}}, "").want(t, 200)
		if assoc["projects"].([]any)[0].(map[string]any)["decision"] != "rejected" {
			t.Fatal("manual exclusion lost")
		}
		unchanged := alice.do("PATCH", "/collections/"+id+"/projects", map[string]any{"base_decision_version": 3, "operations": []any{map[string]any{"id": pid, "action": "exclude"}}}, "").want(t, 200)
		if unchanged["decision_version"] != float64(3) {
			t.Fatal("no-op increments version")
		}
		alice.do("PUT", "/collections/"+id+"/read", map[string]any{"read": true}, "").want(t, 200)
		edited := alice.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "intent": "updated 搜索用途"}, "").want(t, 200)
		if edited["content_version"] != float64(2) || edited["decision_version"] != float64(3) {
			t.Fatal("edit used wrong version axis")
		}
		alice.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "intent": "stale"}, "").want(t, 409)
		if edited["projects"].([]any)[0].(map[string]any)["decision"] != "rejected" {
			t.Fatal("content edit overwrote manual choice")
		}
	})
	t.Run("literal Chinese search and signed pagination", func(t *testing.T) {
		for _, q := range []string{"同步", "100%", "_keyword", "mixedcase", "同步 搜索用途"} {
			hits := alice.do("GET", "/search?q="+url.QueryEscape(q), nil, "").want(t, 200)["items"].([]any)
			if len(hits) != 1 {
				t.Fatalf("search %q returned %d", q, len(hits))
			}
			if len(hits[0].(map[string]any)["snippets"].([]any)) == 0 {
				t.Fatal("missing matching snippet")
			}
		}
		if len(bob.do("GET", "/search?q=同步", nil, "").want(t, 200)["items"].([]any)) != 0 {
			t.Fatal("search leaked")
		}
		if len(alice.do("GET", "/collections?project_id="+pid, nil, "").want(t, 200)["items"].([]any)) != 0 {
			t.Fatal("rejected association counted as included")
		}
		alice.do("POST", "/collections", collectionInput(uuid.NewString(), "second page"), uuid.NewString()).want(t, 201)
		page := alice.do("GET", "/collections?limit=1", nil, "").want(t, 200)
		cursor := page["next_cursor"].(string)
		second := alice.do("GET", "/collections?limit=1&cursor="+url.QueryEscape(cursor), nil, "").want(t, 200)
		if page["items"].([]any)[0].(map[string]any)["id"] == second["items"].([]any)[0].(map[string]any)["id"] {
			t.Fatal("pagination repeated row")
		}
		bob.do("GET", "/collections?limit=1&cursor="+url.QueryEscape(cursor), nil, "").want(t, 400)
		alice.do("GET", "/collections?limit=1&scope=trash&cursor="+url.QueryEscape(cursor), nil, "").want(t, 400)
		alice.do("GET", "/collections?limit=1&cursor="+url.QueryEscape(cursor+"x"), nil, "").want(t, 400)
	})
	t.Run("concurrent idempotency and edits", func(t *testing.T) {
		id := uuid.NewString()
		input := collectionInput(id, "concurrent retries")
		key := uuid.NewString()
		responses := make(chan apiResponse, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() { defer wg.Done(); responses <- alice.do("POST", "/collections", input, key) }()
		}
		wg.Wait()
		close(responses)
		for r := range responses {
			if r.status != 201 && r.status != 409 {
				r.want(t, 201)
			}
		}
		alice.do("POST", "/collections", input, key).want(t, 201)
		reordered := collectionInput(id, "concurrent retries")
		reordered["document"] = json.RawMessage(`{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"concurrent retries"}]}]}}`)
		replay := alice.do("POST", "/collections", reordered, key)
		replay.want(t, 201)
		if replay.header.Get("Idempotent-Replayed") != "true" {
			t.Fatal("JSON field order changed idempotency")
		}
		unchanged := alice.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "document": reordered["document"]}, "").want(t, 200)
		if unchanged["content_version"] != float64(1) {
			t.Fatal("equivalent JSON changed content version")
		}
		var count int
		if err := app.Pool.QueryRow(ctx, `SELECT count(*) FROM collections WHERE id=$1`, id).Scan(&count); err != nil || count != 1 {
			t.Fatal("idempotency did not create exactly once")
		}
		changed := collectionInput(id, "different intent")
		alice.do("POST", "/collections", changed, key).want(t, 409)
		responses = make(chan apiResponse, 2)
		for _, intent := range []string{"one", "two"} {
			wg.Add(1)
			go func(intent string) {
				defer wg.Done()
				responses <- alice.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 1, "intent": intent}, "")
			}(intent)
		}
		wg.Wait()
		close(responses)
		ok, conflicts := 0, 0
		for r := range responses {
			if r.status == 200 {
				ok++
			}
			if r.status == 409 {
				conflicts++
			}
		}
		if ok != 1 || conflicts != 1 {
			t.Fatal("concurrent edits must produce one winner and one conflict")
		}
	})
	t.Run("invalid documents remain unsaved", func(t *testing.T) {
		invalid := collectionInput(uuid.NewString(), "safe")
		invalid["document"] = map[string]any{"schema_version": 2, "content": map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph"}}}}
		alice.do("POST", "/collections", invalid, uuid.NewString()).want(t, 422)
		invalid["document"] = textDocument("safe")
		invalid["original_url"] = "javascript:alert(1)"
		alice.do("POST", "/collections", invalid, uuid.NewString()).want(t, 422)
		invalid["original_url"] = "https://user:pass@example.test"
		alice.do("POST", "/collections", invalid, uuid.NewString()).want(t, 422)
		invalid["document"] = textDocument(strings.Repeat("中", 50000))
		invalid["intent"] = "多"
		delete(invalid, "original_url")
		alice.do("POST", "/collections", invalid, uuid.NewString()).want(t, 422)
	})
	t.Run("trash hides search and blocks writes", func(t *testing.T) {
		row := alice.do("GET", "/collections/"+id, nil, "").want(t, 200)
		trash := alice.do("DELETE", "/collections/"+id, map[string]any{"base_resource_version": row["resource_version"]}, "").want(t, 200)
		if len(alice.do("GET", "/search?q=同步", nil, "").want(t, 200)["items"].([]any)) != 0 {
			t.Fatal("trash remained searchable")
		}
		alice.do("PATCH", "/collections/"+id, map[string]any{"base_content_version": 2, "intent": "blocked"}, "").want(t, 409)
		alice.do("POST", "/collections/"+id+"/restore", map[string]any{"base_resource_version": trash["resource_version"]}, "").want(t, 200)
	})
	t.Run("concurrent single-use invite", func(t *testing.T) {
		admin.invite("SINGLE-USE-0001")
		one, two := newClient(t, app, base), newClient(t, app, base)
		r1 := one.registration("one@example.test", "SINGLE-USE-0001")
		r2 := two.registration("two@example.test", "SINGLE-USE-0001")
		responses := make(chan apiResponse, 2)
		var wg sync.WaitGroup
		for _, v := range []struct {
			client *apiClient
			body   map[string]any
		}{{one, r1}, {two, r2}} {
			wg.Add(1)
			go func(v struct {
				client *apiClient
				body   map[string]any
			}) {
				defer wg.Done()
				responses <- v.client.do("POST", "/auth/register", v.body, "")
			}(v)
		}
		wg.Wait()
		close(responses)
		success, rejected := 0, 0
		for r := range responses {
			if r.status == 201 {
				success++
			}
			if r.status == 409 {
				rejected++
			}
		}
		if success != 1 || rejected != 1 {
			t.Fatal("single-use invite race must yield one registration")
		}
		var used, users int
		if err := app.Pool.QueryRow(ctx, `SELECT used_count FROM invite_codes WHERE code_digest=$1`, app.mac("invite", "SINGLE-USE-0001")).Scan(&used); err != nil {
			t.Fatal(err)
		}
		if err := app.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE email_normalized IN ('one@example.test','two@example.test')`).Scan(&users); err != nil {
			t.Fatal(err)
		}
		if used != 1 || users != 1 {
			t.Fatal("invite and user creation not atomic")
		}
	})
	t.Run("registration failure rolls everything back", func(t *testing.T) {
		admin.invite("ROLLBACK-INVITE-01")
		client := newClient(t, app, base)
		body := client.registration("rollback@example.test", "ROLLBACK-INVITE-01")
		if _, err := app.Pool.Exec(ctx, `ALTER TABLE sessions ADD CONSTRAINT test_session_failure CHECK(device_label <> 'rollback-fixture')`); err != nil {
			t.Fatal(err)
		}
		client.withHeaders("POST", "/auth/register", body, "", map[string]string{"User-Agent": "rollback-fixture"}).want(t, 503)
		if _, err := app.Pool.Exec(ctx, `ALTER TABLE sessions DROP CONSTRAINT test_session_failure`); err != nil {
			t.Fatal(err)
		}
		var count, used int
		var consumed *time.Time
		if err := app.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE email_normalized='rollback@example.test'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if err := app.Pool.QueryRow(ctx, `SELECT used_count FROM invite_codes WHERE code_digest=$1`, app.mac("invite", "ROLLBACK-INVITE-01")).Scan(&used); err != nil {
			t.Fatal(err)
		}
		if err := app.Pool.QueryRow(ctx, `SELECT consumed_at FROM email_challenges WHERE id=$1`, body["challenge_id"]).Scan(&consumed); err != nil {
			t.Fatal(err)
		}
		if count != 0 || used != 0 || consumed != nil {
			t.Fatal("registration failed to roll back")
		}
		client.do("POST", "/auth/register", body, "").want(t, 201)
	})
	t.Run("verification attempt cap and invite disabling", func(t *testing.T) {
		batch := admin.invite("DISABLED-INVITE-01")
		admin.do("PATCH", "/admin/invite-batches/"+batch, map[string]any{"status": "disabled"}, "").want(t, 200)
		client := newClient(t, app, base)
		body := client.registration("disabled@example.test", "DISABLED-INVITE-01")
		client.do("POST", "/auth/register", body, "").want(t, 409)
		admin.do("PATCH", "/admin/invite-batches/"+batch, map[string]any{"status": "active"}, "").want(t, 200)
		original := body["verification_code"].(string)
		wrong := "000000"
		if wrong == original {
			wrong = "000001"
		}
		body["verification_code"] = wrong
		for range 5 {
			client.do("POST", "/auth/register", body, "").want(t, 422)
		}
		body["verification_code"] = original
		client.do("POST", "/auth/register", body, "").want(t, 422)
	})
	t.Run("password reset revokes sessions", func(t *testing.T) {
		other := newClient(t, app, base)
		other.signIn("alice@example.test")
		challenge, code := alice.challenge("alice@example.test", "password_reset")
		alice.do("POST", "/auth/password-reset", map[string]any{"email": "alice@example.test", "challenge_id": challenge, "verification_code": code, "new_password": "new-test-password-12345"}, "").want(t, 204)
		other.do("GET", "/auth/session", nil, "").want(t, 401)
		alice.do("GET", "/auth/session", nil, "").want(t, 401)
		alice.do("POST", "/auth/login", map[string]any{"email": "alice@example.test", "password": "test-password-12345"}, "").want(t, 401)
		result := alice.do("POST", "/auth/login", map[string]any{"email": "alice@example.test", "password": "new-test-password-12345"}, "").want(t, 200)
		alice.csrf = result["csrf_token"].(string)
		alice.do("POST", "/auth/logout", nil, "").want(t, 204)
		alice.do("GET", "/auth/session", nil, "").want(t, 401)
	})
}
