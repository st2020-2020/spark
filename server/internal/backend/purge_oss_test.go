package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"spark/server/db"
	"spark/server/internal/purgearchive"
)

func TestOSSDeletionGatesIrreversibleWorkAndStopsOfflineReplay(t *testing.T) {
	app, base := testBackend(t)
	restoredApp, restoredBase := testBackend(t)
	app.Config.PurgeEnabled = true
	ctx := t.Context()
	const email = "ledger-owner@example.test"
	if err := app.BootstrapAdmin(ctx, email, "test-password-12345"); err != nil {
		t.Fatal(err)
	}
	owner := newClient(t, app, base)
	owner.signIn(email)
	other := imageTestAccount(t, app, base, "ledger-neighbor")
	objects, assetProvider, storage := newUploadStorageFixture(t)
	app.Assets, restoredApp.Assets = storage, storage
	objects.deleteAttempts = make(map[string]int)
	picture := saveImageCollection(t, app, owner, objects)
	neighbor := saveImageCollection(t, app, other, objects)
	notes := []string{picture.id, uuid.NewString()}
	owner.do("POST", "/collections", collectionInput(notes[1], "synthetic archived note"), uuid.NewString()).want(t, 201)
	neighborPath, neighborDownload := "/collections/"+neighbor.id, "/attachments/"+neighbor.attachmentID+"/download"
	otherTrash := other.do("DELETE", neighborPath, map[string]any{"base_resource_version": 1}, "").want(t, 200)
	neighborCondition := map[string]any{"base_resource_version": otherTrash["resource_version"]}
	owner.do("GET", neighborPath, nil, "").want(t, 404)
	owner.do("GET", neighborDownload, nil, "").want(t, 404)
	owner.do("DELETE", neighborPath, neighborCondition, "").want(t, 404)
	owner.do("POST", neighborPath+"/restore", neighborCondition, "").want(t, 404)
	owner.do("POST", neighborPath+"/purge", neighborCondition, uuid.NewString()).want(t, 404)
	owner.do("GET", neighborPath+"/purge", nil, "").want(t, 404)
	var noWork bool
	if err := app.Pool.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM deletion_ledger)
		AND NOT EXISTS(SELECT FROM river_job WHERE kind='spark_purge_collection')`).Scan(&noWork); err != nil || !noWork {
		t.Fatalf("foreign IDs created deletion work: %v", err)
	}

	objectKeys := func(collection imageCollection) (staging, final string) {
		t.Helper()
		err := app.Pool.QueryRow(ctx, `UPDATE uploads u SET expires_at=now()-interval '1 second'
			FROM attachments a WHERE (u.user_id,u.id)=(a.user_id,a.upload_id) AND a.id=$1
			RETURNING u.staging_key,a.object_key`, collection.attachmentID).Scan(&staging, &final)
		if err != nil {
			t.Fatal(err)
		}
		objects.mu.Lock()
		objects.objects[staging] = bytes.Clone(objects.objects[final])
		objects.mu.Unlock()
		return staging, final
	}
	staging, final := objectKeys(picture)
	neighborStaging, neighborFinal := objectKeys(neighbor)
	objects.mu.Lock()
	original, neighborOriginal := bytes.Clone(objects.objects[final]), bytes.Clone(objects.objects[neighborFinal])
	objects.mu.Unlock()
	assertNeighborPhoto := func(client *apiClient) {
		t.Helper()
		grant := client.do("GET", neighborDownload, nil, "").want(t, 200)
		response, err := assetProvider.Client().Get(grant["url"].(string))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 || !bytes.Equal(body, neighborOriginal) {
			t.Fatalf("neighbor original unavailable: %d, %v", response.StatusCode, err)
		}
		objects.mu.Lock()
		defer objects.mu.Unlock()
		if objects.deleteAttempts[neighborFinal] != 0 || objects.deleteAttempts[neighborStaging] != 0 {
			t.Fatal("neighbor keys were submitted for deletion")
		}
	}
	assertNeighborPhoto(other)
	for _, table := range []string{"users", "user_change_counters", "collections", "collection_revisions", "uploads", "attachments"} {
		target, columns := pgx.Identifier{table}.Sanitize(), "*"
		if table == "attachments" {
			columns = "id,user_id,collection_id,upload_id,object_key,provider_version,filename,mime_type,size_bytes,sha256,position,removed_at,created_at"
			target += "(" + columns + ")"
		}
		if _, err := restoredApp.Pool.Exec(ctx, "INSERT INTO "+target+" SELECT "+columns+" FROM "+
			pgx.Identifier{db.RiverSchema(app.Pool), table}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}

	const root = "isolated/ledger/"
	bucket := storage.Bucket
	const prefix = root + "receipts/"
	var mu sync.Mutex
	data := map[string][]byte{}
	acceptWrites, failSecondPage := false, false
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		key := strings.TrimPrefix(r.URL.Path, "/"+bucket+"/")
		switch {
		case r.URL.Query().Has("versioning"):
			io.WriteString(w, "<VersioningConfiguration/>")
		case r.URL.Query().Get("list-type") == "2":
			if r.URL.Query().Get("prefix") != prefix {
				t.Error("unscoped replay list")
				w.WriteHeader(400)
				return
			}
			keys := make([]string, 0, len(data))
			for key := range data {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			if len(keys) != 2 {
				t.Error("test should enumerate two receipts")
				w.WriteHeader(500)
				return
			}
			second := r.URL.Query().Get("continuation-token") == "next"
			if second && failSecondPage {
				w.WriteHeader(503)
				return
			}
			fmt.Fprintf(w, "<ListBucketResult><Name>%s</Name><Prefix>%s</Prefix><KeyCount>1</KeyCount>", bucket, prefix)
			if second {
				fmt.Fprintf(w, "<IsTruncated>false</IsTruncated><Contents><Key>%s</Key></Contents>", keys[1])
			} else {
				fmt.Fprintf(w, "<IsTruncated>true</IsTruncated><Contents><Key>%s</Key></Contents><NextContinuationToken>next</NextContinuationToken>", keys[0])
			}
			io.WriteString(w, "</ListBucketResult>")
		case r.Method == http.MethodPut && strings.HasPrefix(key, prefix):
			if r.Header.Get("x-oss-forbid-overwrite") != "true" {
				t.Error("missing creation precondition")
				w.WriteHeader(400)
				return
			}
			if acceptWrites {
				if _, exists := data[key]; exists {
					w.WriteHeader(409)
					io.WriteString(w, "<Error><Code>FileAlreadyExists</Code></Error>")
					return
				}
				data[key], _ = io.ReadAll(r.Body)
			}
			// Exercise both an unconfirmed absent receipt and a committed
			// receipt whose caller received only a service failure.
			w.WriteHeader(503)
		case r.Method == http.MethodGet && strings.HasPrefix(key, prefix):
			if data[key] == nil {
				w.WriteHeader(404)
				io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
				return
			}
			w.Write(data[key])
		default:
			t.Errorf("unexpected ledger request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
		}
	}))
	t.Cleanup(provider.Close)
	dir := t.TempDir()
	config, credentials := filepath.Join(dir, "oss.json"), filepath.Join(dir, "credentials.json")
	if err := os.WriteFile(config, jsonBytes(map[string]any{
		"version": "oss-v2", "oss_region": storage.OSSRegion, "oss_endpoint": provider.URL,
		"bucket": bucket, "prefix": storage.Prefix, "oss_use_cname": false,
		"credentials_file": "/unused/asset-key.json", "put_ttl_seconds": 600, "get_ttl_seconds": 300,
	}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentials, []byte(`{"access_key_id":"fixture-id","access_key_secret":"fixture-secret","label":"platform key","metadata":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_ENV", "development")
	t.Setenv("SPARK_DELETION_LEDGER_BACKEND", "oss")
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CONFIG_FILE", config)
	t.Setenv("SPARK_DELETION_LEDGER_OSS_PREFIX", root)
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CREDENTIALS_FILE", credentials)
	archive, err := purgearchive.OpenConfigured(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = archive.Close() })

	owner.do("DELETE", "/collections/"+notes[0], map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", "/collections/"+notes[0]+"/purge", map[string]any{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	worker, err := StartPurgeWorker(context.Background(), app.Pool, archive, storage, pgtype.Timestamptz{})
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	checkPurgeEventually(t, "unconfirmed OSS write", func() bool {
		var retryable bool
		err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM river_job
			WHERE kind='spark_purge_collection' AND state='retryable')`).Scan(&retryable)
		return err == nil && retryable
	})
	var preserved bool
	if err := app.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM collections WHERE id=$1)
		AND EXISTS(SELECT FROM collection_revisions WHERE collection_id=$1)
		AND EXISTS(SELECT FROM deletion_ledger WHERE collection_id=$1 AND replicated_at IS NULL AND completed_at IS NULL)`,
		notes[0]).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("irreversible work started without an OSS receipt: %v", err)
	}
	objects.mu.Lock()
	kept := bytes.Equal(objects.objects[final], original) && objects.deleteAttempts[final] == 0 && objects.deleteAttempts[staging] == 0
	objects.mu.Unlock()
	if !kept {
		t.Fatal("picture keys were touched before confirming the receipt")
	}
	mu.Lock()
	acceptWrites = true
	mu.Unlock()
	if _, err := app.Pool.Exec(ctx, `UPDATE river_job SET state='available',scheduled_at=now()
		WHERE kind='spark_purge_collection' AND state='retryable'`); err != nil {
		t.Fatal(err)
	}
	owner.do("DELETE", "/collections/"+notes[1], map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", "/collections/"+notes[1]+"/purge", map[string]any{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	checkPurgeEventually(t, "readback confirms two archives", func() bool {
		var n int
		err := app.Pool.QueryRow(ctx, `SELECT count(*) FROM deletion_ledger WHERE completed_at IS NOT NULL`).Scan(&n)
		return err == nil && n == 2
	})

	assertNeighborPhoto(other)
	objects.mu.Lock()
	deleted := objects.objects[final] == nil && objects.objects[staging] == nil
	// Restore the object checkpoint along with the previously restored DB.
	objects.objects[final], objects.objects[staging] = original, original
	objects.mu.Unlock()
	if !deleted {
		t.Fatal("accepted picture purge did not clear final and staging")
	}
	location := archive.(*purgearchive.OSS).Location()
	if location.Prefix != root || location.ObjectPrefix != storage.Prefix || location.Bucket != storage.Bucket {
		t.Fatalf("unexpected canonical location: %+v", location)
	}
	frozen := filepath.Join(dir, "canonical.json")
	if err := os.WriteFile(frozen, jsonBytes(location), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CONFIG_FILE", frozen)
	t.Setenv("SPARK_DELETION_LEDGER_OSS_PREFIX", "")
	replayArchive, err := purgearchive.OpenConfigured(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = replayArchive.Close() })

	mu.Lock()
	failSecondPage = true
	var firstKey string
	for key, payload := range data {
		var receipt purgearchive.Receipt
		if err := json.Unmarshal(payload, &receipt); err != nil {
			mu.Unlock()
			t.Fatal(err)
		}
		if receipt.UserID.String() != picture.userID {
			mu.Unlock()
			t.Fatal("foreign account received an archive write")
		}
		if receipt.CollectionID.String() == picture.id &&
			!equalJSON(receiptKeys(receipt), []string{final, staging}) {
			mu.Unlock()
			t.Fatalf("unexpected archived object keys: %v", receiptKeys(receipt))
		}
		if firstKey == "" || key < firstKey {
			firstKey = key
		}
	}
	var first purgearchive.Receipt
	err = json.Unmarshal(data[firstKey], &first)
	mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	restored := newClient(t, restoredApp, restoredBase)
	restored.signIn(email)
	if n, err := ReplayDeletions(ctx, restoredApp.Pool, replayArchive); err == nil || n != 1 {
		t.Fatalf("replay did not stop at failed page: %d, %v", n, err)
	}
	for _, note := range notes {
		expected := 200
		if note == first.CollectionID.String() {
			expected = 404
		}
		restored.do("GET", "/collections/"+note, nil, "").want(t, expected)
	}
	mu.Lock()
	failSecondPage = false
	mu.Unlock()
	if n, err := ReplayDeletions(ctx, restoredApp.Pool, replayArchive); err != nil || n != 2 {
		t.Fatalf("complete replay after restoring archive availability: %d, %v", n, err)
	}
	for _, note := range notes {
		restored.do("GET", "/collections/"+note, nil, "").want(t, 404)
	}
	restored.do("GET", neighborPath, nil, "").want(t, 404)
	restoredOther := newClient(t, restoredApp, restoredBase)
	restoredOther.signIn("ledger-neighbor@images.example.test")
	restoredOther.do("POST", neighborPath+"/restore", neighborCondition, "").want(t, 200)
	recoveryWorker, err := StartPurgeWorker(context.Background(), restoredApp.Pool, replayArchive, storage, pgtype.Timestamptz{})
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, recoveryWorker)
	checkPurgeEventually(t, "restored objects cleanup", func() bool {
		var n int
		err := restoredApp.Pool.QueryRow(ctx, `SELECT count(*) FROM deletion_ledger WHERE completed_at IS NOT NULL`).Scan(&n)
		return err == nil && n == 2
	})
	assertNeighborPhoto(restoredOther)
	objects.mu.Lock()
	defer objects.mu.Unlock()
	if objects.objects[final] != nil || objects.objects[staging] != nil {
		t.Fatal("replay did not delete the restored picture")
	}
}
