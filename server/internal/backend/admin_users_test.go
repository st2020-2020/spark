package backend

import (
	"context"
	"net/url"
	"testing"
)

func TestAdminUsersListAuthorizationAndPagination(t *testing.T) {
	app, base := testBackend(t)
	ctx := context.Background()
	adminEmail, secondEmail, disabledEmail := "admin@example.test", "second-admin@example.test", "disabled-admin@example.test"
	for _, email := range []string{adminEmail, secondEmail, disabledEmail} {
		if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
			t.Fatal(err)
		}
	}

	admin := newClient(t, app, base)
	admin.signIn(adminEmail)
	second := newClient(t, app, base)
	second.signIn(secondEmail)
	disabled := newClient(t, app, base)
	disabled.signIn(disabledEmail)
	admin.invite("T11-USER-00001")
	member := newClient(t, app, base)
	memberEmail := "member@example.test"
	member.do("POST", "/auth/register", member.registration(memberEmail, "T11-USER-00001"), "").want(t, 201)

	// Exercise the UUID tie-break across pages and a formerly valid session after disablement.
	if _, err := app.Pool.Exec(ctx, `UPDATE users SET
		created_at=CASE WHEN email_normalized=$1 THEN '2026-01-02'::timestamptz ELSE '2026-01-01'::timestamptz END,
		status=CASE WHEN email_normalized=$2 THEN 'disabled' ELSE status END`, adminEmail, disabledEmail); err != nil {
		t.Fatal(err)
	}

	newClient(t, app, base).do("GET", "/admin/users", nil, "").want(t, 401)
	member.do("GET", "/admin/users", nil, "").want(t, 403)
	disabled.do("GET", "/admin/users", nil, "").want(t, 401)

	first := admin.do("GET", "/admin/users?limit=2", nil, "").want(t, 200)
	cursor, ok := first["next_cursor"].(string)
	if !ok || cursor == "" {
		t.Fatal("first page must include a continuation cursor")
	}
	secondPath := "/admin/users?limit=2&cursor=" + url.QueryEscape(cursor)
	last := admin.do("GET", secondPath, nil, "").want(t, 200)
	if _, exists := last["next_cursor"]; exists {
		t.Fatal("last page must omit the continuation cursor")
	}
	firstItems, lastItems := first["items"].([]any), last["items"].([]any)
	if len(firstItems) != 2 || len(lastItems) != 2 {
		t.Fatal("expected two full pages")
	}
	expected := map[string]string{adminEmail: "active", secondEmail: "active", disabledEmail: "disabled", memberEmail: "active"}
	var priorTiedID string
	var memberID string
	for index, item := range append(firstItems, lastItems...) {
		row := item.(map[string]any)
		email := row["email"].(string)
		if status, found := expected[email]; !found || row["status"] != status {
			t.Fatalf("unexpected, repeated, or incorrectly marked account %s", email)
		}
		delete(expected, email)
		if len(row) != 6 {
			t.Fatal("list exposed fields beyond the existing User contract")
		}
		id := row["id"].(string)
		switch {
		case index == 0 && email != adminEmail:
			t.Fatal("newest account did not appear first")
		case index > 1 && id >= priorTiedID:
			t.Fatal("equal timestamps did not page in stable UUID order")
		}
		priorTiedID = id
		if email == memberEmail {
			memberID = id
			if row["role"] != "user" {
				t.Fatal("member role was incorrect")
			}
		}
	}
	second.do("GET", secondPath, nil, "").want(t, 400)
	result := admin.do("GET", "/admin/users?limit=2&cursor="+url.QueryEscape(cursor+"!"), nil, "").want(t, 400)
	if result["error"].(map[string]any)["code"] != "invalid_cursor" {
		t.Fatal("tampered cursor did not return invalid_cursor")
	}
	admin.do("GET", "/admin/users?limit=101", nil, "").want(t, 400)
	admin.do("PATCH", "/admin/users/"+memberID, map[string]any{"status": "disabled"}, "").want(t, 404)
}
