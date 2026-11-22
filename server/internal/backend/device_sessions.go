package backend

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

const (
	extensionSessionKind = "extension"
	desktopSessionKind   = "desktop"
	extensionSessionTTL  = 7 * 24 * time.Hour
	desktopSessionTTL    = 30 * 24 * time.Hour
)

var (
	extensionSessionExpired = problem(401, "extension_session_expired", "请重新连接 Spark 浏览器扩展。")
	desktopSessionExpired   = problem(401, "desktop_session_expired", "请重新连接 Spark macOS 桌面端。")
	mixedCredentials        = problem(400, "mixed_credentials", "不能同时使用 Cookie 与 Authorization。")
)

func decodeDeviceSecret(encoded string) ([]byte, bool) {
	if len(encoded) != 43 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return raw, err == nil && len(raw) == 32
}

func (s *Server) bearerSession(c *gin.Context, kind string) (*signedIn, error) {
	expired := extensionSessionExpired
	if kind == desktopSessionKind {
		expired = desktopSessionExpired
	}
	headers := c.Request.Header.Values("Authorization")
	if len(headers) != 1 {
		return nil, expired
	}
	scheme, token, ok := strings.Cut(headers[0], " ")
	if _, valid := decodeDeviceSecret(token); !ok || !strings.EqualFold(scheme, "Bearer") || !valid {
		return nil, expired
	}
	session := &signedIn{Kind: kind}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	err := s.Pool.QueryRow(ctx, `
		SELECT s.id,s.user_id,s.expires_at,u.email_normalized FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.token_digest=$1 AND s.kind=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,
		digest(token), kind).Scan(&session.ID, &session.User.ID, &session.Expires, &session.User.Email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, expired
	}
	return session, err
}

func (s *Server) authenticateExtension(c *gin.Context) {
	session, err := s.bearerSession(c, extensionSessionKind)
	if err != nil {
		s.fail(c, err)
		return
	}
	c.Set("session", session)
	c.Next()
}

// Lock the user before the session, matching password reset. A row share lock
// also serializes the operation with explicit device revocation.
func lockDevicePrincipal(ctx context.Context, tx pgx.Tx, userID, sessionID, kind string) (string, error) {
	var email string
	if err := tx.QueryRow(ctx, `SELECT email_normalized FROM users WHERE id=$1 AND status='active' FOR SHARE`, userID).Scan(&email); err != nil {
		return "", err
	}
	var active bool
	err := tx.QueryRow(ctx, `SELECT true FROM sessions WHERE id=$1 AND user_id=$2 AND kind=$3
		AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`, sessionID, userID, kind).Scan(&active)
	return email, err
}

func (s *Server) approveExtensionGrant(c *gin.Context) (any, error) {
	req, err := bind[contract.ExtensionGrantCreate](s, c)
	if err != nil {
		return nil, err
	}
	return s.approveDeviceGrant(c, extensionSessionKind, string(req.Browser), req.Challenge, req.ExpectedAccountId)
}

func (s *Server) approveDesktopGrant(c *gin.Context) (any, error) {
	req, err := bind[contract.DesktopGrantCreate](s, c)
	if err != nil {
		return nil, err
	}
	return s.approveDeviceGrant(c, desktopSessionKind, "macos", req.Challenge, req.ExpectedAccountId)
}

func (s *Server) approveDeviceGrant(c *gin.Context, kind, device, encoded string, expected uuid.UUID) (any, error) {
	session := current(c)
	if expected.String() != session.User.ID {
		return nil, problem(409, kind+"_account_changed", "当前登录账号已变更，请重新发起连接。")
	}
	challenge, ok := decodeDeviceSecret(encoded)
	if !ok {
		return nil, problem(422, "validation_failed", "配对摘要格式无效。")
	}
	ctx := c.Request.Context()
	if err := s.rate(ctx, kind+":approve:"+session.User.ID, 20, time.Minute); err != nil {
		return nil, err
	}
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := lockDevicePrincipal(ctx, tx, session.User.ID, session.ID, "web"); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return problem(401, "session_expired", "请重新登录。")
			}
			return err
		}
		// Keep expired approvals briefly so late callers get the expired result.
		if _, err := tx.Exec(ctx, `DELETE FROM device_grants WHERE (kind,challenge) IN (
			SELECT kind,challenge FROM device_grants WHERE expires_at<now()-interval '1 day'
			ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED)`); err != nil {
			return err
		}
		inserted, err := tx.Exec(ctx, `INSERT INTO device_grants(kind,challenge,user_id,web_session_id,device,expires_at)
			VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes') ON CONFLICT(kind,challenge) DO NOTHING`,
			kind, challenge, session.User.ID, session.ID, device)
		if err != nil || inserted.RowsAffected() > 0 {
			return err
		}
		var sameApproval bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM device_grants
			WHERE kind=$1 AND challenge=$2 AND user_id=$3 AND web_session_id=$4 AND device=$5
			  AND consumed_at IS NULL AND expires_at>clock_timestamp())`,
			kind, challenge, session.User.ID, session.ID, device).Scan(&sameApproval); err != nil {
			return err
		}
		if !sameApproval {
			return problem(409, kind+"_grant_conflict", "该配对已失效，请重新发起连接。")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}

func (s *Server) exchangeExtensionGrant(c *gin.Context) (any, error) {
	return s.exchangeDeviceGrant(c, extensionSessionKind)
}

func (s *Server) exchangeDesktopGrant(c *gin.Context) (any, error) {
	authorization, cookie := hasRequestHeader(c, "Authorization"), hasRequestHeader(c, "Cookie")
	if authorization && cookie {
		return nil, mixedCredentials
	}
	if authorization || cookie {
		return nil, problem(400, "unexpected_credentials", "兑换只接受一次性证明。")
	}
	return s.exchangeDeviceGrant(c, desktopSessionKind)
}

func (s *Server) exchangeDeviceGrant(c *gin.Context, kind string) (any, error) {
	ctx := c.Request.Context()
	if err := s.rate(ctx, kind+":exchange:"+c.ClientIP(), 60, time.Minute); err != nil {
		return nil, err
	}
	req, err := bind[struct {
		Verifier string `json:"verifier"`
	}](s, c)
	if err != nil {
		return nil, err
	}
	if _, ok := decodeDeviceSecret(req.Verifier); !ok {
		return nil, problem(422, "validation_failed", "兑换证明格式无效。")
	}
	proof := req.Verifier
	ttl := extensionSessionTTL
	if kind == desktopSessionKind {
		proof = "spark-desktop-pair-v1:" + proof
		ttl = desktopSessionTTL
	}
	challenge := digest(proof)
	invalid := problem(401, kind+"_grant_invalid", "配对已失效，请重新发起连接。")

	session := &signedIn{Kind: kind}
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var sessionID string
		err := tx.QueryRow(ctx, `SELECT user_id,web_session_id FROM device_grants WHERE kind=$1 AND challenge=$2`,
			kind, challenge).Scan(&session.User.ID, &sessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return problem(404, kind+"_grant_pending", "尚未收到网页确认。")
		}
		if err != nil {
			return err
		}
		uid := session.User.ID
		session.User.Email, err = lockDevicePrincipal(ctx, tx, uid, sessionID, "web")
		if errors.Is(err, pgx.ErrNoRows) {
			return invalid
		}
		if err != nil {
			return err
		}
		var device string
		err = tx.QueryRow(ctx, `UPDATE device_grants SET consumed_at=clock_timestamp()
			WHERE kind=$1 AND challenge=$2 AND user_id=$3 AND web_session_id=$4
			  AND consumed_at IS NULL AND expires_at>clock_timestamp()
			RETURNING device`, kind, challenge, uid, sessionID).Scan(&device)
		if errors.Is(err, pgx.ErrNoRows) {
			return invalid
		}
		if err != nil {
			return err
		}
		label := "Spark 浏览器扩展 (Chrome)"
		switch device {
		case "edge":
			label = "Spark 浏览器扩展 (Edge)"
		case "macos":
			label = "Spark macOS 桌面端"
		}
		session.Token = randomToken()
		session.Expires = time.Now().UTC().Truncate(time.Microsecond).Add(ttl)
		_, err = tx.Exec(ctx, `INSERT INTO sessions(id,user_id,token_digest,expires_at,device_label,kind)
			VALUES($1,$2,$3,$4,$5,$6)`, uuid.New(), uid, digest(session.Token), session.Expires, label, kind)
		return err
	})
	if err != nil {
		return nil, err
	}
	result := deviceSessionResponse(session)
	result["token"] = session.Token
	return result, nil
}

func deviceSessionResponse(session *signedIn) gin.H {
	return gin.H{"account_id": session.User.ID, "account_label": session.User.Email, "expires_at": session.Expires}
}

func (s *Server) getDeviceSession(c *gin.Context) (any, error) {
	return deviceSessionResponse(current(c)), nil
}

func (s *Server) revokeDeviceSession(c *gin.Context) (any, error) {
	session := current(c)
	_, err := s.Pool.Exec(c.Request.Context(), `UPDATE sessions SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND kind=$3 AND revoked_at IS NULL`, session.ID, session.User.ID, session.Kind)
	if err != nil {
		return nil, err
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}
