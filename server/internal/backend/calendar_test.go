package backend

import (
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
)

func datedCollection(t *testing.T, app *Server, owner *apiClient, created time.Time) string {
	t.Helper()
	id := uuid.NewString()
	owner.do("POST", "/collections", collectionInput(id, "calendar fixture"), uuid.NewString()).want(t, 201)
	if _, err := app.Pool.Exec(t.Context(), "UPDATE collections SET created_at=$2 WHERE id=$1", id, created); err != nil {
		t.Fatal(err)
	}
	return id
}

func calendarInstant(t *testing.T, raw string) time.Time {
	t.Helper()
	value, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestLocalDayStartAtYearBoundary(t *testing.T) {
	for _, example := range []struct {
		zone, date, start string
	}{
		{"America/New_York", "2028-12-31", "2028-12-31T05:00:00Z"},
		{"America/New_York", "2029-01-01", "2029-01-01T05:00:00Z"},
		{"Australia/Sydney", "2029-01-01", "2028-12-31T13:00:00Z"},
		{"America/Sao_Paulo", "2018-11-04", "2018-11-04T03:00:00Z"},
		{"America/Havana", "2026-11-01", "2026-11-01T04:00:00Z"},
	} {
		t.Run(example.zone+"/"+example.date, func(t *testing.T) {
			date, err := time.Parse(time.DateOnly, example.date)
			if err != nil {
				t.Fatal(err)
			}
			location, err := time.LoadLocation(example.zone)
			if err != nil {
				t.Fatal(err)
			}
			got, err := localDayStart(date, location)
			if err != nil {
				t.Fatal(err)
			}
			if want := calendarInstant(t, example.start); !got.Equal(want) {
				t.Fatalf("date starts at %s, want %s", got, want)
			}
		})
	}
}

func TestCalendarDateBoundariesMatchCollections(t *testing.T) {
	app, base := testBackend(t)
	alice := imageTestAccount(t, app, base, "calendar-alice")
	bob := imageTestAccount(t, app, base, "calendar-bob")
	for _, fixture := range []struct {
		date, next, start, end string
	}{
		{"2026-03-08", "2026-03-09", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"},
		{"2026-11-01", "2026-11-02", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"},
		{"2025-12-31", "2026-01-01", "2025-12-31T05:00:00Z", "2026-01-01T05:00:00Z"},
		{"2028-12-31", "2029-01-01", "2028-12-31T05:00:00Z", "2029-01-01T05:00:00Z"},
	} {
		start, end := calendarInstant(t, fixture.start), calendarInstant(t, fixture.end)
		datedCollection(t, app, alice, start.Add(-time.Microsecond))
		first := datedCollection(t, app, alice, start)
		last := datedCollection(t, app, alice, end.Add(-time.Microsecond))
		datedCollection(t, app, alice, end)
		trashed := datedCollection(t, app, alice, start)
		alice.do("DELETE", "/collections/"+trashed, map[string]any{"base_resource_version": 1}, uuid.NewString()).want(t, 200)
		datedCollection(t, app, bob, start)

		path := "/me/activity?from=" + fixture.date + "&to=" + fixture.next + "&tz=America/New_York"
		a := alice.do("GET", path, nil, "").want(t, 200)
		days := a["days"].([]any)
		if len(days) != 1 {
			t.Fatalf("calendar returned %d dates", len(days))
		}
		day := days[0].(map[string]any)
		if day["date"] != fixture.date || day["count"] != float64(2) ||
			day["created_from"] != fixture.start || day["created_to"] != fixture.end {
			t.Fatalf("wrong date range for %s: %v", fixture.date, day)
		}
		b := bob.do("GET", path, nil, "").want(t, 200)["days"].([]any)
		if b[0].(map[string]any)["count"] != float64(1) {
			t.Fatal("calendar included another account's collections")
		}

		bounds := url.Values{"created_from": {fixture.start}, "created_to": {fixture.end}}.Encode()
		list := alice.do("GET", "/collections?"+bounds, nil, "").want(t, 200)["items"].([]any)
		if len(list) != 2 || list[0].(map[string]any)["id"] != last || list[1].(map[string]any)["id"] != first {
			t.Fatal("calendar and date-filtered collection list differ")
		}
		trash := alice.do("GET", "/collections?scope=trash&"+bounds, nil, "").want(t, 200)["items"].([]any)
		if len(trash) != 1 || trash[0].(map[string]any)["id"] != trashed {
			t.Fatal("explicit trash date filter did not preserve its scope")
		}
	}

	empty := alice.do("GET", "/me/activity?from=2011-12-29&to=2012-01-01&tz=Pacific/Apia", nil, "").want(t, 200)["days"].([]any)
	if len(empty) != 3 {
		t.Fatal("calendar did not return dates with zero collections")
	}
	skipped := empty[1].(map[string]any)
	if skipped["date"] != "2011-12-30" || skipped["count"] != float64(0) || skipped["created_from"] != skipped["created_to"] {
		t.Fatal("skipped civil date did not return an empty interval")
	}
	skippedBounds := url.Values{"created_from": {skipped["created_from"].(string)}, "created_to": {skipped["created_to"].(string)}}.Encode()
	if data := alice.do("GET", "/collections?"+skippedBounds, nil, "").want(t, 200); len(data["items"].([]any)) != 0 {
		t.Fatal("an empty timestamp interval included collections")
	}
	lower := url.Values{"created_from": {"2026-11-01T04:00:00.000000001Z"}, "created_to": {"2026-11-02T05:00:00Z"}, "q": {"calendar"}}.Encode()
	if hits := alice.do("GET", "/search?"+lower, nil, "").want(t, 200)["items"].([]any); len(hits) != 1 {
		t.Fatal("sub-microsecond lower bound did not exclude the preceding point")
	}
	for _, invalid := range []string{
		"/me/activity?from=2026-03-08&to=2026-04-09&tz=UTC",
		"/me/activity?from=2026-03-08&to=2026-03-08&tz=UTC",
		"/me/activity?from=2026-02-30&to=2026-03-08&tz=UTC",
		"/me/activity?from=2026-03-08&to=2026-03-09&tz=Local",
		"/me/activity?from=2026-03-08&to=2026-03-09&tz=Alien/Nowhere",
		"/collections?created_from=2026-03-09T04:00:00Z&created_to=2026-03-08T05:00:00Z",
	} {
		alice.do("GET", invalid, nil, "").want(t, 400)
	}
}
