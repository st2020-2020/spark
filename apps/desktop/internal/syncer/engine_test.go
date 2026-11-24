package syncer

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"spark/apps/desktop/internal/api"
	"spark/apps/desktop/internal/auth"
	"spark/apps/desktop/internal/store"
)

type fakeCloud struct {
	mu                sync.Mutex
	offline           bool
	dropFirst201      bool
	force401          bool
	force409Code      string
	activeTokens      map[string]string // token -> accountID
	uploads           map[string]string // uploadID -> status
	uploadIdem        map[string]string // idemKey -> uploadID
	collections       map[string]api.Collection
	collectionIdem    map[string]string // idemKey -> collectionID
	createPostCount   int
	ossPutCount       int
	completeCallCount int
	ossURLBase        string
}

func newFakeCloud() *fakeCloud {
	return &fakeCloud{
		activeTokens:   map[string]string{"tok-A": "acc-A", "tok-B": "acc-B"},
		uploads:        make(map[string]string),
		uploadIdem:     make(map[string]string),
		collections:    make(map[string]api.Collection),
		collectionIdem: make(map[string]string),
	}
}

func (f *fakeCloud) start(t *testing.T) (*httptest.Server, *httptest.Server) {
	t.Helper()
	ossSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		offline := f.offline
		f.mu.Unlock()
		if offline {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" {
			t.Errorf("OSS received forbidden Spark headers: cookie=%q auth=%q origin=%q",
				r.Header.Get("Cookie"), r.Header.Get("Authorization"), r.Header.Get("Origin"))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.ContentLength <= 0 || len(r.TransferEncoding) > 0 {
			t.Errorf("OSS requires explicit Content-Length and no chunked: cl=%d te=%v", r.ContentLength, r.TransferEncoding)
			w.WriteHeader(http.StatusLengthRequired)
			return
		}
		_, _ = io.ReadAll(r.Body)
		f.mu.Lock()
		f.ossPutCount++
		f.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	f.ossURLBase = ossSrv.URL

	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		offline := f.offline
		force401 := f.force401
		force409 := f.force409Code
		f.mu.Unlock()

		if offline {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.Header.Get("Cookie") != "" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"code":"mixed_credentials","message":"mixed"}}`))
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		f.mu.Lock()
		accID := f.activeTokens[token]
		f.mu.Unlock()
		if force401 || accID == "" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"desktop_session_expired","message":"请重新配对"}}`))
			return
		}

		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/uploads":
			idem := r.Header.Get("Idempotency-Key")
			var req api.UploadRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.mu.Lock()
			upID := f.uploadIdem[idem]
			if upID == "" {
				upID = uuid.NewString()
				f.uploadIdem[idem] = upID
				f.uploads[upID] = "pending"
			}
			f.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(api.UploadGrant{
				ID:        upID,
				URL:       f.ossURLBase + "/staging/" + upID,
				Method:    "PUT",
				Headers:   map[string]string{"Content-Type": req.MimeType},
				ExpiresAt: time.Now().Add(10 * time.Minute),
			})
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/v1/uploads/") && strings.HasSuffix(r.URL.Path, "/complete"):
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/uploads/"), "/complete")
			f.mu.Lock()
			f.completeCallCount++
			f.uploads[id] = "verifying"
			f.mu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(api.Upload{ID: id, Status: "verifying", ExpiresAt: time.Now().Add(24 * time.Hour)})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/uploads/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/uploads/")
			f.mu.Lock()
			st := f.uploads[id]
			if st == "verifying" {
				st = "ready"
				f.uploads[id] = "ready"
			}
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(api.Upload{ID: id, Status: st, ExpiresAt: time.Now().Add(24 * time.Hour)})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/collections":
			idem := r.Header.Get("Idempotency-Key")
			var req api.CollectionCreate
			_ = json.NewDecoder(r.Body).Decode(&req)

			f.mu.Lock()
			f.createPostCount++
			if force409 != "" {
				f.mu.Unlock()
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":{"code":"` + force409 + `","message":"conflict"}}`))
				return
			}
			if existingID, ok := f.collectionIdem[idem]; ok {
				col := f.collections[existingID]
				f.mu.Unlock()
				w.Header().Set("Idempotent-Replayed", "true")
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(col)
				return
			}
			col := api.Collection{
				ID:          req.ID,
				PlainText:   "synced-" + accID,
				CreatedAt:   time.Now().UTC().Format(time.RFC3339),
				UpdatedAt:   time.Now().UTC().Format(time.RFC3339),
				PrimaryType: "text",
			}
			if len(req.UploadIDs) > 0 {
				col.PrimaryType = "image"
				for _, uid := range req.UploadIDs {
					col.Attachments = append(col.Attachments, api.Attachment{ID: uid, Filename: "shot.png", MimeType: "image/png", SizeBytes: 16})
				}
			}
			f.collections[req.ID] = col
			f.collectionIdem[idem] = req.ID
			drop := f.dropFirst201
			if drop {
				f.dropFirst201 = false
			}
			f.mu.Unlock()

			if drop {
				// Simulate response lost after server committed!
				hj, ok := w.(http.Hijacker)
				if ok {
					conn, _, err := hj.Hijack()
					if err == nil {
						_ = conn.Close()
						return
					}
				}
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(col)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v1/collections/"):
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/collections/")
			f.mu.Lock()
			col, ok := f.collections[id]
			f.mu.Unlock()
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":{"code":"not_found","message":"missing"}}`))
				return
			}
			_ = json.NewEncoder(w).Encode(col)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	return apiSrv, ossSrv
}

func samplePNG() []byte {
	return []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82}
}

func TestOfflineCaptureRestartReconnectSingleCloudRecord(t *testing.T) {
	cloud := newFakeCloud()
	cloud.offline = true
	cloud.dropFirst201 = true // Also verify lost 201 replay still produces exactly 1 collection!
	apiSrv, ossSrv := cloud.start(t)
	defer apiSrv.Close()
	defer ossSrv.Close()

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	creds := testSessions(t, apiSrv.URL)
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	_ = creds.Save(auth.StoredSession{Origin: apiSrv.URL, Token: "tok-A", AccountID: "acc-A", AccountLabel: "a@example.com", ExpiresAt: now.Add(30 * 24 * time.Hour)})

	// Capture while offline.
	item, err := st.EnqueueCapture(store.EnqueueInput{
		AccountID: "acc-A",
		RawText:   "断网记录带截图",
		Attachments: []store.PendingAttachmentInput{
			{Filename: "screen.png", Data: samplePNG()},
		},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if item.State != store.OutboxLocalSaved {
		t.Fatalf("expected local_saved, got %s", item.State)
	}

	client, err := api.NewClient(apiSrv.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	eng := New(st, creds, client)
	eng.SetClock(func() time.Time { return now })
	eng.SyncOnce(context.Background())

	// Still offline -> remains local_saved, zero cloud records.
	afterOffline, _, _ := st.GetOutboxItem("acc-A", item.ID)
	if afterOffline.State != store.OutboxLocalSaved {
		t.Fatalf("expected local_saved while offline, got %s", afterOffline.State)
	}
	_ = st.Close()

	// Simulate app restart & network recovery.
	st2, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()

	cloud.mu.Lock()
	cloud.offline = false
	cloud.mu.Unlock()

	eng2 := New(st2, creds, client)
	cur := now.Add(20 * time.Second)
	eng2.SetClock(func() time.Time { return cur })

	// First sync uploads to OSS + completes (202 -> ready) + hits dropped 201.
	eng2.SyncOnce(context.Background())
	// Second sync replays with frozen UUID + Idempotency-Key -> gets replayed 201!
	cur = cur.Add(20 * time.Second)
	eng2.SyncOnce(context.Background())

	final, ok, err := st2.GetOutboxItem("acc-A", item.ID)
	if err != nil || !ok || final.State != store.OutboxSynced {
		t.Fatalf("expected synced after replay, got %+v ok=%v err=%v", final, ok, err)
	}
	cloud.mu.Lock()
	defer cloud.mu.Unlock()
	if len(cloud.collections) != 1 {
		t.Fatalf("expected exactly 1 cloud collection after restart+lost201, got %d", len(cloud.collections))
	}
	if cloud.ossPutCount != 1 {
		t.Fatalf("expected exactly 1 OSS PUT, got %d", cloud.ossPutCount)
	}
	if cloud.createPostCount != 2 {
		t.Fatalf("expected 2 POST attempts (1 dropped + 1 replay), got %d", cloud.createPostCount)
	}
}

func TestNeverSentPast7DaysAndSentUnknownPast7Days(t *testing.T) {
	cloud := newFakeCloud()
	apiSrv, ossSrv := cloud.start(t)
	defer apiSrv.Close()
	defer ossSrv.Close()

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	creds := testSessions(t, apiSrv.URL)
	t0 := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	_ = creds.Save(auth.StoredSession{Origin: apiSrv.URL, Token: "tok-A", AccountID: "acc-A", AccountLabel: "a@example.com", ExpiresAt: t0.Add(30 * 24 * time.Hour)})

	// Draft 1: offline, NEVER sent for 10 days -> must succeed on first send!
	neverSent, err := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", RawText: "十天前离线草稿"}, t0)
	if err != nil {
		t.Fatal(err)
	}

	// Draft 2: sent 8 days ago, response unknown, NOT in cloud (404) -> must mark needs_review, NEVER swap ID!
	sentUnknown, err := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", RawText: "八天前发过但不知结果"}, t0)
	if err != nil {
		t.Fatal(err)
	}
	_ = st.FreezeOutboxRequest("acc-A", sentUnknown.ID, `{"id":"`+sentUnknown.ID+`","document":{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"八天前"}]}]}},"upload_ids":[],"project_ids":[],"tag_ids":[],"ai_excluded":false}`, t0)
	_ = st.MarkOutboxSent("acc-A", sentUnknown.ID, t0)

	client, _ := api.NewClient(apiSrv.URL, true)
	eng := New(st, creds, client)
	eng.SetClock(func() time.Time { return t0.Add(10 * 24 * time.Hour) })
	eng.SyncOnce(context.Background())

	gotNeverSent, _, _ := st.GetOutboxItem("acc-A", neverSent.ID)
	if gotNeverSent.State != store.OutboxSynced {
		t.Fatalf("expected >7d never-sent draft to sync cleanly, got %+v", gotNeverSent)
	}
	gotUnknown, _, _ := st.GetOutboxItem("acc-A", sentUnknown.ID)
	if gotUnknown.State != store.OutboxNeedsReview || gotUnknown.ID != sentUnknown.ID {
		t.Fatalf("expected >7d sent-unknown 404 to enter needs_review without swapping ID, got %+v", gotUnknown)
	}
	cloud.mu.Lock()
	if _, exists := cloud.collections[sentUnknown.ID]; exists {
		t.Fatalf("sent-unknown past 7d must not be blindly recreated/resurrected")
	}
	cloud.mu.Unlock()
}

func Test401StopsQueueAndAccountSwitchDoesNotCrossQueues(t *testing.T) {
	cloud := newFakeCloud()
	cloud.force401 = true
	apiSrv, ossSrv := cloud.start(t)
	defer apiSrv.Close()
	defer ossSrv.Close()

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	now := time.Now().UTC()
	creds := testSessions(t, apiSrv.URL)
	_ = creds.Save(auth.StoredSession{Origin: apiSrv.URL, Token: "tok-A", AccountID: "acc-A", AccountLabel: "a@example.com", ExpiresAt: now.Add(30 * 24 * time.Hour)})

	itemA1, _ := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", RawText: "A1"}, now)
	itemA2, _ := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", RawText: "A2"}, now.Add(time.Second))

	client, _ := api.NewClient(apiSrv.URL, true)
	eng := New(st, creds, client)
	client.OnUnauthorized = eng.HandleUnauthorized
	eng.SetClock(func() time.Time { return now.Add(2 * time.Second) })
	eng.SyncOnce(context.Background())

	// Both A1 and A2 must pause on 401; only 1 POST attempted before stopping.
	gotA1, _, _ := st.GetOutboxItem("acc-A", itemA1.ID)
	gotA2, _, _ := st.GetOutboxItem("acc-A", itemA2.ID)
	if gotA1.State != store.OutboxAuthPaused || gotA2.State != store.OutboxAuthPaused {
		t.Fatalf("expected both A items auth_paused on 401, got %s and %s", gotA1.State, gotA2.State)
	}

	// Switch to Account B and lift 401: Account B syncing must NEVER send Account A's items.
	cloud.mu.Lock()
	cloud.force401 = false
	cloud.mu.Unlock()
	_ = creds.Save(auth.StoredSession{Origin: apiSrv.URL, Token: "tok-B", AccountID: "acc-B", AccountLabel: "b@example.com", ExpiresAt: now.Add(30 * 24 * time.Hour)})
	itemB, _ := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-B", RawText: "B1"}, now.Add(3*time.Second))

	eng.SyncOnce(context.Background())

	gotB, _, _ := st.GetOutboxItem("acc-B", itemB.ID)
	if gotB.State != store.OutboxSynced {
		t.Fatalf("expected B1 synced, got %+v", gotB)
	}
	gotA1Again, _, _ := st.GetOutboxItem("acc-A", itemA1.ID)
	if gotA1Again.State != store.OutboxAuthPaused {
		t.Fatalf("account A queue must remain isolated after switching to B, got %s", gotA1Again.State)
	}
}

func Test409DuplicateResourcePreservesLocalDraftForReview(t *testing.T) {
	cloud := newFakeCloud()
	cloud.force409Code = "duplicate_resource"
	apiSrv, ossSrv := cloud.start(t)
	defer apiSrv.Close()
	defer ossSrv.Close()

	dir := t.TempDir()
	st, _ := store.Open(dir)
	defer st.Close()
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	creds := testSessions(t, apiSrv.URL)
	_ = creds.Save(auth.StoredSession{Origin: apiSrv.URL, Token: "tok-A", AccountID: "acc-A", AccountLabel: "a@example.com", ExpiresAt: now.Add(30 * 24 * time.Hour)})

	item, _ := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", RawText: "冲突测试"}, now)
	client, _ := api.NewClient(apiSrv.URL, true)
	eng := New(st, creds, client)
	eng.SetClock(func() time.Time { return now })
	eng.SyncOnce(context.Background())

	got, _, _ := st.GetOutboxItem("acc-A", item.ID)
	if got.State != store.OutboxNeedsReview || got.LastErrorCode != "duplicate_resource" {
		t.Fatalf("expected needs_review with duplicate_resource, got %+v", got)
	}
}

func TestDeletedReceiptKeepsLocalOriginal(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	now := time.Now()
	item, err := st.EnqueueCapture(store.EnqueueInput{AccountID: "owner", RawText: "  original text  "}, now)
	if err != nil {
		t.Fatal(err)
	}
	read := st.BeginCollectionRead("owner")
	defer read.Close()
	if _, err := read.ApplyDetail(api.Collection{ID: item.ID, PlainText: "old cloud copy"}); err != nil {
		t.Fatal(err)
	}
	engine := New(st, testSessions(t, "https://example.test"), nil)
	deleted := now.UTC().Format(time.RFC3339)
	engine.acceptReceipt(read, item, api.Collection{ID: item.ID, DeletedAt: &deleted})
	if _, ok, err := st.GetCachedCollectionDetail("owner", item.ID); ok || err != nil {
		t.Fatal("deleted receipt still cached", err)
	}
	got, found, err := st.GetOutboxItem("owner", item.ID)
	if err != nil || !found || got.State != store.OutboxNeedsReview || got.RawText != "  original text  " {
		t.Fatal("deleted receipt discarded or altered the local draft")
	}
}

type interruptedVerification struct {
	BackendClient
	polling chan struct{}
}

func (c interruptedVerification) GetUpload(ctx context.Context, _ auth.StoredSession, _ string) (api.Upload, error) {
	close(c.polling)
	<-ctx.Done()
	return api.Upload{}, ctx.Err()
}

func TestCancelDuringVerificationResumesWithSameUpload(t *testing.T) {
	cloud := newFakeCloud()
	id := uuid.NewString()
	cloud.uploads[id] = "verifying"
	upstream, oss := cloud.start(t)
	defer upstream.Close()
	defer oss.Close()
	client, err := api.NewClient(upstream.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	creds := testSessions(t, upstream.URL)
	if err := creds.Save(auth.StoredSession{Token: "tok-A", AccountID: "acc-A", Origin: upstream.URL, ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	item, err := st.EnqueueCapture(store.EnqueueInput{AccountID: "acc-A", Attachments: []store.PendingAttachmentInput{{Filename: "note.png", Data: samplePNG()}}}, now)
	if err != nil {
		t.Fatal(err)
	}
	att := item.Attachments[0]
	if err := st.UpdateAttachmentGrant("acc-A", att.ID, id, store.StageVerifying, now, now.Add(24*time.Hour), api.UploadGrant{}); err != nil {
		t.Fatal(err)
	}
	interrupted := interruptedVerification{client, make(chan struct{})}
	engine := New(st, creds, interrupted)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); engine.SyncOnce(ctx) }()
	select {
	case <-interrupted.polling:
	case <-ctx.Done():
		t.Fatal("verification did not start")
	}
	cancel()
	<-done
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	retained, found, err := st.GetOutboxItem("acc-A", item.ID)
	if err != nil || !found || retained.State != store.OutboxSyncing || len(retained.Attachments) != 1 || retained.Attachments[0].Stage != store.StageVerifying || retained.Attachments[0].UploadID != id {
		t.Fatalf("lost resumable upload: %+v, %v", retained, err)
	}
	if err := st.ResetInterruptedSyncing("acc-A", time.Now()); err != nil {
		t.Fatal(err)
	}
	New(st, creds, client).SyncOnce(t.Context())
	synced, _, err := st.GetOutboxItem("acc-A", item.ID)
	if err != nil || synced.State != store.OutboxSynced {
		t.Fatalf("resume: %s, %v", synced.State, err)
	}
	cloud.mu.Lock()
	defer cloud.mu.Unlock()
	if cloud.ossPutCount != 0 || len(cloud.uploadIdem) != 0 || cloud.createPostCount != 1 {
		t.Fatal("registration or upload repeated on restart")
	}
}

type catalogBackend struct {
	BackendClient
	requests int
	offline  bool
}

func (c *catalogBackend) ListProjects(context.Context, auth.StoredSession, string, string, string, int) (api.ProjectPage, error) {
	c.requests++
	return api.ProjectPage{Items: []api.Project{{ID: "p", Name: "参考"}}}, nil
}
func (c *catalogBackend) ListTags(context.Context, auth.StoredSession, string, string, int) (api.TagPage, error) {
	if c.offline {
		return api.TagPage{}, io.ErrUnexpectedEOF
	}
	return api.TagPage{Items: []api.Tag{{ID: "t", Name: "速写"}}}, nil
}

func TestCatalogWithoutBookWindow(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	creds := testSessions(t, "https://example.test")
	client := &catalogBackend{}
	e := New(st, creds, client)
	now := time.Now()
	e.SetClock(func() time.Time { return now })
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	changed, done := make(chan struct{}, 1), make(chan struct{})
	e.SetOnChange(func() { changed <- struct{}{} })
	go func() { defer close(done); e.Run(ctx) }()
	sess := auth.StoredSession{Origin: "https://example.test", AccountID: "owner", Token: "session", ExpiresAt: now.Add(time.Hour)}
	if err := creds.Save(sess); err != nil {
		t.Fatal(err)
	}
	e.RequestCatalog()
	select {
	case <-changed:
	case <-ctx.Done():
		t.Fatal("login/panel request did not refresh")
	}
	cancel()
	<-done
	p, err := st.ListCachedProjects("owner")
	if err != nil || len(p) != 1 || p[0].Name != "参考" {
		t.Fatal("missing projects", err)
	}
	if err := e.refreshCatalog(t.Context(), sess, false); err != nil || client.requests != 1 {
		t.Fatal("fresh directory refetched", err)
	}
	now = now.Add(6 * time.Minute)
	client.offline = true
	if err := e.refreshCatalog(t.Context(), sess, false); err == nil || client.requests != 2 {
		t.Fatal("stale directory not refreshed")
	}
	tags, err := st.ListCachedTags("owner")
	if err != nil || len(tags) != 1 || tags[0].Name != "速写" {
		t.Fatal("offline refresh discarded directory", err)
	}
}

func testSessions(t *testing.T, origin string) *auth.Sessions {
	t.Helper()
	sessions, err := auth.OpenSessions(auth.NewMemoryStore(), origin)
	if err != nil {
		t.Fatal(err)
	}
	return sessions
}
