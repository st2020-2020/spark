package backend

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type sesTestTransport func(*http.Request) (*http.Response, error)

func (f sesTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type sesTestRequest struct {
	FromEmailAddress string
	Destination      []string
	Subject          string
	TriggerType      uint64
	Template         struct {
		TemplateID   uint64
		TemplateData string
	}
}

func newSESFixture(t *testing.T, respond func(*http.Request) (*http.Response, error)) (*TencentSESDelivery, <-chan sesTestRequest) {
	t.Helper()
	t.Setenv("SPARK_SES_REGION", "ap-guangzhou")
	t.Setenv("SPARK_SES_FROM", "spark@mail.example.test")
	t.Setenv("SPARK_SES_REGISTER_TEMPLATE_ID", "10001")
	t.Setenv("SPARK_SES_RESET_TEMPLATE_ID", "10002")
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(`{"secret_id":"synthetic-id","secret_key":"synthetic-key"}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SPARK_SES_CREDENTIALS_FILE", path)
	requests := make(chan sesTestRequest, 16)
	sender, err := loadTencentSESDelivery(sesTestTransport(func(req *http.Request) (*http.Response, error) {
		defer req.Body.Close()
		if req.URL.String() != "https://ses.tencentcloudapi.com/" || req.Method != http.MethodPost ||
			req.Header.Get("X-TC-Action") != "SendEmail" || req.Header.Get("X-TC-Version") != "2020-10-02" ||
			req.Header.Get("X-TC-Region") != "ap-guangzhou" ||
			!strings.HasPrefix(req.Header.Get("Authorization"), "TC3-HMAC-SHA256 ") ||
			req.Header.Get("X-Idempotency-Key") != "" {
			t.Error("unexpected SES endpoint, action, region or signing")
		}
		var wire sesTestRequest
		decoder := json.NewDecoder(req.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&wire); err != nil {
			t.Error("unexpected SES request fields")
		}
		requests <- wire
		return respond(req)
	}))
	if err != nil {
		t.Fatal(err)
	}
	return sender, requests
}

func sesTestResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func sesAcceptedResponse(_ *http.Request) (*http.Response, error) {
	return sesTestResponse(200, `{"Response":{"RequestId":"synthetic-request","MessageId":"synthetic-message"}}`), nil
}

func receiveSESCode(t *testing.T, requests <-chan sesTestRequest, template uint64, recipient, subject string) string {
	t.Helper()
	select {
	case wire := <-requests:
		var variables map[string]string
		if len(wire.Destination) != 1 || wire.Destination[0] != recipient ||
			wire.FromEmailAddress != "spark@mail.example.test" || wire.TriggerType != 1 ||
			wire.Template.TemplateID != template || wire.Subject != subject ||
			json.Unmarshal([]byte(wire.Template.TemplateData), &variables) != nil ||
			len(variables) != 1 || len(variables["code"]) != 6 {
			t.Fatal("unexpected SES template, recipient, or variables")
		}
		return variables["code"]
	case <-time.After(8 * time.Second):
		t.Fatal("SES request was not sent")
		return ""
	}
}

func TestTencentSESVerificationRegistersAndResetsPassword(t *testing.T) {
	app, base := testBackend(t)
	admin := imageTestAccount(t, app, base, "ses-admin")
	const invite = "INVITE-SES-0001"
	admin.invite(invite)
	app.Config.MailMode = "tencent-ses"
	sender, requests := newSESFixture(t, sesAcceptedResponse)
	worker, err := StartMailWorker(context.Background(), app.Pool, app.Config.EncryptionKey, sender)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)

	const email = "ses-register@example.test"
	client := newClient(t, app, base)
	registration := requestMailChallenge(t, client, email, "register")
	code := receiveSESCode(t, requests, 10001, email, "Spark 注册验证码")
	waitMailState(t, app, registration, "accepted", true)
	client.do("POST", "/auth/register", map[string]any{
		"email": email, "password": "test-password-12345", "invite_code": invite,
		"challenge_id": registration, "verification_code": code,
	}, "").want(t, 201)
	second := newClient(t, app, base)
	second.signIn(email)

	reset := requestMailChallenge(t, client, email, "password_reset")
	code = receiveSESCode(t, requests, 10002, email, "Spark 密码重置验证码")
	waitMailState(t, app, reset, "accepted", true)
	client.do("POST", "/auth/password-reset", map[string]any{
		"email": email, "challenge_id": reset, "verification_code": code, "new_password": "updated-test-password-12345",
	}, "").want(t, 204)
	for _, old := range []*apiClient{client, second} {
		old.do("GET", "/auth/session", nil, "").want(t, 401)
	}
}

func TestTencentSESRetryAndUnknownAcceptance(t *testing.T) {
	app, base := testBackend(t)
	app.Config.MailMode = "tencent-ses"
	type response = func(*http.Request) (*http.Response, error)
	outcomes := make(chan response, 1)
	sender, requests := newSESFixture(t, func(req *http.Request) (*http.Response, error) {
		select {
		case outcome := <-outcomes:
			return outcome(req)
		default:
			t.Error("unexpected extra SES submission")
			return nil, io.ErrUnexpectedEOF
		}
	})
	worker, err := StartMailWorker(context.Background(), app.Pool, app.Config.EncryptionKey, sender)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	client := newClient(t, app, base)

	const retryEmail = "ses-rate@example.test"
	outcomes <- func(*http.Request) (*http.Response, error) {
		return sesTestResponse(200, `{"Response":{"Error":{"Code":"RequestLimitExceeded","Message":"fixture-private-provider-detail"},"RequestId":"request-1"}}`), nil
	}
	id := requestMailChallenge(t, client, retryEmail, "register")
	code := receiveSESCode(t, requests, 10001, retryEmail, "Spark 注册验证码")
	waitMailState(t, app, id, "queued", false)
	waitImageTest(t, "SES retry after explicit rejection", func() bool {
		var ok bool
		err := app.Pool.QueryRow(t.Context(), `SELECT state='retryable' AND attempt=1 AND scheduled_at>now()
			AND errors::text LIKE '%ses_rate_limited%' AND errors::text NOT LIKE '%fixture-private-provider-detail%'
			FROM river_job WHERE kind='spark_send_mail' AND args->>'challenge_id'=$1`, id).Scan(&ok)
		return err == nil && ok
	})
	outcomes <- sesAcceptedResponse
	if _, err := app.Pool.Exec(t.Context(), `UPDATE river_job SET state='available',scheduled_at=now()
		WHERE kind='spark_send_mail' AND args->>'challenge_id'=$1 AND state='retryable'`, id); err != nil {
		t.Fatal(err)
	}
	if receiveSESCode(t, requests, 10001, retryEmail, "Spark 注册验证码") != code {
		t.Fatal("retry used a different code")
	}
	waitMailState(t, app, id, "accepted", true)

	for _, tc := range []struct {
		name, state string
		respond     response
	}{
		{"disconnect", "uncertain", func(*http.Request) (*http.Response, error) {
			return nil, io.ErrUnexpectedEOF
		}},
		{"bad-json", "uncertain", func(*http.Request) (*http.Response, error) {
			return sesTestResponse(200, `{"Response":`), nil
		}},
		{"no-message-id", "uncertain", func(*http.Request) (*http.Response, error) {
			return sesTestResponse(200, `{"Response":{"RequestId":"request-2"}}`), nil
		}},
		{"redirect", "uncertain", func(*http.Request) (*http.Response, error) {
			resp := sesTestResponse(307, "")
			resp.Header.Set("Location", "https://ses.tencentcloudapi.com/redirect")
			return resp, nil
		}},
		{"gateway", "uncertain", func(*http.Request) (*http.Response, error) {
			return sesTestResponse(502, "{}"), nil
		}},
		{"internal-error", "uncertain", func(*http.Request) (*http.Response, error) {
			return sesTestResponse(200, `{"Response":{"Error":{"Code":"InternalError","Message":"fixture-private-provider-detail"},"RequestId":"request-3"}}`), nil
		}},
		{"template-rejected", "failed", func(*http.Request) (*http.Response, error) {
			return sesTestResponse(200, `{"Response":{"Error":{"Code":"FailedOperation.InvalidTemplateID","Message":"fixture-private-provider-detail"},"RequestId":"request-4"}}`), nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			email := "ses-" + tc.name + "@example.test"
			outcomes <- tc.respond
			id := requestMailChallenge(t, newClient(t, app, base), email, "register")
			receiveSESCode(t, requests, 10001, email, "Spark 注册验证码")
			waitImageTest(t, "SES job finalized without retry", func() bool {
				var done bool
				err := app.Pool.QueryRow(t.Context(), `SELECT state='completed' AND attempt=1
					FROM river_job WHERE kind='spark_send_mail' AND args->>'challenge_id'=$1`, id).Scan(&done)
				return err == nil && done
			})
			waitMailState(t, app, id, tc.state, true)
			duplicate, err := app.Organizer.Queue.Insert(t.Context(), mailJobArgs{ChallengeID: id}, &river.InsertOpts{Queue: mailQueue})
			if err != nil {
				t.Fatal(err)
			}
			waitImageTest(t, "duplicate mail job handled", func() bool {
				job, err := app.Organizer.Queue.JobGet(t.Context(), duplicate.Job.ID)
				return err == nil && job.State == rivertype.JobStateCompleted
			})
			select {
			case <-requests:
				t.Fatal("terminal SES outcome was submitted again")
			default:
			}
		})
	}
}

func TestTencentSESSkipsInactiveAndOtherChannel(t *testing.T) {
	app, base := testBackend(t)
	client := newClient(t, app, base)
	app.Config.MailMode = "smtp"
	queuedSMTP := requestMailChallenge(t, client, "pending-smtp@example.test", "register")
	app.Config.MailMode = "tencent-ses"
	expired := requestMailChallenge(t, client, "expired-ses@example.test", "register")
	inactive := requestMailChallenge(t, client, "inactive-ses@example.test", "register")
	active := requestMailChallenge(t, client, "active-ses@example.test", "register")
	if _, err := app.Pool.Exec(t.Context(), `UPDATE email_challenges SET expires_at=now()-interval '1 second' WHERE id=$1`, expired); err != nil {
		t.Fatal(err)
	}
	// Invalidate one challenge at claim time, so only the final eligibility
	// read can prevent its submission.
	if _, err := app.Pool.Exec(t.Context(), `CREATE FUNCTION consume_test_mail() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN UPDATE email_challenges SET consumed_at=now()
			WHERE id=NEW.challenge_id AND email_normalized='inactive-ses@example.test'; RETURN NEW; END $$;
		CREATE TRIGGER consume_test_mail AFTER UPDATE OF delivery_state ON mail_outbox FOR EACH ROW
		WHEN (NEW.delivery_state='uncertain') EXECUTE FUNCTION consume_test_mail();`); err != nil {
		t.Fatal(err)
	}

	sender, requests := newSESFixture(t, sesAcceptedResponse)
	worker, err := StartMailWorker(context.Background(), app.Pool, app.Config.EncryptionKey, sender)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	receiveSESCode(t, requests, 10001, "active-ses@example.test", "Spark 注册验证码")
	waitMailState(t, app, active, "accepted", true)
	for _, id := range []string{queuedSMTP, expired, inactive} {
		waitMailState(t, app, id, "cancelled", true)
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := worker.Stop(stop); err != nil {
		t.Fatal(err)
	}
	select {
	case <-requests:
		t.Fatal("expired, consumed or SMTP challenge was sent through SES")
	default:
	}

	queuedSES := requestMailChallenge(t, client, "pending-ses@example.test", "register")
	app.Config.MailMode = "smtp"
	const smtpEmail = "active-smtp@example.test"
	activeSMTP := requestMailChallenge(t, client, smtpEmail, "register")
	fixture, smtpSender := newSMTPFixture(t, "implicit", "implicit")
	startSMTPFixtureWorker(t, app, smtpSender)
	smtpFixtureCode(t, fixture.next(t), smtpEmail, "Spark 注册验证码")
	waitMailState(t, app, queuedSES, "cancelled", true)
	waitMailState(t, app, activeSMTP, "accepted", true)
	if fixture.attempts.Load() != 1 {
		t.Fatal("pending SES challenge was sent through SMTP")
	}
}
