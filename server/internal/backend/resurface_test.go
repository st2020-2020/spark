package backend

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestResurfaceDailySelectionAndVisibility(t *testing.T) {
	app, base := testBackend(t)
	alice := imageTestAccount(t, app, base, "resurface-alice")
	bob := imageTestAccount(t, app, base, "resurface-bob")
	now := time.Now().UTC()
	old := now.AddDate(0, 0, -60)
	unclassified := datedCollection(t, app, alice, old)
	inactiveProject := datedCollection(t, app, alice, old)
	newlyOpened := datedCollection(t, app, alice, old.AddDate(0, 0, -1))
	previousYear := now.AddDate(-1, 0, 0)
	for previousYear.Month() != now.Month() || previousYear.Day() != now.Day() {
		previousYear = now.AddDate(previousYear.Year()-now.Year()-1, 0, 0)
	}
	anniversary := datedCollection(t, app, alice, previousYear)
	bobItem := datedCollection(t, app, bob, old)
	active := alice.do("POST", "/projects", map[string]any{
		"name": "active", "description": "", "focus_points": []string{},
	}, uuid.NewString()).want(t, 201)["id"].(string)
	paused := alice.do("POST", "/projects", map[string]any{
		"name": "paused", "description": "", "focus_points": []string{},
	}, uuid.NewString()).want(t, 201)["id"].(string)
	alice.do("PATCH", "/projects/"+paused, map[string]any{"base_version": 1, "state": "paused"}, "").want(t, 200)
	link := func(collection, project string) {
		alice.do("PATCH", "/collections/"+collection+"/projects", map[string]any{
			"base_decision_version": 1,
			"operations":            []any{map[string]any{"id": project, "action": "include"}},
		}, "").want(t, 200)
	}
	link(inactiveProject, active)
	link(newlyOpened, active)
	link(anniversary, paused)

	const resurface = "/me/resurface?tz=UTC"
	const preferences = "/me/resurface/preferences"
	newClient(t, app, base).do("GET", resurface, nil, "").want(t, 401)
	if body := alice.do("GET", preferences, nil, "").want(t, 200); body["enabled"] != true {
		t.Fatal("resurface was not enabled by default")
	}
	bob.do("POST", "/collections/"+newlyOpened+"/opened", nil, "").want(t, 404)
	alice.do("GET", "/collections", nil, "").want(t, 200)
	alice.do("GET", "/collections/"+inactiveProject, nil, "").want(t, 200)
	before := alice.do("GET", "/collections/"+newlyOpened, nil, "").want(t, 200)
	alice.withHeaders("POST", "/collections/"+newlyOpened+"/opened", nil, "", map[string]string{"X-CSRF-Token": ""}).want(t, 403)
	alice.do("POST", "/collections/"+newlyOpened+"/opened", nil, "").want(t, 204)
	after := alice.do("GET", "/collections/"+newlyOpened, nil, "").want(t, 200)
	for _, field := range []string{"read_at", "resource_version", "content_version", "decision_version", "updated_at"} {
		if before[field] != after[field] {
			t.Errorf("opening changed the existing %s field", field)
		}
	}
	if _, exists := after["last_opened_at"]; exists {
		t.Fatal("private activity timestamp appeared in the collection response")
	}

	var refreshes sync.WaitGroup
	replies := make(chan apiResponse, 8)
	for range cap(replies) {
		refreshes.Go(func() { replies <- alice.do("GET", resurface, nil, "") })
	}
	refreshes.Wait()
	close(replies)
	if len(replies) != cap(replies) {
		t.Fatal("some concurrent GETs did not complete")
	}
	expected := []string{unclassified + ":unclassified", inactiveProject + ":inactive_project", anniversary + ":anniversary"}
	var date string
	for reply := range replies {
		result := reply.want(t, 200)
		if date != "" && result["date"] != date {
			t.Fatal("concurrent requests did not agree on the date")
		}
		date = result["date"].(string)
		requireResurface(t, result, expected...)
	}
	requireResurface(t, bob.do("GET", resurface, nil, "").want(t, 200), bobItem+":unclassified")

	hidden := "/me/resurface/" + inactiveProject + "/hidden?tz=UTC&date=" + date
	bob.do("PUT", hidden, nil, "").want(t, 404)
	for range 2 {
		alice.do("PUT", hidden, nil, "").want(t, 204)
	}
	alice.do("PUT", "/me/resurface/"+anniversary+"/hidden?tz=UTC&date=2000-01-01", nil, "").want(t, 409)
	link(unclassified, active)
	datedCollection(t, app, alice, old.AddDate(-1, 0, 0))
	requireResurface(t, alice.do("GET", resurface, nil, "").want(t, 200), expected[0], expected[2])

	version := alice.do("GET", "/collections/"+anniversary, nil, "").want(t, 200)["resource_version"]
	alice.do("DELETE", "/collections/"+anniversary, map[string]any{"base_resource_version": version}, uuid.NewString()).want(t, 200)
	trashed := alice.do("GET", "/collections/"+anniversary, nil, "").want(t, 200)
	if trashed["deleted_at"] == nil {
		t.Fatal("owner could not read the soft-deleted collection")
	}
	alice.do("POST", "/collections/"+anniversary+"/opened", nil, "").want(t, 409)
	bob.do("GET", "/collections/"+anniversary, nil, "").want(t, 404)
	bob.do("POST", "/collections/"+anniversary+"/opened", nil, "").want(t, 404)
	requireResurface(t, alice.do("GET", resurface, nil, "").want(t, 200), expected[0])

	if body := alice.do("PUT", preferences, map[string]any{"enabled": false}, "").want(t, 200); body["enabled"] != false {
		t.Fatal("server did not persist disabled preference")
	}
	requireResurface(t, alice.do("GET", resurface, nil, "").want(t, 200))
	requireResurface(t, bob.do("GET", resurface, nil, "").want(t, 200), bobItem+":unclassified")
	alice.do("PUT", preferences, map[string]any{"enabled": true}, "").want(t, 200)
	requireResurface(t, alice.do("GET", resurface, nil, "").want(t, 200), expected[0])
}

func requireResurface(t *testing.T, result map[string]any, want ...string) {
	t.Helper()
	var actual []string
	for _, raw := range result["items"].([]any) {
		item := raw.(map[string]any)
		collection := item["collection"].(map[string]any)
		actual = append(actual, collection["id"].(string)+":"+item["reason"].(string))
	}
	if !slices.Equal(actual, want) {
		t.Fatalf("daily selection = %v, want %v", actual, want)
	}
}

func TestResurfaceKeepsAnEmptyDailySelectionStable(t *testing.T) {
	app, base := testBackend(t)
	alice := imageTestAccount(t, app, base, "empty-resurface")
	const path = "/me/resurface?tz=America/New_York"
	requireResurface(t, alice.do("GET", path, nil, "").want(t, 200))
	datedCollection(t, app, alice, time.Now().AddDate(0, 0, -60))
	requireResurface(t, alice.do("GET", path, nil, "").want(t, 200))
}
