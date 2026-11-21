package backend

import (
	"net/url"
	"testing"
)

func TestSearchShowsCurrentImageNoteAfterEditAndRemoval(t *testing.T) {
	app, base := testBackend(t)
	objects, _, storage := newUploadStorageFixture(t)
	app.Assets = storage
	owner := imageTestAccount(t, app, base, "note-owner")
	other := imageTestAccount(t, app, base, "note-other")
	item := saveImageCollection(t, app, owner, objects)
	// Start with an existing generated paragraph, as after upgrading a recognized attachment.
	_, err := app.Pool.Exec(t.Context(), `INSERT INTO collection_image_notes
		(user_id,collection_id,attachment_id,text,state) VALUES ($1,$2,$3,'珊瑚码头','generated')`,
		item.userID, item.id, item.attachmentID)
	if err != nil {
		t.Fatal(err)
	}
	hits := func(client *apiClient, term string) []any {
		t.Helper()
		return client.do("GET", "/search?q="+url.QueryEscape(term), nil, "").want(t, 200)["items"].([]any)
	}
	path := "/attachments/" + item.attachmentID + "/image-note"
	if len(hits(owner, "珊瑚码头")) != 1 || len(hits(other, "珊瑚码头")) != 0 {
		t.Fatal("generated paragraph search must be account scoped")
	}
	owner.do("PATCH", path, map[string]any{"base_version": 1, "text": "船坞检修时间表"}, "").want(t, 200)
	edited := hits(owner, "船坞")
	if len(edited) != 1 || len(hits(owner, "珊瑚码头")) != 0 {
		t.Fatal("search should return the current paragraph only")
	}
	snippet := edited[0].(map[string]any)["snippets"].([]any)[0].(map[string]any)
	if snippet["field"] != "image_description" || snippet["text"] != "船坞检修时间表" {
		t.Fatalf("unexpected snippet: %v", snippet)
	}
	owner.do("PATCH", path, map[string]any{"base_version": 2, "text": ""}, "").want(t, 200)
	if len(hits(owner, "船坞")) != 0 {
		t.Fatal("removed paragraph was returned from search")
	}
}
