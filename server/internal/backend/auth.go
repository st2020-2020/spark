package backend

import (
	"crypto/hmac"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

func (s *Server) verification(c *gin.Context) (any, error) {
	req, err := bind[contract.VerificationRequest](s, c)
	if err != nil {
		return nil, err
	}
	email, err := emailAddress(string(req.Email))
	if err != nil {
		return nil, err
	}
	if err = s.authRate(c, "verification", email); err != nil {
		return nil, err
	}
	externalMail := isMailDeliveryMode(s.Config.MailMode)
	if !externalMail && s.Config.MailMode != "development" {
		return nil, problem(503, "service_unavailable", "邮件服务尚未配置，无法发送验证码。")
	}
	ctx := c.Request.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize challenge issuance across API instances, including an email with no previous rows.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,7))`, email+":"+string(req.Purpose)); err != nil {
		return nil, err
	}
	var recent bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM email_challenges WHERE email_normalized=$1 AND purpose=$2 AND created_at>now()-interval '60 seconds')`, email, string(req.Purpose)).Scan(&recent); err != nil {
		return nil, err
	}
	if recent {
		return nil, problem(429, "rate_limited", "请稍后再申请验证码。")
	}
	if externalMail {
		if err := s.reserveMailChallenge(c, tx); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE email_challenges SET consumed_at=now() WHERE email_normalized=$1 AND purpose=$2 AND consumed_at IS NULL`, email, string(req.Purpose)); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE mail_outbox SET encrypted_payload=NULL,
		delivery_state=CASE WHEN delivery_state='queued' THEN 'cancelled' ELSE delivery_state END
		WHERE challenge_id IN (SELECT id FROM email_challenges WHERE email_normalized=$1 AND purpose=$2)
		  AND encrypted_payload IS NOT NULL`, email, string(req.Purpose)); err != nil {
		return nil, err
	}
	id := uuid.NewString()
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return nil, err
	}
	code := fmt.Sprintf("%06d", n.Int64())
	expires := time.Now().UTC().Add(10 * time.Minute)
	message := challengeMail{
		Adapter: "development-only", ChallengeID: id, Email: email, Purpose: string(req.Purpose),
		Code: code, ExpiresAt: expires,
	}
	state := "development"
	if externalMail {
		message.Adapter, state = s.Config.MailMode, "queued"
	}
	encrypted, err := s.seal("mail:"+id, jsonBytes(message))
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO email_challenges(id,email_normalized,purpose,code_digest,expires_at) VALUES($1,$2,$3,$4,$5)`, id, email, string(req.Purpose), s.mac("verification", id, code), expires); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO mail_outbox(challenge_id,encrypted_payload,expires_at,delivery_state) VALUES($1,$2,$3,$4)`, id, encrypted, expires, state); err != nil {
		return nil, err
	}
	if externalMail {
		if err := enqueueMail(ctx, tx, s.Organizer.Queue, id); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if !externalMail {
		c.Header("X-Spark-Mail-Adapter", "development")
	}
	c.Set("status", 202)
	return contract.VerificationResult{ChallengeId: uuid.MustParse(id), ExpiresIn: 600, ResendAfter: 60}, nil
}

// verifyChallenge locks the challenge. The caller commits failed attempts so the
// attempt limit cannot be bypassed by transaction rollback.
func (s *Server) verifyChallenge(c *gin.Context, tx pgx.Tx, id, email, purpose, code string) (bool, error) {
	var expected []byte
	var expires time.Time
	var consumed *time.Time
	var attempts int
	var storedEmail, storedPurpose string
	err := tx.QueryRow(c.Request.Context(), `SELECT email_normalized,purpose,code_digest,expires_at,attempts,consumed_at FROM email_challenges WHERE id=$1 FOR UPDATE`, id).Scan(&storedEmail, &storedPurpose, &expected, &expires, &attempts, &consumed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if storedEmail != email || storedPurpose != purpose || consumed != nil || !expires.After(time.Now()) || attempts >= 5 {
		return false, nil
	}
	if !hmac.Equal(expected, s.mac("verification", id, code)) {
		_, err = tx.Exec(c.Request.Context(), `UPDATE email_challenges SET attempts=attempts+1 WHERE id=$1`, id)
		return false, err
	}
	return true, nil
}
func (s *Server) register(c *gin.Context) (any, error) {
	req, err := bind[contract.RegisterRequest](s, c)
	if err != nil {
		return nil, err
	}
	email, err := emailAddress(string(req.Email))
	if err != nil {
		return nil, err
	}
	if err = s.authRate(c, "register", email); err != nil {
		return nil, err
	}
	if err = s.hashSlot(c); err != nil {
		return nil, err
	}
	defer func() { <-s.hashes }()
	hash, err := s.passwordHash(req.Password)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	valid, err := s.verifyChallenge(c, tx, req.ChallengeId.String(), email, "register", req.VerificationCode)
	if err != nil {
		return nil, err
	}
	if !valid {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, problem(422, "registration_failed", "无法完成注册，请检查验证信息。")
	}
	// Lock order is challenge, batch, code; disabling follows batch then code.
	var batchID, inviteID string
	err = tx.QueryRow(ctx, `SELECT id,batch_id FROM invite_codes WHERE code_digest=$1`, s.mac("invite", strings.TrimSpace(req.InviteCode))).Scan(&inviteID, &batchID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem(409, "invite_unavailable", "邀请码不可用。")
	}
	if err != nil {
		return nil, err
	}
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM invite_batches WHERE id=$1 FOR UPDATE`, batchID).Scan(&status); err != nil {
		return nil, err
	}
	var available bool
	if err = tx.QueryRow(ctx, `SELECT disabled_at IS NULL AND (expires_at IS NULL OR expires_at>now()) AND used_count<max_uses FROM invite_codes WHERE id=$1 FOR UPDATE`, inviteID).Scan(&available); err != nil {
		return nil, err
	}
	if status != "active" || !available {
		return nil, problem(409, "invite_unavailable", "邀请码不可用。")
	}
	u := userView{ID: uuid.NewString(), Email: email, Role: "user", Status: "active", AIPolicyVersion: 1, Palette: "mint", Theme: "system"}
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,email_normalized,password_hash) VALUES($1,$2,$3)`, u.ID, email, hash); err != nil {
		var pe *pgconn.PgError
		if errors.As(err, &pe) && pe.Code == "23505" {
			return nil, problem(422, "registration_failed", "无法完成注册，请检查验证信息。")
		}
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_change_counters(user_id) VALUES($1)`, u.ID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO invite_redemptions(id,invite_id,user_id) VALUES($1,$2,$3)`, uuid.NewString(), inviteID, u.ID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE invite_codes SET used_count=used_count+1 WHERE id=$1`, inviteID); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE email_challenges SET consumed_at=now() WHERE id=$1`, req.ChallengeId.String()); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE mail_outbox SET encrypted_payload=NULL,
		delivery_state=CASE WHEN delivery_state='queued' THEN 'cancelled' ELSE delivery_state END WHERE challenge_id=$1`, req.ChallengeId.String()); err != nil {
		return nil, err
	}
	sess, err := s.newSession(ctx, tx, c, u)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.cookie(c, sess.Token, sess.Expires)
	c.Set("status", 201)
	return s.sessionResult(sess), nil
}
func (s *Server) login(c *gin.Context) (any, error) {
	sess, err := s.loginWithPassword(c, "web")
	if err != nil {
		return nil, err
	}
	s.cookie(c, sess.Token, sess.Expires)
	return s.sessionResult(sess), nil
}

func (s *Server) loginWithPassword(c *gin.Context, kind string) (*signedIn, error) {
	req, err := bind[contract.LoginRequest](s, c)
	if err != nil {
		return nil, err
	}
	email, err := emailAddress(string(req.Email))
	if err != nil {
		return nil, err
	}
	if err = s.authRate(c, "login", email); err != nil {
		return nil, err
	}
	if err = s.hashSlot(c); err != nil {
		return nil, err
	}
	defer func() { <-s.hashes }()
	ctx := c.Request.Context()
	user, err := store.New(s.Pool).GetUserByEmail(ctx, email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	hash := s.dummyHash
	if err == nil {
		hash = user.PasswordHash
	}
	ok, err := argon2id.ComparePasswordAndHash(req.Password, hash)
	if err != nil {
		return nil, err
	}
	if !ok || !user.ID.Valid || user.Status != "active" {
		return nil, problem(401, "authentication_failed", "邮箱或密码不正确。")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Serialize with password reset; an old password cannot issue a new session after reset.
	var currentHash, status string
	if err = tx.QueryRow(ctx, `SELECT password_hash,status FROM users WHERE id=$1 FOR UPDATE`, user.ID.String()).Scan(&currentHash, &status); err != nil {
		return nil, err
	}
	if currentHash != hash || status != "active" {
		return nil, problem(401, "authentication_failed", "邮箱或密码不正确。")
	}
	u := userView{ID: user.ID.String(), Email: email, Role: user.Role, Status: user.Status, AIEnabled: user.AiEnabled, AIConsentVersion: user.AiConsentVersion.String, AIPolicyVersion: user.AiPolicyVersion, Palette: user.Palette, Theme: user.Theme}
	var sess *signedIn
	if kind == desktopSessionKind {
		sess, err = newDeviceSession(ctx, tx, u, kind, desktopDeviceLabel, desktopSessionTTL)
	} else {
		sess, err = s.newSession(ctx, tx, c, u)
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sess, nil
}
func (s *Server) resetPassword(c *gin.Context) (any, error) {
	req, err := bind[contract.PasswordReset](s, c)
	if err != nil {
		return nil, err
	}
	email, err := emailAddress(string(req.Email))
	if err != nil {
		return nil, err
	}
	if err = s.authRate(c, "reset", email); err != nil {
		return nil, err
	}
	if err = s.hashSlot(c); err != nil {
		return nil, err
	}
	defer func() { <-s.hashes }()
	hash, err := s.passwordHash(req.NewPassword)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	valid, err := s.verifyChallenge(c, tx, req.ChallengeId.String(), email, "password_reset", req.VerificationCode)
	if err != nil {
		return nil, err
	}
	failure := problem(422, "validation_failed", "无法重置密码，请检查验证信息。")
	if !valid {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, failure
	}
	var id string
	err = tx.QueryRow(ctx, `UPDATE users SET password_hash=$2,updated_at=now() WHERE email_normalized=$1 AND status='active' RETURNING id`, email, hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, failure
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, id); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE email_challenges SET consumed_at=now() WHERE id=$1`, req.ChallengeId.String()); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE mail_outbox SET encrypted_payload=NULL,
		delivery_state=CASE WHEN delivery_state='queued' THEN 'cancelled' ELSE delivery_state END WHERE challenge_id=$1`, req.ChallengeId.String()); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.cookie(c, "", time.Unix(1, 0))
	c.Set("status", 204)
	return nil, nil
}
