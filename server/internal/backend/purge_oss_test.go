package backend

import (
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
	var notes []string
	for range 2 {
		id := uuid.NewString()
		owner.do("POST", "/collections", collectionInput(id, "synthetic archived note"), uuid.NewString()).want(t, 201)
		notes = append(notes, id)
	}
	for _, table := range []string{"users", "user_change_counters", "collections", "collection_revisions"} {
		if _, err := restoredApp.Pool.Exec(ctx, "INSERT INTO "+pgx.Identifier{table}.Sanitize()+" SELECT * FROM "+
			pgx.Identifier{db.RiverSchema(app.Pool), table}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}

	const bucket, root = "ledger-fixture", "isolated/ledger/"
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
	if err := os.WriteFile(config, jsonBytes(purgearchive.OSSLocation{
		Region: "cn-hangzhou", Endpoint: provider.URL, Bucket: bucket, Prefix: root,
	}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentials, []byte(`{"access_key_id":"fixture-id","access_key_secret":"fixture-secret"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_ENV", "development")
	t.Setenv("SPARK_DELETION_LEDGER_BACKEND", "oss")
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CONFIG_FILE", config)
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CREDENTIALS_FILE", credentials)
	archive, err := purgearchive.OpenConfigured(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = archive.Close() })

	owner.do("DELETE", "/collections/"+notes[0], map[string]any{"base_resource_version": 1}, "").want(t, 200)
	owner.do("POST", "/collections/"+notes[0]+"/purge", map[string]any{"base_resource_version": 2}, uuid.NewString()).want(t, 202)
	worker, err := StartPurgeWorker(context.Background(), app.Pool, archive, nil, pgtype.Timestamptz{})
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

	mu.Lock()
	failSecondPage = true
	var firstKey string
	for key := range data {
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
	if n, err := ReplayDeletions(ctx, restoredApp.Pool, archive); err == nil || n != 1 {
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
	if n, err := ReplayDeletions(ctx, restoredApp.Pool, archive); err != nil || n != 2 {
		t.Fatalf("complete replay after restoring archive availability: %d, %v", n, err)
	}
	for _, note := range notes {
		restored.do("GET", "/collections/"+note, nil, "").want(t, 404)
	}
}
