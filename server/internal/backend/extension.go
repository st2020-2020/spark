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
	extensionSessionTTL  = 7 * 24 * time.Hour
)

var (
	extensionSessionExpired = problem(401, "extension_session_expired", "请重新连接 Spark 浏览器扩展。")
	extensionGrantInvalid   = problem(401, "extension_grant_invalid", "配对已失效，请重新发起连接。")
)

func decodeExtensionSecret(encoded string) ([]byte, bool) {
	if len(encoded) != 43 {
		return nil, false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return raw, err == nil && len(raw) == 32
}

func (s *Server) authenticateExtension(c *gin.Context) {
	headers := c.Request.Header.Values("Authorization")
	if len(headers) != 1 {
		s.fail(c, extensionSessionExpired)
		return
	}
	scheme, token, ok := strings.Cut(headers[0], " ")
	if _, valid := decodeExtensionSecret(token); !ok || !strings.EqualFold(scheme, "Bearer") || !valid {
		s.fail(c, extensionSessionExpired)
		return
	}
	session := &signedIn{}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	err := s.Pool.QueryRow(ctx, `
		SELECT s.id,s.user_id,s.expires_at,u.email_normalized FROM sessions s JOIN users u ON u.id=s.user_id
		WHERE s.token_digest=$1 AND s.kind='extension' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,
		digest(token)).Scan(&session.ID, &session.User.ID, &session.Expires, &session.User.Email)
	cancel()
	if errors.Is(err, pgx.ErrNoRows) {
		err = extensionSessionExpired
	}
	if err != nil {
		s.fail(c, err)
		return
	}
	c.Set("session", session)
	c.Next()
}

// Lock the user before the session, matching password reset. A row share lock
// also serializes the operation with explicit device revocation.
func lockExtensionPrincipal(ctx context.Context, tx pgx.Tx, userID, sessionID, kind string) (string, error) {
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
	session := current(c)
	if req.ExpectedAccountId.String() != session.User.ID {
		return nil, problem(409, "extension_account_changed", "当前登录账号已变更，请重新发起连接。")
	}
	challenge, ok := decodeExtensionSecret(req.Challenge)
	if !ok {
		return nil, problem(422, "validation_failed", "配对摘要格式无效。")
	}
	ctx := c.Request.Context()
	if err := s.rate(ctx, "extension:approve:"+session.User.ID, 20, time.Minute); err != nil {
		return nil, err
	}
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := lockExtensionPrincipal(ctx, tx, session.User.ID, session.ID, "web"); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return problem(401, "session_expired", "请重新登录。")
			}
			return err
		}
		// Keep expired approvals briefly so late callers get the expired result.
		if _, err := tx.Exec(ctx, `DELETE FROM extension_grants WHERE challenge IN (
			SELECT challenge FROM extension_grants WHERE expires_at<now()-interval '1 day'
			ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED)`); err != nil {
			return err
		}
		inserted, err := tx.Exec(ctx, `INSERT INTO extension_grants(challenge,user_id,web_session_id,browser,expires_at)
			VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') ON CONFLICT(challenge) DO NOTHING`,
			challenge, session.User.ID, session.ID, req.Browser)
		if err != nil || inserted.RowsAffected() > 0 {
			return err
		}
		var sameApproval bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM extension_grants
			WHERE challenge=$1 AND user_id=$2 AND web_session_id=$3 AND browser=$4
			  AND consumed_at IS NULL AND expires_at>clock_timestamp())`,
			challenge, session.User.ID, session.ID, req.Browser).Scan(&sameApproval); err != nil {
			return err
		}
		if !sameApproval {
			return problem(409, "extension_grant_conflict", "该配对已失效，请重新发起连接。")
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
	ctx := c.Request.Context()
	if err := s.rate(ctx, "extension:exchange:"+c.ClientIP(), 60, time.Minute); err != nil {
		return nil, err
	}
	req, err := bind[contract.ExtensionTokenExchange](s, c)
	if err != nil {
		return nil, err
	}
	if _, ok := decodeExtensionSecret(req.Verifier); !ok {
		return nil, problem(422, "validation_failed", "兑换证明格式无效。")
	}
	challenge := digest(req.Verifier)
	var result contract.ExtensionTokenResult
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var sessionID string
		err := tx.QueryRow(ctx, `SELECT user_id,web_session_id FROM extension_grants WHERE challenge=$1`, challenge).
			Scan(&result.AccountId, &sessionID)
		if errors.Is(err, pgx.ErrNoRows) {
			return problem(404, "extension_grant_pending", "尚未收到网页确认。")
		}
		if err != nil {
			return err
		}
		uid := result.AccountId.String()
		result.AccountLabel, err = lockExtensionPrincipal(ctx, tx, uid, sessionID, "web")
		if errors.Is(err, pgx.ErrNoRows) {
			return extensionGrantInvalid
		}
		if err != nil {
			return err
		}
		var browser string
		err = tx.QueryRow(ctx, `UPDATE extension_grants SET consumed_at=clock_timestamp()
			WHERE challenge=$1 AND user_id=$2 AND web_session_id=$3 AND consumed_at IS NULL AND expires_at>clock_timestamp()
			RETURNING browser`, challenge, uid, sessionID).Scan(&browser)
		if errors.Is(err, pgx.ErrNoRows) {
			return extensionGrantInvalid
		}
		if err != nil {
			return err
		}
		label := "Spark 浏览器扩展 (Chrome)"
		if browser == "edge" {
			label = "Spark 浏览器扩展 (Edge)"
		}
		result.Token = randomToken()
		result.ExpiresAt = time.Now().UTC().Add(extensionSessionTTL)
		_, err = tx.Exec(ctx, `INSERT INTO sessions(id,user_id,token_digest,expires_at,device_label,kind)
			VALUES($1,$2,$3,$4,$5,'extension')`, uuid.New(), uid, digest(result.Token), result.ExpiresAt, label)
		return err
	})
	return result, err
}

func (s *Server) getExtensionSession(c *gin.Context) (any, error) {
	session := current(c)
	return contract.ExtensionSession{
		AccountId: uuid.MustParse(session.User.ID), AccountLabel: session.User.Email, ExpiresAt: session.Expires,
	}, nil
}

func (s *Server) revokeExtensionSession(c *gin.Context) (any, error) {
	session := current(c)
	_, err := s.Pool.Exec(c.Request.Context(), `UPDATE sessions SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND kind='extension' AND revoked_at IS NULL`, session.ID, session.User.ID)
	if err != nil {
		return nil, err
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}
