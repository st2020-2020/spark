package backend

import (
	"testing"

	"github.com/google/uuid"
)

func TestCollectionSummarySources(t *testing.T) {
	app, base := testBackend(t)
	ctx := t.Context()
	const account = "summary-sources@example.test"
	if err := app.BootstrapAdmin(ctx, account, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	client := newClient(t, app, base)
	client.signIn(account)
	owner := client.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
	cid := uuid.NewString()
	const originalURL = "https://preview.example.test/article"
	input := collectionInput(cid, "synthetic preview")
	input["original_url"] = originalURL
	client.do("POST", "/collections", input, uuid.NewString()).want(t, 201)

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := app.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO extractions(id,user_id,collection_id,content_version,source_kind,source_id,extractor_version,status,source_title,evidence_meta)
		  VALUES($1,$2,$3,1,'url',$4,'web-v1','succeeded','原始来源标题','{"site_name":"合成站点","summary":"两行摘要"}'),
		        ($5,$2,$3,2,'url',$4,'web-v1','queued',NULL,'{}'),
		        ($6,$2,$3,2,'url','https://other.example.test/','web-v1','succeeded','错误来源','{}')`,
		uuid.NewString(), owner, cid, originalURL, uuid.NewString(), uuid.NewString())
	var cover string
	for _, fixture := range []struct {
		position int
		removed  bool
	}{{0, true}, {4, false}, {2, false}} {
		uploadID, attachmentID := uuid.NewString(), uuid.NewString()
		if fixture.position == 2 {
			cover = attachmentID
		}
		staging, final := "synthetic/staging/"+uploadID, "synthetic/final/"+uploadID
		exec(`INSERT INTO uploads(id,user_id,staging_key,final_key,filename,declared_size,actual_size,mime_type,sha256,status,expires_at)
		      VALUES($1,$2,$3,$4,'sample.png',3,3,'image/png',decode(repeat('00',32),'hex'),'attached',now())`,
			uploadID, owner, staging, final)
		exec(`INSERT INTO attachments(id,user_id,collection_id,upload_id,object_key,filename,mime_type,size_bytes,sha256,position,removed_at)
		      VALUES($1,$2,$3,$4,$5,'sample.png','image/png',3,decode(repeat('00',32),'hex'),$6,CASE WHEN $7 THEN now() END)`,
			attachmentID, owner, cid, uploadID, final, fixture.position, fixture.removed)
	}

	rows := client.do("GET", "/collections", nil, "").want(t, 200)["items"].([]any)
	summary := rows[0].(map[string]any)
	preview := summary["link_preview"].(map[string]any)
	if summary["original_url"] != originalURL || summary["cover_attachment_id"] != cover ||
		summary["attachment_count"] != float64(2) || preview["status"] != "succeeded" ||
		preview["source_title"] != "原始来源标题" || preview["site_name"] != "合成站点" || preview["summary"] != "两行摘要" {
		t.Fatalf("unexpected summary %+v", summary)
	}
	hits := client.do("GET", "/search?q=synthetic", nil, "").want(t, 200)["items"].([]any)
	hit := hits[0].(map[string]any)["collection"].(map[string]any)
	if hit["cover_attachment_id"] != cover || hit["link_preview"].(map[string]any)["summary"] != "两行摘要" {
		t.Fatal("search did not return the same summary metadata")
	}

	exec("UPDATE collections SET content_version=2 WHERE user_id=$1 AND id=$2", owner, cid)
	rows = client.do("GET", "/collections", nil, "").want(t, 200)["items"].([]any)
	preview = rows[0].(map[string]any)["link_preview"].(map[string]any)
	if preview["status"] != "skipped" || preview["source_title"] != nil {
		t.Fatal("disabled extraction showed stale or nonmatching content")
	}
	client.do("DELETE", "/collections/"+cid, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	rows = client.do("GET", "/collections?scope=trash", nil, "").want(t, 200)["items"].([]any)
	if rows[0].(map[string]any)["link_preview"] != nil {
		t.Fatal("trash exposed preview metadata")
	}
}
