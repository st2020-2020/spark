package backend

import (
	"encoding/base64"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func extensionTestPair() (verifier, challenge string) {
	verifier = randomToken()
	return verifier, base64.RawURLEncoding.EncodeToString(digest(verifier))
}

func extensionError(t *testing.T, res apiResponse, status int, code string) {
	t.Helper()
	if body := res.want(t, status); body["error"].(map[string]any)["code"] != code {
		t.Fatalf("expected %s", code)
	}
}

func TestExtensionGrantIsOneTimeAndCredentialIsScoped(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "extension-owner")
	other := signedExportAccount(t, app, base, "extension-other")
	ext := newClient(t, app, base)
	verifier, challenge := extensionTestPair()
	grant := map[string]any{"challenge": challenge, "browser": "chrome", "expected_account_id": owner.uid}
	exchange := map[string]string{"verifier": verifier}
	extensionError(t, ext.do("POST", "/extension/token", exchange, ""), 404, "extension_grant_pending")
	extensionError(t, other.do("POST", "/extension/grants", grant, ""), 409, "extension_account_changed")
	owner.withHeaders("POST", "/extension/grants", grant, "", map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	owner.withHeaders("POST", "/extension/grants", grant, "", map[string]string{"Origin": "https://foreign.example.test"}).want(t, 403)
	owner.do("POST", "/extension/grants", grant, "").want(t, 204)
	owner.do("POST", "/extension/grants", grant, "").want(t, 204)
	minted := ext.do("POST", "/extension/token", exchange, "")
	token := minted.want(t, 200)
	if len(token) != 4 || token["account_id"] != owner.uid || token["account_label"] != "extension-owner@example.test" ||
		minted.header.Get("Set-Cookie") != "" {
		t.Fatal("exchange returned excess data, a cookie, or the wrong account")
	}
	headers := map[string]string{"Authorization": "Bearer " + token["token"].(string)}
	info := ext.withHeaders("GET", "/extension/session", nil, "", headers).want(t, 200)
	if len(info) != 3 || info["account_id"] != owner.uid {
		t.Fatal("extension session disclosed excess data or the wrong account")
	}
	extensionError(t, ext.do("POST", "/extension/token", exchange, ""), 401, "extension_grant_invalid")
	owner.do("POST", "/extension/grants", grant, "").want(t, 409)
	ext.withHeaders("GET", "/auth/session", nil, "", headers).want(t, 401)
	ext.withHeaders("GET", "/auth/session", nil, "", map[string]string{"Cookie": "spark_session=" + token["token"].(string)}).want(t, 401)
	owner.do("GET", "/extension/session", nil, "").want(t, 401)

	list := owner.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any)
	var id string
	for _, row := range list {
		session := row.(map[string]any)
		if session["device_label"] == "Spark 浏览器扩展 (Chrome)" {
			id = session["id"].(string)
		}
	}
	if id == "" {
		t.Fatal("bound extension was missing from Web device management")
	}
	other.do("DELETE", "/sessions/"+id, nil, "").want(t, 404)
	owner.do("DELETE", "/sessions/"+id, nil, "").want(t, 204)
	extensionError(t, ext.withHeaders("GET", "/extension/session", nil, "", headers), 401, "extension_session_expired")
	owner.do("GET", "/auth/session", nil, "").want(t, 200)
}

func approveTestExtension(t *testing.T, web exportAccount) string {
	t.Helper()
	verifier, challenge := extensionTestPair()
	web.do("POST", "/extension/grants", map[string]string{
		"challenge": challenge, "browser": "edge", "expected_account_id": web.uid,
	}, "").want(t, 204)
	return verifier
}

func exchangeTestExtension(ext *apiClient, verifier string) apiResponse {
	return ext.do("POST", "/extension/token", map[string]string{"verifier": verifier}, "")
}

func extensionHeaders(t *testing.T, res apiResponse) map[string]string {
	t.Helper()
	return map[string]string{"Authorization": "Bearer " + res.want(t, 200)["token"].(string)}
}

func TestExtensionGrantExpiryAndRevocation(t *testing.T) {
	app, base := testBackend(t)
	web := signedExportAccount(t, app, base, "extension-expiration")
	ext := newClient(t, app, base)
	verifier := approveTestExtension(t, web)
	if _, err := app.Pool.Exec(t.Context(), `UPDATE device_grants SET expires_at=now()-interval '1 second' WHERE kind='extension' AND challenge=$1`, digest(verifier)); err != nil {
		t.Fatal(err)
	}
	extensionError(t, exchangeTestExtension(ext, verifier), 401, "extension_grant_invalid")
	web.do("POST", "/extension/grants", map[string]string{
		"challenge": base64.RawURLEncoding.EncodeToString(digest(verifier)), "browser": "edge", "expected_account_id": web.uid,
	}, "").want(t, 409)

	verifier = approveTestExtension(t, web)
	var results [2]apiResponse
	start := make(chan struct{})
	var requests sync.WaitGroup
	for i := range results {
		requests.Go(func() {
			<-start
			results[i] = exchangeTestExtension(ext, verifier)
		})
	}
	close(start)
	requests.Wait()
	minted := 0
	for _, res := range results {
		if res.status == 200 {
			minted++
			headers := extensionHeaders(t, res)
			ext.withHeaders("DELETE", "/extension/session", nil, "", headers).want(t, 204)
			extensionError(t, ext.withHeaders("GET", "/extension/session", nil, "", headers), 401, "extension_session_expired")
		} else {
			extensionError(t, res, 401, "extension_grant_invalid")
		}
	}
	if minted != 1 {
		t.Fatalf("concurrent exchange minted %d sessions", minted)
	}

	kept := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, web)))
	pending := approveTestExtension(t, web)
	web.do("POST", "/auth/logout", nil, "").want(t, 204)
	extensionError(t, exchangeTestExtension(ext, pending), 401, "extension_grant_invalid")
	ext.withHeaders("GET", "/extension/session", nil, "", kept).want(t, 200)
}

func TestExtensionExchangeRacingPasswordResetCannotLeaveActiveCredential(t *testing.T) {
	app, base := testBackend(t)
	const email = "extension-reset@example.test"
	web := signedExportAccount(t, app, base, "extension-reset")
	ext := newClient(t, app, base)
	existing := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, web)))
	racing := approveTestExtension(t, web)
	pending := approveTestExtension(t, web)
	challengeID, code := web.challenge(email, "password_reset")
	start := make(chan struct{})
	var exchange, reset apiResponse
	var requests sync.WaitGroup
	requests.Go(func() {
		<-start
		exchange = exchangeTestExtension(ext, racing)
	})
	requests.Go(func() {
		<-start
		reset = web.do("POST", "/auth/password-reset", map[string]string{
			"email": email, "new_password": "new-test-password-12345",
			"challenge_id": challengeID, "verification_code": code,
		}, "")
	})
	close(start)
	requests.Wait()
	reset.want(t, 204)
	if exchange.status == 200 {
		extensionError(t, ext.withHeaders("GET", "/extension/session", nil, "", extensionHeaders(t, exchange)), 401, "extension_session_expired")
	} else {
		extensionError(t, exchange, 401, "extension_grant_invalid")
	}
	extensionError(t, ext.withHeaders("GET", "/extension/session", nil, "", existing), 401, "extension_session_expired")
	extensionError(t, exchangeTestExtension(ext, racing), 401, "extension_grant_invalid")
	extensionError(t, exchangeTestExtension(ext, pending), 401, "extension_grant_invalid")
}

func TestExtensionProjectChoicesAndCollectionReplay(t *testing.T) {
	app, base := testBackend(t)
	app.Config.PurgeEnabled = true
	owner := signedExportAccount(t, app, base, "extension-save-owner")
	other := signedExportAccount(t, app, base, "extension-save-other")
	ext := newClient(t, app, base)
	ownerAuth := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	otherAuth := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, other)))
	project := func(web exportAccount, name string) string {
		t.Helper()
		res := web.do("POST", "/projects", map[string]any{
			"name": name, "description": "仅本人 Web 可见的合成说明", "focus_points": []string{"仅本人 Web 可见的关注点"},
		}, uuid.NewString()).want(t, 201)
		return res["id"].(string)
	}
	active := project(owner, "合成项目甲")
	second := project(owner, "合成项目乙")
	paused := project(owner, "合成项目丙")
	foreign := project(other, "合成项目甲")
	pause := func(id string) {
		t.Helper()
		owner.do("PATCH", "/projects/"+id, map[string]any{"base_version": 1, "state": "paused"}, "").want(t, 200)
	}
	pause(paused)

	path := "/extension/projects?q=合成项目&limit=1"
	page := ext.withHeaders("GET", path, nil, "", ownerAuth).want(t, 200)
	next := path + "&cursor=" + page["next_cursor"].(string)
	ext.withHeaders("GET", next, nil, "", otherAuth).want(t, 400)
	page2 := ext.withHeaders("GET", next, nil, "", ownerAuth).want(t, 200)
	var ids []string
	for _, current := range []map[string]any{page, page2} {
		items := current["items"].([]any)
		if len(items) != 1 || len(items[0].(map[string]any)) != 2 {
			t.Fatal("project page exposed excess fields or returned an unexpected number of items")
		}
		ids = append(ids, items[0].(map[string]any)["id"].(string))
	}
	if ids[0] != second || ids[1] != active || page2["next_cursor"] != nil {
		t.Fatal("project pagination returned an inactive, foreign, or duplicate project")
	}

	id, key := uuid.NewString(), uuid.NewString()
	selected := "第一行\n<em>保留为纯文本</em>"
	input := map[string]any{"id": id, "manual_title": "合成网页", "selected_text": selected, "intent": "合成用途",
		"original_url": "https://example.test/clip", "project_ids": []string{active}}
	save := func(headers map[string]string) apiResponse {
		t.Helper()
		return ext.withHeaders("POST", "/extension/collections", input, key, headers)
	}
	input["upload_ids"] = []string{}
	extensionError(t, save(ownerAuth), 422, "validation_failed")
	delete(input, "upload_ids")
	input["original_url"] = "file:///tmp/synthetic"
	extensionError(t, save(ownerAuth), 422, "validation_failed")
	input["original_url"] = "https://example.test/clip"
	input["selected_text"] = strings.Repeat("字", 50000)
	extensionError(t, save(ownerAuth), 422, "validation_failed")
	input["selected_text"] = selected
	for _, denied := range []string{paused, foreign} {
		input["project_ids"] = []string{denied}
		extensionError(t, save(ownerAuth), 404, "project_unavailable")
	}
	input["project_ids"] = []string{active}
	extensionError(t, save(otherAuth), 404, "project_unavailable")
	ext.do("POST", "/extension/collections", input, key).want(t, 401)

	// The caller loses its acknowledgement and later submits the same snapshot.
	created := save(ownerAuth).want(t, 201)
	if len(created) != 1 || created["id"] != id {
		t.Fatal("create receipt returned more than the collection ID")
	}
	pause(active)
	replay := save(ownerAuth)
	if replay.want(t, 201)["id"] != id || replay.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("retry did not recover the already-saved collection after a project state change")
	}
	input["intent"] = "更改请求快照"
	extensionError(t, save(ownerAuth), 409, "idempotency_mismatch")
	input["intent"] = "合成用途"
	doc := owner.do("GET", "/collections/"+id, nil, "").want(t, 200)
	root := doc["document"].(map[string]any)["content"].(map[string]any)
	paragraph := root["content"].([]any)[0].(map[string]any)
	node := paragraph["content"].([]any)[0].(map[string]any)
	projectResult := doc["projects"].([]any)
	if node["text"] != selected || doc["display_title"] != "合成网页" || doc["original_url"] != "https://example.test/clip" ||
		doc["intent"] != "合成用途" || len(projectResult) != 1 || projectResult[0].(map[string]any)["decision"] != "manual" {
		t.Fatal("application readback lost the captured content or manual project association")
	}
	other.do("GET", "/collections/"+id, nil, "").want(t, 404)
	if len(owner.do("GET", "/collections", nil, "").want(t, 200)["items"].([]any)) != 1 {
		t.Fatal("replay created a duplicate collection")
	}
	ext.withHeaders("DELETE", "/extension/session", nil, "", ownerAuth).want(t, 204)
	extensionError(t, save(ownerAuth), 401, "extension_session_expired")
	ownerAuth = extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, owner)))
	rebound := save(ownerAuth)
	if rebound.want(t, 201)["id"] != id || rebound.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("same-account rebind lost the original idempotent result")
	}

	owner.do("DELETE", "/collections/"+id, map[string]int{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", "/collections/"+id+"/purge", map[string]int{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	extensionError(t, save(ownerAuth), 409, "duplicate_resource")
}

func TestExtensionCanSaveTitleAndURLWithoutSelection(t *testing.T) {
	app, base := testBackend(t)
	web := signedExportAccount(t, app, base, "extension-link-only")
	ext := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestExtension(ext, approveTestExtension(t, web)))
	id := uuid.NewString()
	ext.withHeaders("POST", "/extension/collections", map[string]any{
		"id": id, "original_url": "https://example.test/link", "manual_title": "仅网址标题", "project_ids": []string{},
	}, uuid.NewString(), headers).want(t, 201)
	doc := web.do("GET", "/collections/"+id, nil, "").want(t, 200)
	if doc["display_title"] != "仅网址标题" || doc["original_url"] != "https://example.test/link" {
		t.Fatal("link-only capture dependency on selected or extracted text")
	}
}

func TestExtensionExchangeWaitsForApprovingSessionRevocation(t *testing.T) {
	app, base := testBackend(t)
	web := signedExportAccount(t, app, base, "extension-device-race")
	ext := newClient(t, app, base)
	verifier := approveTestExtension(t, web)
	items := web.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any)
	sessionID := items[0].(map[string]any)["id"].(string)

	// Hold the revocation write uncommitted until the exchange reaches the
	// shared session row. Without the row lock it could mint from a stale read.
	tx, err := app.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	var revoker int32
	if err := tx.QueryRow(t.Context(), `UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2
		RETURNING pg_backend_pid()`, sessionID, web.uid).Scan(&revoker); err != nil {
		t.Fatal(err)
	}
	result := make(chan apiResponse, 1)
	go func() { result <- exchangeTestExtension(ext, verifier) }()
	checkPurgeEventually(t, "extension exchange waiting on session revocation", func() bool {
		var waiting bool
		if err := app.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE query LIKE 'SELECT true FROM sessions WHERE id=%' AND $1=ANY(pg_blocking_pids(pid)))`, revoker).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		return waiting
	})
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	extensionError(t, <-result, 401, "extension_grant_invalid")
}
