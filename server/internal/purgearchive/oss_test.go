package purgearchive

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

const (
	testBucket = "ledger-fixture"
	testPrefix = "spark/archive/"
	testAssets = "spark/assets/"
)

func testOSS(t *testing.T, handler http.HandlerFunc) *OSS {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	archive := newOSS(OSSLocation{Region: "cn-hangzhou", Endpoint: server.URL, Bucket: testBucket,
		Prefix: testPrefix, ObjectPrefix: testAssets}, accessKey{ID: "fixture-id", Secret: "fixture-secret"}, true)
	t.Cleanup(func() { _ = archive.Close() })
	return archive
}

func ossError(w http.ResponseWriter, code int, name string) {
	w.WriteHeader(code)
	fmt.Fprintf(w, "<Error><Code>%s</Code><Message>fixture-sensitive-message</Message></Error>", name)
}

func TestOSSConditionAndAmbiguousWriteReadback(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	attempts := 0
	loseResponse, persist := false, false
	archive := testOSS(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("versioning") {
			io.WriteString(w, "<VersioningConfiguration/>")
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/"+testBucket+"/"+testPrefix+receipts) {
			t.Errorf("unscoped request path: %q", r.URL.Path)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodGet {
			if data, ok := objects[r.URL.Path]; ok {
				w.Write(data)
			} else {
				ossError(w, 404, "NoSuchKey")
			}
			return
		}
		attempts++
		if r.Method != http.MethodPut || r.Header.Get("x-oss-forbid-overwrite") != "true" || r.Header.Get("Authorization") == "" {
			t.Error("expected a signed, conditional OSS PUT")
			w.WriteHeader(400)
			return
		}
		if _, exists := objects[r.URL.Path]; exists {
			ossError(w, 409, "FileAlreadyExists")
			return
		}
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if !loseResponse || persist {
			objects[r.URL.Path] = data
		}
		if loseResponse {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			conn.Close()
			return
		}
		w.WriteHeader(200)
	})
	ctx := t.Context()
	original := probeReceipt(uuid.New())
	other := original
	other.RequestedAt = original.RequestedAt.Add(time.Second)
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, receipt := range []Receipt{original, other} {
		go func() { <-start; results <- archive.Put(ctx, receipt) }()
	}
	close(start)
	first, second := <-results, <-results
	if !(first == nil && errors.Is(second, errConflict) || second == nil && errors.Is(first, errConflict)) {
		t.Fatalf("concurrent conflicting create: %v, %v", first, second)
	}
	winner, err := archive.Read(ctx, original.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if err := archive.Put(ctx, winner); err != nil {
		t.Fatalf("same-content retry: %v", err)
	}
	got, err := archive.Read(ctx, winner.OperationID)
	if err != nil || !winner.RequestedAt.Equal(got.RequestedAt) {
		t.Fatalf("winner changed: %v", err)
	}

	mu.Lock()
	loseResponse, persist = true, true
	before := attempts
	mu.Unlock()
	if err := archive.Put(ctx, probeReceipt(uuid.New())); err != nil {
		t.Fatalf("committed write with lost response was not reconciled: %v", err)
	}
	mu.Lock()
	n := attempts - before
	persist = false
	before = attempts
	mu.Unlock()
	if n != 1 {
		t.Fatalf("SDK repeated the write after losing its response: %d requests", n)
	}
	if err := archive.Put(ctx, probeReceipt(uuid.New())); !errors.Is(err, errUnconfirmed) {
		t.Fatalf("missing readback must stay unconfirmed: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if n := attempts - before; n != 1 {
		t.Fatalf("ambiguous absent receipt generated %d writes", n)
	}
}

func TestOSSProbeAndPagination(t *testing.T) {
	const probeID = "bfde5780-c421-433e-9c41-daaa6c05081b"
	const firstID = "7101b030-cfc2-4ee5-885c-03f6e3fcad00"
	const secondID = "9101b030-cfc2-4ee5-885c-03f6e3fcad00"
	var mu sync.Mutex
	objects := map[string][]byte{}
	for _, id := range []string{firstID, secondID} {
		data, err := canonicalReceipt(probeReceipt(uuid.MustParse(id)))
		if err != nil {
			t.Fatal(err)
		}
		objects[testPrefix+receipts+id+".json"] = data
	}
	var listFault string
	archive := testOSS(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Has("versioning") {
			io.WriteString(w, "<VersioningConfiguration/>")
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/"+testBucket+"/")
		switch {
		case r.Method == http.MethodPut:
			if key != testPrefix+probes+probeID+".json" || r.Header.Get("x-oss-forbid-overwrite") != "true" {
				t.Error("probe escaped its conditional synthetic key")
				w.WriteHeader(400)
				return
			}
			if objects[key] != nil {
				ossError(w, 409, "FileAlreadyExists")
				return
			}
			objects[key], _ = io.ReadAll(r.Body)
			w.WriteHeader(200)
		case r.URL.Query().Get("list-type") == "2":
			prefix, token := r.URL.Query().Get("prefix"), r.URL.Query().Get("continuation-token")
			if prefix == testPrefix+probes {
				listPage(w, prefix, prefix+probeID+".json", false, "")
			} else if prefix != testPrefix+receipts {
				t.Errorf("bad list scope %q", prefix)
				w.WriteHeader(400)
			} else if token == "" {
				listPage(w, prefix, prefix+firstID+".json", true, "page-2")
			} else if token == "page-2" {
				switch listFault {
				case "denied":
					ossError(w, 403, "AccessDenied")
				case "prefix":
					listPage(w, prefix, testPrefix+probes+probeID+".json", false, "")
				case "truncated-field":
					fmt.Fprintf(w, "<ListBucketResult><Name>%s</Name><Prefix>%s</Prefix><KeyCount>1</KeyCount><Contents><Key>%s</Key></Contents></ListBucketResult>",
						testBucket, prefix, prefix+secondID+".json")
				case "cursor":
					listPage(w, prefix, prefix+secondID+".json", true, token)
				default:
					listPage(w, prefix, prefix+secondID+".json", false, "")
				}
			} else {
				t.Errorf("unexpected continuation %q", token)
				w.WriteHeader(400)
			}
		case r.Method == http.MethodGet:
			if data := objects[key]; data != nil {
				w.Write(data)
			} else {
				ossError(w, 404, "NoSuchKey")
			}
		default:
			t.Errorf("unexpected network operation %q", r.Method)
			w.WriteHeader(400)
		}
	})
	ctx := t.Context()
	if err := archive.Probe(ctx, uuid.MustParse(probeID)); err != nil {
		t.Fatal(err)
	}
	if err := archive.VerifyProbe(ctx, uuid.MustParse(probeID)); err != nil {
		t.Fatal(err)
	}
	if err := archive.VerifyProbe(ctx, uuid.New()); err == nil {
		t.Fatal("empty probe namespace was treated as verified")
	}
	visit := func() ([]string, error) {
		seen := []string{}
		err := archive.Each(ctx, func(receipt Receipt) error {
			seen = append(seen, receipt.OperationID.String())
			return nil
		})
		return seen, err
	}
	if seen, err := visit(); err != nil || strings.Join(seen, ",") != firstID+","+secondID {
		t.Fatalf("incomplete listing: %v, %v", seen, err)
	}
	for _, fault := range []string{"denied", "prefix", "cursor", "truncated-field"} {
		mu.Lock()
		listFault = fault
		mu.Unlock()
		if seen, err := visit(); err == nil || len(seen) != 1 || strings.Contains(err.Error(), "fixture-sensitive-message") {
			t.Fatalf("listing %s boundary: %v, %v", fault, seen, err)
		}
	}
}

func listPage(w http.ResponseWriter, prefix, key string, truncated bool, token string) {
	fmt.Fprintf(w, "<ListBucketResult><Name>%s</Name><Prefix>%s</Prefix><IsTruncated>%t</IsTruncated><KeyCount>1</KeyCount><Contents><Key>%s</Key></Contents>",
		testBucket, prefix, truncated, key)
	if token != "" {
		fmt.Fprintf(w, "<NextContinuationToken>%s</NextContinuationToken>", token)
	}
	io.WriteString(w, "</ListBucketResult>")
}

func TestOSSVersioningAndReceiptValidation(t *testing.T) {
	for _, version := range []string{"Enabled", "Suspended", "Unexpected", "malformed"} {
		t.Run(version, func(t *testing.T) {
			archive := testOSS(t, func(w http.ResponseWriter, r *http.Request) {
				if !r.URL.Query().Has("versioning") {
					t.Error("write attempted before bucket versioning check")
					w.WriteHeader(500)
					return
				}
				if version == "malformed" {
					io.WriteString(w, "<Unrelated/>")
					return
				}
				fmt.Fprintf(w, "<VersioningConfiguration><Status>%s</Status></VersioningConfiguration>", version)
			})
			if err := archive.Put(t.Context(), probeReceipt(uuid.New())); err == nil {
				t.Fatal("unsafe bucket accepted")
			}
		})
	}

	r := probeReceipt(uuid.New())
	r.Objects = []Object{{Key: testAssets + "users/" + r.UserID.String() + "/attachments/" + uuid.NewString()}}
	data, err := canonicalReceipt(r)
	if err != nil {
		t.Fatal(err)
	}
	archive := &OSS{location: OSSLocation{ObjectPrefix: testAssets}}
	if _, err := archive.decodeReceipt(data, r.OperationID); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(string(data), testAssets, "another/prefix/", 1),
		strings.Replace(string(data), testAssets, testAssets+"inner/", 1),
		strings.Replace(string(data), r.UserID.String()+"/attachments", uuid.NewString()+"/attachments", 1),
		strings.Replace(string(data), `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1),
		strings.Replace(string(data), `"objects"`, `"Objects"`, 1),
		strings.Replace(string(data), `{"key"`, `{"not_before":null,"key"`, 1),
		strings.Replace(string(data), `{"key"`, `{"metadata":"fixture","key"`, 1),
		string(data) + " {}",
	} {
		if _, err := archive.decodeReceipt([]byte(bad), r.OperationID); err == nil {
			t.Fatalf("accepted invalid synthetic receipt: %s", bad)
		}
	}
	if _, err := archive.decodeReceipt(data, uuid.New()); err == nil {
		t.Fatal("receipt did not have to match its object identity")
	}
}

func TestOSSConfigurationRejectsMixedScopesAndUnexpectedFields(t *testing.T) {
	location := OSSLocation{Region: "cn-hangzhou", Endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
		Bucket: testBucket, Prefix: testPrefix, ObjectPrefix: testAssets}
	if _, err := location.validate("production"); err != nil {
		t.Fatal(err)
	}
	for _, changed := range []OSSLocation{
		{location.Region, "http://127.0.0.1:9999", location.Bucket, testPrefix, testAssets},
		{location.Region, "https://oss-cn-hangzhou.aliyuncs.com.evil.test", location.Bucket, testPrefix, testAssets},
		{location.Region, location.Endpoint, location.Bucket, "spark/assets/archive/", testAssets},
		{location.Region, location.Endpoint, location.Bucket, "spark/../archive/", testAssets},
	} {
		if _, err := changed.validate("production"); err == nil {
			t.Fatalf("unsafe location accepted: %+v", changed)
		}
	}
	path := filepath.Join(t.TempDir(), "credentials.json")
	for _, bad := range []string{
		`{"access_key_id":"id","access_key_id":"override","access_key_secret":"secret"}`,
		`{"access_key_id":"id","access_key_secret":"secret","extra":"unknown"}`,
		`{"access_key_id":"id","access_key_secret":null}`,
		`{"access_key_id":"id","access_key_secret":"secret"} {}`,
	} {
		if err := os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if err := loadJSONFile(path, new(accessKey), "access_key_id", "access_key_secret"); err == nil {
			t.Fatal("invalid credential JSON accepted")
		}
	}
}

func TestFileLedgerRemainsDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_DELETION_LEDGER_BACKEND", "")
	t.Setenv("SPARK_DELETION_LEDGER_DIR", dir)
	t.Setenv("SPARK_DELETION_LEDGER_OSS_CONFIG_FILE", "/unused")
	ctx := context.Background()
	archive, err := OpenConfigured(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	receipt := probeReceipt(uuid.New())
	if err := archive.Put(ctx, receipt); err != nil {
		t.Fatal(err)
	}
	if err := archive.Put(ctx, receipt); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, receipt.OperationID.String()+".json"))
	if err != nil || !bytes.Contains(raw, []byte(`"objects":null`)) {
		t.Fatalf("legacy file representation changed: %v", err)
	}
}
