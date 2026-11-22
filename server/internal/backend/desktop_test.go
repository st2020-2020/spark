package backend

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func desktopTestPair() (verifier, challenge string) {
	verifier = randomToken()
	hash := sha256.Sum256([]byte("spark-desktop-pair-v1:" + verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(hash[:])
}

func approveTestDesktop(t *testing.T, web exportAccount) string {
	t.Helper()
	verifier, challenge := desktopTestPair()
	web.do("POST", "/desktop/grants", map[string]string{
		"challenge": challenge, "expected_account_id": web.uid,
	}, "").want(t, 204)
	return verifier
}

func exchangeTestDesktop(client *apiClient, verifier string) apiResponse {
	return client.do("POST", "/desktop/token", map[string]string{"verifier": verifier}, "")
}

func TestDesktopPairIsOneTimeAndDeviceSpecific(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "desktop-pair-owner")
	other := signedExportAccount(t, app, base, "desktop-pair-other")
	client := newClient(t, app, base)
	verifier, challenge := desktopTestPair()
	approval := map[string]string{"challenge": challenge, "expected_account_id": owner.uid}
	owner.withHeaders("POST", "/desktop/grants", approval, "", map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	owner.withHeaders("POST", "/desktop/grants", approval, "", map[string]string{"Origin": "https://foreign.example.test"}).want(t, 403)
	extensionError(t, other.do("POST", "/desktop/grants", approval, ""), 409, "desktop_account_changed")
	extensionError(t, exchangeTestDesktop(client, verifier), 404, "desktop_grant_pending")
	owner.do("POST", "/desktop/grants", approval, "").want(t, 204)
	owner.do("POST", "/desktop/grants", approval, "").want(t, 204)
	extensionError(t, exchangeTestExtension(client, verifier), 404, "extension_grant_pending")
	extensionVerifier := approveTestExtension(t, owner)
	extensionError(t, exchangeTestDesktop(client, extensionVerifier), 404, "desktop_grant_pending")

	var exchanges [2]apiResponse
	var group sync.WaitGroup
	for i := range exchanges {
		group.Go(func() { exchanges[i] = exchangeTestDesktop(client, verifier) })
	}
	group.Wait()
	response, denied := exchanges[0], exchanges[1]
	if response.status != 200 {
		response, denied = denied, response
	}
	extensionError(t, denied, 401, "desktop_grant_invalid")
	token := response.want(t, 200)
	exp, err := time.Parse(time.RFC3339Nano, token["expires_at"].(string))
	if expires := time.Until(exp); err != nil || expires < 30*24*time.Hour-time.Minute || expires > 30*24*time.Hour ||
		len(token) != 4 || token["account_id"] != owner.uid || token["account_label"] != "desktop-pair-owner@example.test" ||
		response.header.Get("Set-Cookie") != "" {
		t.Fatal("desktop token expired incorrectly or was not an independent minimal session")
	}
	headers := extensionHeaders(t, response)
	info := client.withHeaders("GET", "/desktop/session", nil, "", headers).want(t, 200)
	if len(info) != 3 || info["expires_at"] != token["expires_at"] || info["account_id"] != owner.uid {
		t.Fatal("reading the session renewed it or changed its identity")
	}
	extensionError(t, exchangeTestDesktop(client, verifier), 401, "desktop_grant_invalid")
	extensionError(t, owner.do("POST", "/desktop/grants", approval, ""), 409, "desktop_grant_conflict")

	extensionAuth := extensionHeaders(t, exchangeTestExtension(client, extensionVerifier))
	client.withHeaders("GET", "/extension/session", nil, "", extensionAuth).want(t, 200)
	extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", extensionAuth), 401, "desktop_session_expired")
	extensionError(t, client.withHeaders("GET", "/extension/session", nil, "", headers), 401, "extension_session_expired")

	list := owner.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any)
	found := map[string]bool{}
	var desktopID string
	for _, item := range list {
		session := item.(map[string]any)
		kind := session["kind"].(string)
		found[kind] = true
		if kind == "desktop" && session["device_label"] == "Spark macOS 桌面端" {
			desktopID = session["id"].(string)
		}
	}
	if desktopID == "" || !found["web"] || !found["extension"] {
		t.Fatal("device list did not distinguish session kinds")
	}
	other.do("DELETE", "/sessions/"+desktopID, nil, "").want(t, 404)
	owner.do("DELETE", "/sessions/"+desktopID, nil, "").want(t, 204)
	extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", headers), 401, "desktop_session_expired")
	owner.do("GET", "/auth/session", nil, "").want(t, 200)
}

func TestDesktopBusinessScopeAndOfflineCollectionReplay(t *testing.T) {
	app, base := testBackend(t)
	admin := imageTestAccount(t, app, base, "desktop-business-owner")
	user := admin.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)
	owner := exportAccount{admin, user["id"].(string)}
	other := signedExportAccount(t, app, base, "desktop-business-other")
	client := newClient(t, app, base)
	ownerAuth := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	otherAuth := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, other)))

	project := projectForNote(t, owner.apiClient, "桌面测试项目")
	tag := owner.do("POST", "/tags", map[string]string{"name": "桌面测试标签"}, uuid.NewString()).want(t, 201)["id"].(string)
	id, key := uuid.NewString(), uuid.NewString()
	in := collectionInput(id, "桌面离线合成笔记")
	in["project_ids"] = []string{project}
	in["tag_ids"] = []string{tag}
	create := func(headers map[string]string) apiResponse {
		return client.withHeaders("POST", "/collections", in, key, headers)
	}
	owner.withHeaders("POST", "/collections", in, key, map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	owner.withHeaders("POST", "/collections", in, key, map[string]string{"Origin": "https://different.example.test"}).want(t, 403)
	extensionError(t, owner.withHeaders("POST", "/collections", in, key, ownerAuth), 400, "mixed_credentials")
	extensionError(t, create(map[string]string{"Authorization": "Bearer invalid"}), 401, "desktop_session_expired")
	create(otherAuth).want(t, 404)
	created := create(ownerAuth).want(t, 201)
	if created["id"] != id || created["capture_source"] != nil {
		t.Fatal("desktop create did not use the ordinary collection path")
	}
	replayed := owner.do("POST", "/collections", in, key)
	if replayed.want(t, 201)["id"] != id || replayed.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("desktop and Web did not share the normal idempotency operation")
	}
	client.withHeaders("DELETE", "/desktop/session", nil, "", ownerAuth).want(t, 204)
	extensionError(t, create(ownerAuth), 401, "desktop_session_expired")
	ownerAuth = extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	replayed = create(ownerAuth)
	if replayed.want(t, 201)["id"] != id || replayed.header.Get("Idempotent-Replayed") != "true" {
		t.Fatal("offline retry after rebind did not use the original receipt")
	}
	path := "/collections/" + id
	for _, allowed := range []string{"/collections", path, "/projects", "/tags", "/search?q=桌面离线"} {
		client.withHeaders("GET", allowed, nil, "", ownerAuth).want(t, 200)
	}
	if len(client.withHeaders("GET", "/collections", nil, "", ownerAuth).want(t, 200)["items"].([]any)) != 1 {
		t.Fatal("offline retry duplicated the collection")
	}
	client.withHeaders("GET", path, nil, "", otherAuth).want(t, 404)
	for _, denied := range []struct{ method, path string }{
		{"GET", "/auth/session"}, {"GET", "/sessions"}, {"DELETE", "/sessions/" + uuid.NewString()},
		{"GET", "/admin/users"}, {"PATCH", "/me/preferences"}, {"PUT", "/me/image-analysis"},
		{"GET", "/me/export?format=json"}, {"GET", "/me/usage"}, {"GET", "/organization/events"},
		{"POST", "/desktop/grants"}, {"POST", "/extension/grants"},
		{"POST", "/projects"}, {"GET", "/projects/" + project}, {"POST", "/tags"},
		{"PATCH", path}, {"DELETE", path}, {"PUT", path + "/read"}, {"GET", path + "/thread"},
		{"POST", path + "/organization"}, {"POST", path + "/purge"},
	} {
		extensionError(t, client.withHeaders(denied.method, denied.path, nil, "", ownerAuth), 403, "desktop_scope_forbidden")
	}
	extensionError(t, client.withHeaders("POST", "/desktop/token", map[string]string{
		"verifier": approveTestDesktop(t, owner),
	}, "", ownerAuth), 400, "unexpected_credentials")
}

func TestDesktopGrantExpiryResetAndAccountDisable(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "desktop-policy")
	client := newClient(t, app, base)
	expired := approveTestDesktop(t, owner)
	if _, err := app.Pool.Exec(t.Context(), `UPDATE device_grants SET expires_at=now()-interval '1 second'
		WHERE kind='desktop' AND challenge=$1`, digest("spark-desktop-pair-v1:"+expired)); err != nil {
		t.Fatal(err)
	}
	extensionError(t, exchangeTestDesktop(client, expired), 401, "desktop_grant_invalid")

	absolute := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	if _, err := app.Pool.Exec(t.Context(), `UPDATE sessions SET expires_at=now()-interval '1 second'
		WHERE user_id=$1 AND kind='desktop'`, owner.uid); err != nil {
		t.Fatal(err)
	}
	extensionError(t, client.withHeaders("GET", "/collections", nil, "", absolute), 401, "desktop_session_expired")

	disabledToken := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	disabledProof := approveTestDesktop(t, owner)
	if _, err := app.Pool.Exec(t.Context(), "UPDATE users SET status='disabled' WHERE id=$1", owner.uid); err != nil {
		t.Fatal(err)
	}
	extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", disabledToken), 401, "desktop_session_expired")
	extensionError(t, exchangeTestDesktop(client, disabledProof), 401, "desktop_grant_invalid")
	if _, err := app.Pool.Exec(t.Context(), "UPDATE users SET status='active' WHERE id=$1", owner.uid); err != nil {
		t.Fatal(err)
	}

	racing := approveTestDesktop(t, owner)
	pending := approveTestDesktop(t, owner)
	const email = "desktop-policy@example.test"
	challengeID, code := owner.challenge(email, "password_reset")
	start := make(chan struct{})
	var reset, exchange apiResponse
	var group sync.WaitGroup
	group.Go(func() {
		<-start
		exchange = exchangeTestDesktop(client, racing)
	})
	group.Go(func() {
		<-start
		reset = owner.do("POST", "/auth/password-reset", map[string]string{
			"email": email, "new_password": "next-test-password-12345", "challenge_id": challengeID, "verification_code": code,
		}, "")
	})
	close(start)
	group.Wait()
	reset.want(t, 204)
	if exchange.status == 200 {
		extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", extensionHeaders(t, exchange)), 401, "desktop_session_expired")
	} else {
		extensionError(t, exchange, 401, "desktop_grant_invalid")
	}
	extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", disabledToken), 401, "desktop_session_expired")
	extensionError(t, exchangeTestDesktop(client, pending), 401, "desktop_grant_invalid")
}

func TestDesktopUploadAndAttachmentRoutesKeepOwnership(t *testing.T) {
	app, base := testBackend(t)
	_, objectServer, storage := newUploadStorageFixture(t)
	app.Assets = storage
	worker, err := StartAssetWorker(context.Background(), app.Pool, storage)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	client := newClient(t, app, base)
	owner := signedExportAccount(t, app, base, "desktop-upload-owner")
	other := signedExportAccount(t, app, base, "desktop-upload-other")
	ownerAuth := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	otherAuth := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, other)))
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	grant := client.withHeaders("POST", "/uploads", map[string]any{
		"filename": "desktop.png", "mime_type": "image/png", "size_bytes": data.Len(),
	}, uuid.NewString(), ownerAuth).want(t, 201)
	request, err := http.NewRequestWithContext(t.Context(), grant["method"].(string), grant["url"].(string), bytes.NewReader(data.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range grant["headers"].(map[string]any) {
		request.Header.Set(k, v.(string))
	}
	put, err := objectServer.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	put.Body.Close()
	if put.StatusCode != 200 {
		t.Fatalf("signed object PUT status %d", put.StatusCode)
	}
	upload := grant["id"].(string)
	path := "/uploads/" + upload
	client.withHeaders("GET", path, nil, "", otherAuth).want(t, 404)
	client.withHeaders("POST", path+"/complete", nil, "", otherAuth).want(t, 404)
	client.withHeaders("POST", path+"/complete", nil, "", ownerAuth).want(t, 202)
	checkPurgeEventually(t, "desktop asset verification", func() bool {
		return client.withHeaders("GET", path, nil, "", ownerAuth).want(t, 200)["status"] == "ready"
	})

	collection := collectionInput(uuid.NewString(), "桌面图片")
	collection["upload_ids"] = []string{upload}
	saved := client.withHeaders("POST", "/collections", collection, uuid.NewString(), ownerAuth).want(t, 201)
	picture := "/attachments/" + saved["attachments"].([]any)[0].(map[string]any)["id"].(string)
	client.withHeaders("GET", picture+"/download", nil, "", otherAuth).want(t, 404)
	client.withHeaders("GET", picture+"/thumbnail", nil, "", otherAuth).want(t, 404)
	client.withHeaders("GET", picture+"/download", nil, "", ownerAuth).want(t, 200)
	request, err = http.NewRequestWithContext(t.Context(), "GET", base+"/api/v1"+picture+"/thumbnail", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", ownerAuth["Authorization"])
	result, err := client.http.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer result.Body.Close()
	if result.StatusCode != 200 || result.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("desktop thumbnail response status %d", result.StatusCode)
	}
	if _, err := jpeg.Decode(result.Body); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopWriteWaitingForAccountLockCannotOutrunRevocation(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	owner := signedExportAccount(t, app, base, "desktop-write-revoked")
	client := newClient(t, app, base)
	headers := extensionHeaders(t, exchangeTestDesktop(client, approveTestDesktop(t, owner)))
	var desktopID string
	for _, item := range owner.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any) {
		if session := item.(map[string]any); session["kind"] == "desktop" {
			desktopID = session["id"].(string)
		}
	}
	if desktopID == "" {
		t.Fatal("desktop session missing")
	}

	tx, err := app.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	var blocker int32
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid() FROM user_change_counters WHERE user_id=$1 FOR UPDATE`, owner.uid).Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	result := make(chan apiResponse, 1)
	go func() {
		result <- client.withHeaders("POST", "/collections", collectionInput(id, "等待写入的合成笔记"), uuid.NewString(), headers)
	}()
	checkPurgeEventually(t, "authenticated desktop write waits for account lock", func() bool {
		var waiting bool
		if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		return waiting
	})
	owner.do("DELETE", "/sessions/"+desktopID, nil, "").want(t, 204)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	extensionError(t, <-result, 401, "desktop_session_expired")
	owner.do("GET", "/collections/"+id, nil, "").want(t, 404)
}
