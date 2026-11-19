package backend

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/store"
)

// A successful no-op can return a full response now and store only a marker.
// The replay callback must read and authorize the current resource.
type idempotentCurrentResponse struct{ body any }

const idempotentCurrentMarker = "null"

func (s *Server) idempotent(c *gin.Context, request any, status int, work func(pgx.Tx) (any, error)) (any, error) {
	return s.idempotentWithReplay(c, request, status, work, nil)
}

func (s *Server) idempotentWithReplay(c *gin.Context, request any, status int, work func(pgx.Tx) (any, error), replay func(pgx.Tx, json.RawMessage) (any, error)) (any, error) {
	key := c.GetHeader("Idempotency-Key")
	if n := utf8.RuneCountInString(key); n < 16 || n > 128 {
		return nil, problem(400, "invalid_request", "需要 16 至 128 字符的 Idempotency-Key。")
	}
	op := c.Request.Method + " " + c.Request.URL.Path
	uid := current(c).User.ID
	ctx := c.Request.Context()
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,11))`, uid+":"+op+":"+key).Scan(&locked); err != nil {
		return nil, err
	}
	if !locked {
		return nil, problem(409, "operation_in_progress", "相同请求正在执行，请稍后重试。")
	}
	if _, err = store.New(tx).LockUserChanges(ctx, idPG(uid)); err != nil {
		return nil, err
	}
	hash := digest(string(jsonBytes(request)))
	if canonical, ok := c.Get("request_digest"); ok {
		hash = canonical.([]byte)
	}
	var stored []byte
	var response []byte
	var savedStatus int
	err = tx.QueryRow(ctx, `SELECT request_digest,response_status,response_json FROM idempotency_keys WHERE user_id=$1 AND operation=$2 AND key=$3 AND expires_at>now()`, uid, op, key).Scan(&stored, &savedStatus, &response)
	if err == nil {
		if !hmac.Equal(hash, stored) {
			return nil, problem(409, "idempotency_mismatch", "幂等键已用于不同的请求。")
		}
		var result any = json.RawMessage(response)
		if replay != nil {
			result, err = replay(tx, response)
			if err != nil {
				return nil, err
			}
		}
		c.Header("Idempotent-Replayed", "true")
		c.Set("status", savedStatus)
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	result, err := work(tx)
	if err != nil {
		return nil, err
	}
	storedResponse := result
	if current, ok := result.(idempotentCurrentResponse); ok {
		storedResponse = json.RawMessage(idempotentCurrentMarker)
		result = current.body
	}
	if _, err = tx.Exec(ctx, `INSERT INTO idempotency_keys(user_id,operation,key,request_digest,response_status,response_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,operation,key) DO UPDATE SET request_digest=excluded.request_digest,response_status=excluded.response_status,response_json=excluded.response_json,expires_at=excluded.expires_at`, uid, op, key, hash, status, jsonBytes(storedResponse)); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	c.Set("status", status)
	return result, nil
}

type pageCursor struct {
	Time    time.Time `json:"t"`
	ID      string    `json:"i"`
	Expires int64     `json:"e"`
	Binding string    `json:"b"`
}

func (s *Server) cursorBinding(c *gin.Context) string {
	q := c.Request.URL.Query()
	q.Del("cursor")
	return base64.RawURLEncoding.EncodeToString(s.mac("cursor-binding", current(c).User.ID, c.Request.URL.Path, q.Encode()))
}
func (s *Server) pagination(c *gin.Context) (int, *pageCursor, error) {
	limit := 30
	if n := c.Query("limit"); n != "" {
		num, err := strconv.Atoi(n)
		if err != nil || num < 1 || num > 100 {
			return 0, nil, problem(400, "invalid_request", "分页大小必须在 1 至 100 之间。")
		}
		limit = num
	}
	encoded := c.Query("cursor")
	if encoded == "" {
		return limit, nil, nil
	}
	parts := strings.Split(encoded, ".")
	bad := problem(400, "invalid_cursor", "分页游标无效或已过期，请重新加载。")
	if len(parts) != 2 {
		return 0, nil, bad
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return 0, nil, bad
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, s.mac("cursor", parts[0])) {
		return 0, nil, bad
	}
	var cur pageCursor
	if json.Unmarshal(payload, &cur) != nil || cur.Expires <= time.Now().Unix() || cur.Binding != s.cursorBinding(c) || cur.Time.IsZero() {
		return 0, nil, bad
	}
	if _, err = uuid.Parse(cur.ID); err != nil {
		return 0, nil, bad
	}
	return limit, &cur, nil
}
func (s *Server) nextCursor(c *gin.Context, t time.Time, id string) string {
	p := pageCursor{Time: t, ID: id, Expires: time.Now().Add(24 * time.Hour).Unix(), Binding: s.cursorBinding(c)}
	b := base64.RawURLEncoding.EncodeToString(jsonBytes(p))
	return b + "." + base64.RawURLEncoding.EncodeToString(s.mac("cursor", b))
}
func conflict(code, key string, version int64) *apiError {
	return &apiError{Status: 409, Code: code, Message: "内容已更新，请刷新后比较并保存。", Details: map[string]any{key: version}}
}
