package backend

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alexedwards/argon2id"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/store"
)

type signedIn struct {
	ID, Token, CSRF string
	Expires         time.Time
	User            userView
}
type userView struct {
	ID              string `json:"id"`
	Email           string `json:"email"`
	Role            string `json:"role"`
	Status          string `json:"status"`
	AIEnabled       bool   `json:"ai_enabled"`
	AIPolicyVersion int64  `json:"ai_policy_version"`
}

func current(c *gin.Context) *signedIn { return c.MustGet("session").(*signedIn) }
func digest(b string) []byte           { h := sha256.Sum256([]byte(b)); return h[:] }
func (s *Server) mac(parts ...string) []byte {
	h := hmac.New(sha256.New, s.Config.Secret)
	for _, part := range parts {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return h.Sum(nil)
}
func randomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (s *Server) csrfToken(token string) string {
	return base64.RawURLEncoding.EncodeToString(s.mac("csrf", token))
}
func (s *Server) seal(aad string, payload []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.Config.EncryptionKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, payload, []byte(aad)), nil
}
func (s *Server) open(aad string, payload []byte) ([]byte, error) {
	block, err := aes.NewCipher(s.Config.EncryptionKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	n := gcm.NonceSize()
	if len(payload) < n {
		return nil, errors.New("invalid encrypted payload")
	}
	return gcm.Open(nil, payload[:n], payload[n:], []byte(aad))
}
func (s *Server) passwordHash(password string) (string, error) {
	return argon2id.CreateHash(password, argon2id.DefaultParams)
}
func (s *Server) hashSlot(c *gin.Context) error {
	select {
	case s.hashes <- struct{}{}:
		return nil
	case <-c.Request.Context().Done():
		return c.Request.Context().Err()
	default:
		return problem(429, "rate_limited", "密码校验繁忙，请稍后重试。")
	}
}
func emailAddress(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	a, err := mail.ParseAddress(email)
	if err != nil || a.Address != email || len(email) > 254 {
		return "", problem(422, "validation_failed", "请输入有效的邮箱地址。")
	}
	return email, nil
}
func validPassword(p string) bool { n := utf8.RuneCountInString(p); return n >= 12 && n <= 128 }
func (s *Server) origin(c *gin.Context) {
	if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead {
		c.Next()
		return
	}
	if c.GetHeader("Origin") != s.Config.Origin {
		s.fail(c, problem(403, "csrf_failed", "请求来源不受信任。"))
		return
	}
	c.Next()
}
func (s *Server) authenticate(c *gin.Context) {
	token, err := c.Cookie("spark_session")
	if err != nil || len(token) > 128 {
		s.fail(c, problem(401, "session_expired", "请重新登录。"))
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	row, err := store.New(s.Pool).GetSession(ctx, digest(token))
	cancel()
	if errors.Is(err, pgx.ErrNoRows) {
		s.fail(c, problem(401, "session_expired", "请重新登录。"))
		return
	}
	if err != nil {
		s.fail(c, err)
		return
	}
	csrf := s.csrfToken(token)
	if !hmac.Equal(digest(csrf), row.CsrfDigest) {
		s.fail(c, problem(401, "session_expired", "请重新登录。"))
		return
	}
	c.Set("session", &signedIn{ID: row.ID.String(), Token: token, CSRF: csrf, Expires: row.ExpiresAt.Time, User: userView{ID: row.UserID.String(), Email: row.EmailNormalized, Role: row.Role, Status: row.Status, AIEnabled: row.AiEnabled, AIPolicyVersion: row.AiPolicyVersion}})
	c.Next()
}
func (s *Server) csrf(c *gin.Context) {
	if c.Request.Method != "GET" && c.Request.Method != "HEAD" && !hmac.Equal([]byte(c.GetHeader("X-CSRF-Token")), []byte(current(c).CSRF)) {
		s.fail(c, problem(403, "csrf_failed", "页面验证已失效，请刷新后重试。"))
		return
	}
	c.Next()
}
func (s *Server) cookie(c *gin.Context, token string, expires time.Time) {
	maxAge := int(time.Until(expires).Seconds())
	if token == "" {
		maxAge = -1
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: "spark_session", Value: token, Path: "/", Expires: expires, MaxAge: maxAge, HttpOnly: true, Secure: s.Config.Env != "development", SameSite: http.SameSiteLaxMode})
}
func (s *Server) newSession(ctx context.Context, tx pgx.Tx, c *gin.Context, u userView) (*signedIn, error) {
	token := randomToken()
	csrf := s.csrfToken(token)
	sess := &signedIn{ID: uuid.NewString(), Token: token, CSRF: csrf, Expires: time.Now().UTC().Add(7 * 24 * time.Hour), User: u}
	label := []rune(c.GetHeader("User-Agent"))
	if len(label) > 160 {
		label = label[:160]
	}
	if len(label) == 0 {
		label = []rune("Web")
	}
	_, err := tx.Exec(ctx, `INSERT INTO sessions(id,user_id,token_digest,csrf_digest,expires_at,device_label) VALUES($1,$2,$3,$4,$5,$6)`, sess.ID, u.ID, digest(token), digest(csrf), sess.Expires, string(label))
	return sess, err
}
func (s *Server) sessionResult(v *signedIn) any {
	return gin.H{"user": v.User, "csrf_token": v.CSRF, "expires_at": v.Expires, "ai_trial_eligible": s.Organizer.Trial.allows(v.User.ID), "ai_platform_enabled": s.Organizer.Enabled}
}
func (s *Server) rate(ctx context.Context, key string, limit int, window time.Duration) error {
	now := time.Now().UTC().Truncate(window)
	var count int
	err := s.Pool.QueryRow(ctx, `INSERT INTO auth_rate_limits(key,window_start,count) VALUES($1,$2,1)
 ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.window_start=$2 THEN auth_rate_limits.count+1 ELSE 1 END,window_start=$2 RETURNING count`, s.mac("rate", key), now).Scan(&count)
	if err != nil {
		return err
	}
	if count > limit {
		return problem(429, "rate_limited", "请求过于频繁，请稍后重试。")
	}
	return nil
}
func (s *Server) authRate(c *gin.Context, operation, email string) error {
	if err := s.rate(c.Request.Context(), operation+":ip:"+c.ClientIP(), 30, 10*time.Minute); err != nil {
		return err
	}
	return s.rate(c.Request.Context(), operation+":email:"+email, 10, 10*time.Minute)
}
func (s *Server) currentSession(c *gin.Context) (any, error) { return s.sessionResult(current(c)), nil }
func (s *Server) logout(c *gin.Context) (any, error) {
	_, err := s.Pool.Exec(c.Request.Context(), `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id=$2`, current(c).User.ID, current(c).ID)
	if err != nil {
		return nil, err
	}
	s.cookie(c, "", time.Unix(1, 0))
	c.Set("status", 204)
	return nil, nil
}
func (s *Server) listSessions(c *gin.Context) (any, error) {
	rows, err := s.Pool.Query(c.Request.Context(), `SELECT id,device_label,created_at,expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100`, current(c).User.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, label string
		var created, expires time.Time
		if err = rows.Scan(&id, &label, &created, &expires); err != nil {
			return nil, err
		}
		out = append(out, gin.H{"id": id, "device_label": label, "created_at": created, "expires_at": expires, "current": id == current(c).ID})
	}
	return gin.H{"items": out}, rows.Err()
}
func (s *Server) revokeSession(c *gin.Context) (any, error) {
	tag, err := s.Pool.Exec(c.Request.Context(), `UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND id=$2`, current(c).User.ID, c.Param("id"))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, notFound
	}
	if c.Param("id") == current(c).ID {
		s.cookie(c, "", time.Unix(1, 0))
	}
	c.Set("status", 204)
	return nil, nil
}
func (s *Server) BootstrapAdmin(ctx context.Context, email, password string) error {
	email, err := emailAddress(email)
	if err != nil {
		return err
	}
	if !validPassword(password) {
		return errors.New("password must contain 12–128 characters")
	}
	hash, err := s.passwordHash(password)
	if err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	id := uuid.NewString()
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,email_normalized,password_hash,role) VALUES($1,$2,$3,'admin')`, id, email, hash); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_change_counters(user_id) VALUES($1)`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DevelopmentMail decrypts a pending test message only from the explicit local CLI.
// It does not assert delivery through a real mail provider.
func (s *Server) DevelopmentMail(ctx context.Context, id string) (json.RawMessage, error) {
	if s.Config.Env != "development" || s.Config.MailMode != "development" {
		return nil, errors.New("development mailbox is disabled")
	}
	if _, err := uuid.Parse(id); err != nil {
		return nil, errors.New("invalid challenge ID")
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var encrypted []byte
	if err = tx.QueryRow(ctx, `SELECT encrypted_payload FROM mail_outbox WHERE challenge_id=$1 AND expires_at>now() AND encrypted_payload IS NOT NULL FOR UPDATE`, id).Scan(&encrypted); err != nil {
		return nil, err
	}
	payload, err := s.open("mail:"+id, encrypted)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE mail_outbox SET encrypted_payload=NULL,delivered_at=now() WHERE challenge_id=$1`, id); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return payload, nil
}
