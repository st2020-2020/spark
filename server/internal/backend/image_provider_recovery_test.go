package backend

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestLegacyImageProviderRecoveryRequiresSettledUsage(t *testing.T) {
	for _, tt := range []struct {
		name, state string
		first       bool
	}{
		{"first recognition settled", "settled", true},
		{"old recovery settled", "settled", false},
		{"first recognition uncertain", "uncertain", true},
		{"old recovery uncertain", "uncertain", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			app, addr := testBackend(t)
			owner := imageTestAccount(t, app, addr, "provider-recovery")
			foreign := imageTestAccount(t, app, addr, "foreign-provider-recovery")
			uid := owner.do("GET", "/auth/session", nil, "").want(t, 200)["user"].(map[string]any)["id"].(string)
			app.Config.ImageAnalysisEnabled, app.Config.ImageAdminID = true, uid
			objects, _, storage := newUploadStorageFixture(t)
			app.Assets = storage
			enableImageTestAccount(owner)
			setImageTestBudget(owner, 1, 100_000, 100_000)
			collection := saveImageCollection(t, app, owner, objects)
			original := waitForImageStatus(t, owner, collection.id, "queued")["id"].(string)
			legacyID := uuid.NewString()
			if tt.first {
				legacyID = original
			}
			createLegacyProviderFailure(t, app, uid, original, legacyID, tt.state)

			current := waitForImageStatus(t, owner, collection.id, "failed")
			eligible, _ := current["image_retry_available"].(bool)
			if current["id"] != legacyID || eligible != (tt.state == "settled") {
				t.Fatalf("past provider failure has incorrect eligibility: %v", current)
			}
			path := "/attachments/" + collection.attachmentID + "/image-analysis/retry"
			body := map[string]any{"base_extraction_id": legacyID, "consent_version": "deepseek-image-retry-v1"}
			foreign.do("POST", path, body, uuid.NewString()).want(t, 404)
			if tt.state == "uncertain" {
				rejected := owner.do("POST", path, body, uuid.NewString())
				if tt.first {
					rejected.want(t, 422)
				} else if result := rejected.want(t, 202); result["id"] != legacyID || result["status"] != "failed" {
					t.Fatal("uncertain attempt was replaced")
				}
				return
			}
			owner.do("PUT", "/me/image-analysis", map[string]any{"enabled": false}, "").want(t, 200)
			owner.do("POST", path, body, uuid.NewString()).want(t, 403)
			enableImageTestAccount(owner)
			key := uuid.NewString()
			created := owner.do("POST", path, body, key).want(t, 202)
			id := created["id"].(string)
			if id == legacyID || created["status"] != "queued" {
				t.Fatalf("explicit confirmation did not create a distinct attempt: %v", created)
			}
			for _, k := range []string{key, uuid.NewString()} {
				if again := owner.do("POST", path, body, k).want(t, 202); again["id"] != id {
					t.Fatal("repeat did not use the same compatible recovery job")
				}
			}

			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				verifyImageModelRequest(t, r)
				calls.Add(1)
				modelReply(w, "stop", `{"layout":{"text":"伪造字段A23"},"text":"合成供水图 V17 阀门"}`, map[string]int{"prompt_tokens": 999, "completion_tokens": 53})
			}))
			t.Cleanup(provider.Close)
			startImageTestWorker(t, app, storage, provider.URL)
			result := waitForImageStatus(t, owner, collection.id, "succeeded")
			if result["id"] != id || result["text"] != "合成供水图 V17 阀门" || result["image_retry_available"] == true {
				t.Fatalf("compatible attempt lost the exact excerpt: %v", result)
			}
			if entries := imageExtractions(t, owner, collection.id); len(entries) != 1 {
				t.Fatalf("obsolete extractions remained current: %v", entries)
			}
			hits := owner.do("GET", "/search?q=V17", nil, "").want(t, 200)["items"].([]any)
			if len(hits) != 1 {
				t.Fatal("recovered text was not searchable")
			}
			if metadataHits := owner.do("GET", "/search?q=A23", nil, "").want(t, 200)["items"].([]any); len(metadataHits) != 0 {
				t.Fatal("ignored metadata was searchable")
			}
			if replay := owner.do("POST", path, body, uuid.NewString()).want(t, 202); replay["id"] != id || replay["status"] != "succeeded" {
				t.Fatal("a further intent replaced the one compatible recovery")
			}
			var entries, units int
			err := app.Pool.QueryRow(t.Context(), `SELECT count(*),sum(actual_units) FROM usage_reservations
				WHERE user_id=$1 AND image_extraction_id IN ($2,$3) AND state='settled'`, uid, legacyID, id).Scan(&entries, &units)
			if err != nil || entries != 2 || units != 4844 || calls.Load() != 1 {
				t.Fatalf("expected immutable historical and new accounting: %d entries, %d units, %d calls, %v", entries, units, calls.Load(), err)
			}
		})
	}
}

func createLegacyProviderFailure(t *testing.T, app *Server, uid, initial, recovery, state string) {
	t.Helper()
	ctx := t.Context()
	if initial == recovery {
		if _, err := app.Pool.Exec(ctx, `UPDATE extractions SET status='failed',error_code='invalid_model_output'
			WHERE user_id=$1 AND id=$2`, uid, initial); err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := app.Pool.Exec(ctx, `UPDATE extractions SET status='partial',evidence_meta='{"truncated":true}',error_code='image_output_truncated'
		WHERE user_id=$1 AND id=$2`, uid, initial); err != nil {
			t.Fatal(err)
		}
		if _, err := app.Pool.Exec(ctx, `INSERT INTO extractions
		(id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,extractor_version,
		 image_user_policy_version,image_collection_policy_version,status,error_code)
		SELECT $3,user_id,collection_id,content_version,source_kind,source_id,attachment_id,
		 'deepseek-flash-image-recovery-v1',image_user_policy_version,image_collection_policy_version,'failed','invalid_model_output'
		FROM extractions WHERE user_id=$1 AND id=$2`, uid, initial, recovery); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := app.Pool.Exec(ctx, `INSERT INTO usage_reservations
		(id,user_id,image_extraction_id,attempt_no,budget_day,route,config_version,model,reserved_units,state,actual_units,input_tokens,output_tokens,error_code)
		VALUES($1,$2,$3,1,$4::date,'deepseek-image','deepseek-flash-image-v1','deepseek-flash',7168,$5,
		CASE WHEN $5='settled' THEN 2422 END,CASE WHEN $5='settled' THEN 999 END,CASE WHEN $5='settled' THEN 53 END,'invalid_model_output')`,
		uuid.NewString(), uid, recovery, budgetDay(), state); err != nil {
		t.Fatal(err)
	}
}
