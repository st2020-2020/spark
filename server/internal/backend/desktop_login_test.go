package backend

import (
	"testing"
	"time"
)

func TestDesktopPasswordLoginIssuesOnlyDesktopSession(t *testing.T) {
	app, base := testBackend(t)
	owner := signedExportAccount(t, app, base, "desktop-password")
	native := newClient(t, app, base)
	password := map[string]string{"email": "desktop-password@example.test", "password": "test-password-12345"}
	logged := native.withHeaders("POST", "/desktop/login", password, "", map[string]string{"Origin": ""})
	result := logged.want(t, 200)
	end, err := time.Parse(time.RFC3339Nano, result["expires_at"].(string))
	remaining := time.Until(end)
	if err != nil || remaining < 30*24*time.Hour-time.Minute || remaining > 30*24*time.Hour ||
		len(result) != 4 || result["account_id"] != owner.uid || result["account_label"] != password["email"] ||
		logged.header.Get("Set-Cookie") != "" {
		t.Fatal("login did not return the independent minimal 30-day session")
	}
	bearer := extensionHeaders(t, logged)
	session := native.withHeaders("GET", "/desktop/session", nil, "", bearer).want(t, 200)
	if session["expires_at"] != result["expires_at"] {
		t.Fatal("reading the session renewed or changed its expiry")
	}
	native.do("GET", "/collections", nil, "").want(t, 401)
	native.withHeaders("GET", "/collections", nil, "", bearer).want(t, 200)
	extensionError(t, native.withHeaders("GET", "/auth/session", nil, "", bearer), 403, "desktop_scope_forbidden")
	extensionError(t, native.withHeaders("POST", "/desktop/login", password, "", bearer), 400, "unexpected_credentials")
	extensionError(t, owner.do("POST", "/desktop/login", password, ""), 400, "unexpected_credentials")
	extensionError(t, owner.withHeaders("POST", "/desktop/login", password, "", bearer), 400, "mixed_credentials")

	var id string
	for _, item := range owner.do("GET", "/sessions", nil, "").want(t, 200)["items"].([]any) {
		session := item.(map[string]any)
		if session["kind"] == "desktop" && session["device_label"] == "Spark macOS 桌面端" {
			id = session["id"].(string)
		}
	}
	if id == "" {
		t.Fatal("desktop login session was not visible in Web device management")
	}
	owner.do("DELETE", "/sessions/"+id, nil, "").want(t, 204)
	extensionError(t, native.withHeaders("GET", "/desktop/session", nil, "", bearer), 401, "desktop_session_expired")
	owner.do("GET", "/auth/session", nil, "").want(t, 200)

	// Browser-assisted pairing still creates the same kind of session.
	paired := exchangeTestDesktop(native, approveTestDesktop(t, owner))
	if paired.want(t, 200)["account_id"] != owner.uid {
		t.Fatal("existing browser confirmation did not issue the same account")
	}
}

func TestDesktopPasswordLoginSharesWebLimits(t *testing.T) {
	app, base := testBackend(t)
	client := newClient(t, app, base)
	paths := []string{"/auth/login", "/desktop/login"}
	credentials := map[string]string{"email": "unknown-login@example.test", "password": "test-password-12345"}
	for attempt := range 10 {
		extensionError(t, client.do("POST", paths[attempt%len(paths)], credentials, ""), 401, "authentication_failed")
	}
	for _, path := range paths {
		limited := client.do("POST", path, credentials, "")
		extensionError(t, limited, 429, "rate_limited")
		if limited.header.Get("Retry-After") == "" {
			t.Fatalf("%s did not return Retry-After", path)
		}
	}
}

func TestDesktopPasswordLoginChecksAccountAgainBeforeIssuingSession(t *testing.T) {
	const email = "desktop-login-account-change@example.test"
	for _, change := range []string{"password", "disable"} {
		t.Run(change, func(t *testing.T) {
			app, base := testBackend(t)
			owner := signedExportAccount(t, app, base, "desktop-login-account-change")
			client := newClient(t, app, base)
			oldPassword := map[string]string{"email": email, "password": "test-password-12345"}
			ctx := t.Context()
			tx, err := app.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			var blocker int32
			if change == "password" {
				hash, err := app.passwordHash("next-test-password-12345")
				if err != nil {
					t.Fatal(err)
				}
				err = tx.QueryRow(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING pg_backend_pid()`, owner.uid, hash).Scan(&blocker)
				if err != nil {
					t.Fatal(err)
				}
			} else if err := tx.QueryRow(ctx, `UPDATE users SET status='disabled' WHERE id=$1 RETURNING pg_backend_pid()`, owner.uid).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			result := make(chan apiResponse, 1)
			go func() { result <- client.do("POST", "/desktop/login", oldPassword, "") }()
			checkPurgeEventually(t, "desktop login waits for account change", func() bool {
				var waiting bool
				if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
					WHERE pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				return waiting
			})
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			extensionError(t, <-result, 401, "authentication_failed")

			if change == "disable" {
				extensionError(t, client.do("POST", "/desktop/login", oldPassword, ""), 401, "authentication_failed")
				return
			}
			native := client.do("POST", "/desktop/login", map[string]string{"email": email, "password": "next-test-password-12345"}, "")
			headers := extensionHeaders(t, native)
			challengeID, code := owner.challenge(email, "password_reset")
			owner.do("POST", "/auth/password-reset", map[string]string{
				"email": email, "new_password": "final-test-password-12345", "challenge_id": challengeID, "verification_code": code,
			}, "").want(t, 204)
			extensionError(t, client.withHeaders("GET", "/desktop/session", nil, "", headers), 401, "desktop_session_expired")
		})
	}
}
