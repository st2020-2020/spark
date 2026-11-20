package backend

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

func startSMTPFixtureWorker(t *testing.T, app *Server, sender *SMTPDelivery) *river.Client[pgx.Tx] {
	t.Helper()
	worker, err := StartMailWorker(context.Background(), app.Pool, app.Config.EncryptionKey, sender)
	if err != nil {
		t.Fatal(err)
	}
	stopImageTestWorker(t, worker)
	return worker
}

func requestSMTPChallenge(t *testing.T, client *apiClient, email, purpose string) string {
	t.Helper()
	resp := client.do("POST", "/auth/verification", map[string]any{"email": email, "purpose": purpose}, "")
	body := resp.want(t, 202)
	if body["expires_in"] != float64(600) || body["resend_after"] != float64(60) ||
		body["verification_code"] != nil || resp.header.Get("X-Spark-Mail-Adapter") != "" {
		t.Fatal("SMTP changed the verification API contract")
	}
	return body["challenge_id"].(string)
}

func waitSMTPState(t *testing.T, app *Server, id, expected string, cipherCleared bool) {
	t.Helper()
	waitImageTest(t, "mail state "+expected, func() bool {
		var state string
		var noCipher, hasDeliveredAt bool
		err := app.Pool.QueryRow(t.Context(), `SELECT delivery_state,encrypted_payload IS NULL,delivered_at IS NOT NULL
			FROM mail_outbox WHERE challenge_id=$1`, id).Scan(&state, &noCipher, &hasDeliveredAt)
		return err == nil && state == expected && noCipher == cipherCleared && hasDeliveredAt == (state == "accepted")
	})
}

func TestSMTPVerificationRegistersAndResetRevokesSessions(t *testing.T) {
	app, base := testBackend(t)
	admin := imageTestAccount(t, app, base, "smtp-admin")
	const invite = "INVITE-SMTP-0001"
	admin.invite(invite)
	const email = "smtp-registration@example.test"
	app.Config.MailMode = "smtp"
	client := newClient(t, app, base)
	registration := requestSMTPChallenge(t, client, email, "register")
	client.do("POST", "/auth/verification", map[string]any{"email": email, "purpose": "register"}, "").want(t, 429)
	if _, err := app.DevelopmentMail(t.Context(), registration); err == nil {
		t.Fatal("development CLI exposed a real SMTP challenge")
	}
	var args []byte
	var queuedState string
	if err := app.Pool.QueryRow(t.Context(), `SELECT j.args,o.delivery_state FROM river_job j,mail_outbox o
		WHERE j.kind='spark_send_mail' AND (j.args->>'challenge_id')::uuid=o.challenge_id AND o.challenge_id=$1`, registration).
		Scan(&args, &queuedState); err != nil {
		t.Fatal(err)
	}
	var reference map[string]any
	if err := json.Unmarshal(args, &reference); err != nil || len(reference) != 1 || reference["challenge_id"] != registration || queuedState != "queued" {
		t.Fatal("mail queue must only contain a challenge reference")
	}

	fixture, sender := newSMTPFixture(t, "starttls", "starttls")
	startSMTPFixtureWorker(t, app, sender)
	code := smtpFixtureCode(t, fixture.next(t), email, "Spark 注册验证码")
	waitSMTPState(t, app, registration, "accepted", true)
	reg := client.do("POST", "/auth/register", map[string]any{
		"email": email, "password": "test-password-12345", "invite_code": invite,
		"challenge_id": registration, "verification_code": code,
	}, "").want(t, 201)
	client.csrf = reg["csrf_token"].(string)
	second := newClient(t, app, base)
	second.signIn(email)

	reset := requestSMTPChallenge(t, client, email, "password_reset")
	resetCode := smtpFixtureCode(t, fixture.next(t), email, "Spark 密码重置验证码")
	waitSMTPState(t, app, reset, "accepted", true)
	client.do("POST", "/auth/password-reset", map[string]any{
		"email": email, "challenge_id": reset, "verification_code": resetCode, "new_password": "updated-test-password-12345",
	}, "").want(t, 204)
	for _, old := range []*apiClient{client, second} {
		old.do("GET", "/auth/session", nil, "").want(t, 401)
	}
	client.do("POST", "/auth/login", map[string]any{"email": email, "password": "updated-test-password-12345"}, "").want(t, 200)
	if fixture.attempts.Load() != 2 || fixture.auth.Load() != 2 {
		t.Fatal("register and reset did not each send once over authenticated TLS")
	}
}

func TestSMTPRetriesOnlyDefiniteRejection(t *testing.T) {
	app, base := testBackend(t)
	app.Config.MailMode = "smtp"
	client := newClient(t, app, base)
	fixture, sender := newSMTPFixture(t, "implicit", "implicit", "451 fixture-sensitive-reply", "250 accepted", "", "550 not accepted")
	startSMTPFixtureWorker(t, app, sender)
	const email = "smtp-retry@example.test"
	id := requestSMTPChallenge(t, client, email, "register")
	first := smtpFixtureCode(t, fixture.next(t), email, "Spark 注册验证码")
	waitSMTPState(t, app, id, "queued", false)
	waitImageTest(t, "scheduled retry", func() bool {
		var ok bool
		err := app.Pool.QueryRow(t.Context(), `SELECT state='retryable' AND scheduled_at>now()
			AND errors::text LIKE '%smtp_message_rejected%' AND errors::text NOT LIKE '%fixture-sensitive-reply%'
			FROM river_job WHERE kind='spark_send_mail' AND args->>'challenge_id'=$1`, id).Scan(&ok)
		return err == nil && ok
	})
	if _, err := app.Pool.Exec(t.Context(), `UPDATE river_job SET state='available',scheduled_at=now()
		WHERE kind='spark_send_mail' AND args->>'challenge_id'=$1 AND state='retryable'`, id); err != nil {
		t.Fatal(err)
	}
	if second := smtpFixtureCode(t, fixture.next(t), email, "Spark 注册验证码"); second != first {
		t.Fatal("SMTP retry rotated the already-issued challenge code")
	}
	waitSMTPState(t, app, id, "accepted", true)

	unknown := requestSMTPChallenge(t, client, "smtp-unknown@example.test", "register")
	fixture.next(t) // SMTP accepted DATA, then the connection disappeared before the reply.
	waitSMTPState(t, app, unknown, "uncertain", true)
	duplicate, err := app.Organizer.Queue.Insert(t.Context(), mailJobArgs{ChallengeID: unknown},
		&river.InsertOpts{Queue: mailQueue})
	if err != nil {
		t.Fatal(err)
	}
	waitImageTest(t, "duplicate mail job handled", func() bool {
		job, err := app.Organizer.Queue.JobGet(t.Context(), duplicate.Job.ID)
		return err == nil && job.State == rivertype.JobStateCompleted
	})
	if fixture.attempts.Load() != 3 {
		t.Fatal("unknown SMTP acceptance caused an extra delivery")
	}

	rejected := requestSMTPChallenge(t, client, "smtp-permanent@example.test", "register")
	fixture.next(t)
	waitSMTPState(t, app, rejected, "failed", true)
}

func TestSMTPSkipsExpiredSupersededAndRestoredMail(t *testing.T) {
	app, base := testBackend(t)
	admin := imageTestAccount(t, app, base, "smtp-recovery-admin")
	const invite = "INVITE-SMTP-RESTORE"
	admin.invite(invite)
	app.Config.MailMode = "smtp"
	client := newClient(t, app, base)
	const email = "smtp-superseded@example.test"
	superseded := requestSMTPChallenge(t, client, email, "register")
	if _, err := app.Pool.Exec(t.Context(), `UPDATE email_challenges SET created_at=now()-interval '61 seconds' WHERE id=$1`, superseded); err != nil {
		t.Fatal(err)
	}
	active := requestSMTPChallenge(t, client, email, "register")
	expired := requestSMTPChallenge(t, client, "smtp-expired@example.test", "register")
	if _, err := app.Pool.Exec(t.Context(), `UPDATE email_challenges SET expires_at=now()-interval '1 second' WHERE id=$1`, expired); err != nil {
		t.Fatal(err)
	}
	fixture, sender := newSMTPFixture(t, "implicit", "implicit")
	worker := startSMTPFixtureWorker(t, app, sender)
	code := smtpFixtureCode(t, fixture.next(t), email, "Spark 注册验证码")
	waitSMTPState(t, app, active, "accepted", true)
	waitSMTPState(t, app, superseded, "cancelled", true)
	waitSMTPState(t, app, expired, "cancelled", true)
	if fixture.attempts.Load() != 1 {
		t.Fatal("obsolete challenge was dispatched")
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := worker.Stop(stop); err != nil {
		t.Fatal(err)
	}
	if challenges, _, err := InvalidateRestoredMail(t.Context(), app.Pool); err != nil || challenges != 2 {
		t.Fatalf("unexpected restore invalidation result: %d, %v", challenges, err)
	}
	// Even an accepted registration code cannot be used after its database is restored.
	client.do("POST", "/auth/register", map[string]any{
		"email": email, "password": "test-password-12345", "invite_code": invite,
		"challenge_id": active, "verification_code": code,
	}, "").want(t, 422)
}

func TestSMTPOutboxAndQueueRollbackAndGlobalLimits(t *testing.T) {
	app, base := testBackend(t)
	client := newClient(t, app, base)
	app.Config.MailMode = "disabled"
	payload := map[string]any{"email": "smtp-atomic@example.test", "purpose": "register"}
	client.do("POST", "/auth/verification", payload, "").want(t, 503)
	app.Config.MailMode = "smtp"
	ctx := t.Context()
	if _, err := app.Pool.Exec(ctx, `CREATE FUNCTION block_test_mail() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.kind='spark_send_mail' THEN RAISE EXCEPTION 'controlled queue failure'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER block_test_mail BEFORE INSERT ON river_job FOR EACH ROW EXECUTE FUNCTION block_test_mail();`); err != nil {
		t.Fatal(err)
	}
	client.do("POST", "/auth/verification", payload, "").want(t, 503)
	if _, err := app.Pool.Exec(ctx, `DROP TRIGGER block_test_mail ON river_job`); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := app.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM mail_outbox)+(SELECT count(*) FROM email_challenges)
		 +(SELECT count(*) FROM auth_rate_limits WHERE key IN ($1,$2))`,
		digest("mail:daily"), digest("mail:burst")).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("failed queue insertion left SMTP data or capacity reserved: %d, %v", rows, err)
	}

	id := requestSMTPChallenge(t, client, payload["email"].(string), "register")
	if _, err := app.Pool.Exec(ctx, `UPDATE auth_rate_limits SET count=$2 WHERE key=$1`, digest("mail:burst"), mailBurstLimit); err != nil {
		t.Fatal(err)
	}
	limited := client.do("POST", "/auth/verification", map[string]any{"email": "smtp-limited@example.test", "purpose": "register"}, "")
	limited.want(t, 429)
	if limited.header.Get("Retry-After") == "" {
		t.Fatal("SMTP platform throttling omitted retry time")
	}
	if _, err := app.Pool.Exec(ctx, `UPDATE auth_rate_limits SET count=CASE WHEN key=$1 THEN $3::int ELSE 0 END
		WHERE key IN ($1,$2)`, digest("mail:daily"), digest("mail:burst"), mailDailyLimit); err != nil {
		t.Fatal(err)
	}
	client.do("POST", "/auth/verification", map[string]any{"email": "smtp-daily@example.test", "purpose": "register"}, "").want(t, 429)
	changed, cancelled, err := InvalidateRestoredMail(ctx, app.Pool)
	if err != nil || changed != 1 || cancelled != 1 {
		t.Fatalf("offline restore did not invalidate the queue: %d, %d, %v", changed, cancelled, err)
	}
	waitSMTPState(t, app, id, "cancelled", true)
	if again, duplicate, err := InvalidateRestoredMail(ctx, app.Pool); err != nil || again != 0 || duplicate != 0 {
		t.Fatalf("restore invalidation was not repeatable: %d, %d, %v", again, duplicate, err)
	}
}

func TestSMTPRejectsUnverifiedTLSBeforeAuthenticating(t *testing.T) {
	for _, tc := range []struct{ name, clientMode, serverMode, failure string }{
		{"unknown trust", "implicit", "implicit", "smtp_tls_failed"},
		{"wrong hostname", "starttls", "starttls", "smtp_tls_failed"},
		{"no STARTTLS", "starttls", "plaintext", "smtp_starttls_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture, sender := newSMTPFixture(t, tc.clientMode, tc.serverMode)
			switch tc.name {
			case "unknown trust":
				sender.tls.RootCAs = x509.NewCertPool()
			case "wrong hostname":
				sender.tls.ServerName = "other.example.test"
			}
			got := sender.send(t.Context(), "tls-test@example.test", []byte("synthetic"),
				func(context.Context) (bool, error) { return true, nil })
			if got.state != "failed" || got.reason != tc.failure ||
				fixture.auth.Load() != 0 || fixture.attempts.Load() != 0 || strings.Contains(got.reason, "fixture-password") {
				t.Fatalf("SMTP did not fail closed before sending: %v", got)
			}
		})
	}
}
