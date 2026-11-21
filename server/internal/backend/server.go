package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"spark/server/db"
	"spark/server/internal/asset"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

type Server struct {
	Config    Config
	Pool      *pgxpool.Pool
	spec      *openapi3.T
	hashes    chan struct{}
	dummyHash string
	Organizer *Organizer
	Assets    asset.Storage
	events    *organizationHub
}
type apiError struct {
	Status        int
	Code, Message string
	Details       map[string]any
}

func (e *apiError) Error() string { return e.Code }
func problem(status int, code, message string) *apiError {
	return &apiError{Status: status, Code: code, Message: message}
}

var notFound = problem(404, "not_found", "资源不存在。")

func New(ctx context.Context, cfg Config, pool *pgxpool.Pool) (*Server, error) {
	spec, err := contract.GetSwagger()
	if err != nil {
		return nil, err
	}
	if err = spec.Validate(ctx); err != nil {
		return nil, err
	}
	s := &Server{Config: cfg, Pool: pool, spec: spec, events: newOrganizationHub(), hashes: make(chan struct{}, 2)}
	s.Organizer, err = NewOrganizer(pool, cfg.AIEnabled, cfg.AITrial)
	if err != nil {
		return nil, err
	}
	s.Organizer.Images = ImageOrganizationScope{Enabled: cfg.ImageAnalysisEnabled, AdminID: cfg.ImageAdminID}
	s.dummyHash, err = s.passwordHash("unused-dummy-password-" + uuid.NewString())
	return s, err
}
func (s *Server) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	_ = r.SetTrustedProxies(nil)
	r.Use(func(c *gin.Context) {
		id := uuid.NewString()
		c.Set("request_id", id)
		c.Header("X-Request-ID", id)
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		if c.Request.Method != http.MethodGet || c.FullPath() != organizationEventsPath {
			timeout := 15 * time.Second
			if c.Request.Method == http.MethodGet && c.FullPath() == exportPath {
				timeout = exportTimeout
				c.Header("Cache-Control", "private, no-store")
			}
			ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
			defer cancel()
			c.Request = c.Request.WithContext(ctx)
		}
		started := time.Now()
		c.Next()
		slog.Info("request completed", "request_id", id, "operation", c.Request.Method+" "+c.FullPath(), "status", c.Writer.Status(), "duration_ms", time.Since(started).Milliseconds())
	})
	r.Use(gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, p any) {
		if p == http.ErrAbortHandler {
			panic(p) // net/http must terminate the incomplete response.
		}
		slog.Error("handler panic", "request_id", c.GetString("request_id"), "panic_type", fmt.Sprintf("%T", p), "stack", string(debug.Stack()))
		s.fail(c, problem(500, "internal_error", "服务发生错误。"))
	}))
	api := r.Group("/api/v1")
	api.GET("/health/live", s.handle(func(c *gin.Context) (any, error) { return contract.Health{Status: contract.Ok}, nil }))
	api.GET("/health/ready", s.handle(func(c *gin.Context) (any, error) {
		if err := db.Ready(c.Request.Context(), s.Pool); err != nil {
			return nil, problem(503, "service_unavailable", "数据库或迁移尚未就绪。")
		}
		return contract.Health{Status: contract.Ok}, nil
	}))
	auth := api.Group("/auth")
	auth.Use(s.origin)
	auth.POST("/verification", s.handle(s.verification))
	auth.POST("/register", s.handle(s.register))
	auth.POST("/login", s.handle(s.login))
	auth.POST("/password-reset", s.handle(s.resetPassword))
	secured := api.Group("")
	secured.Use(s.authenticate, s.origin, s.csrf)
	secured.PATCH("/me/preferences", s.handle(s.updatePreferences))
	secured.GET("/me/activity", s.handle(s.getActivity))
	secured.GET("/me/resurface", s.handle(s.getResurface))
	secured.GET("/me/resurface/preferences", s.handle(s.getResurfacePreferences))
	secured.PUT("/me/resurface/preferences", s.handle(s.setResurfacePreferences))
	secured.PUT("/me/resurface/:id/hidden", s.handle(s.hideResurfaceItem))
	secured.GET("/me/image-analysis", s.handle(s.getImagePreferences))
	secured.PUT("/me/image-analysis", s.handle(s.setImagePreferences))
	secured.GET("/me/usage", s.handle(s.getUsage))
	secured.GET("/me/export", s.handle(s.exportMyData))
	secured.GET("/auth/session", s.handle(s.currentSession))
	secured.POST("/auth/logout", s.handle(s.logout))
	secured.GET("/sessions", s.handle(s.listSessions))
	secured.DELETE("/sessions/:id", s.handle(s.revokeSession))
	secured.POST("/tags", s.handle(s.createTag))
	secured.GET("/tags", s.handle(s.listTags))
	secured.PATCH("/tags/:id", s.handle(s.renameTag))
	secured.DELETE("/tags/:id", s.handle(s.deleteTag))
	secured.POST("/projects", s.handle(s.createProject))
	secured.GET("/projects", s.handle(s.listProjects))
	secured.GET("/projects/:id", s.handle(s.getProject))
	secured.PATCH("/projects/:id", s.handle(s.updateProject))
	secured.POST("/uploads", s.handle(s.createUpload))
	secured.GET("/uploads/:id", s.handle(s.getUpload))
	secured.POST("/uploads/:id/complete", s.handle(s.completeUpload))
	secured.GET("/attachments/:id/download", s.handle(s.getDownload))
	secured.POST("/attachments/:id/image-analysis/retry", s.handle(s.retryImageAnalysis))
	secured.POST("/collections", s.handle(s.createCollection))
	secured.GET("/collections", s.handle(s.listCollections))
	secured.GET("/collections/:id", s.handle(s.getCollection))
	secured.PATCH("/collections/:id", s.handle(s.updateCollection))
	secured.PATCH("/collections/:id/tags", s.handle(s.tagDecisions))
	secured.PATCH("/collections/:id/projects", s.handle(s.projectDecisions))
	secured.POST("/collections/:id/projects/undo", s.handle(s.undoProjectDecisions))
	secured.PUT("/collections/:id/read", s.handle(s.readState))
	secured.POST("/collections/:id/opened", s.handle(s.recordCollectionOpened))
	secured.DELETE("/collections/:id", s.handle(s.trashCollection))
	secured.POST("/collections/:id/restore", s.handle(s.restoreCollection))
	secured.POST("/collections/:id/purge", s.handle(s.purgeCollection))
	secured.GET("/collections/:id/purge", s.handle(s.getPurgeStatus))
	secured.GET("/collections/:id/extractions", s.handle(s.getExtractions))
	secured.POST("/collections/:id/extractions", s.handle(s.refreshURLExtraction))
	secured.GET("/collections/:id/organization", s.handle(s.getOrganization))
	secured.POST("/collections/:id/organization", s.handle(s.restartOrganization))
	secured.PUT("/collections/:id/ai-exclusion", s.handle(s.setAIExclusion))
	secured.GET("/organization/events", s.handle(s.organizationEvents))
	secured.GET("/search", s.handle(s.search))
	admin := secured.Group("/admin")
	admin.Use(func(c *gin.Context) {
		if current(c).User.Role != "admin" {
			s.fail(c, problem(403, "forbidden", "需要管理员权限。"))
			return
		}
		c.Next()
	})
	admin.GET("/budgets", s.handle(s.getBudgets))
	admin.PUT("/budgets", s.handle(s.setBudgets))
	admin.GET("/users", s.handle(s.listUsers))
	admin.POST("/invite-imports", s.handle(s.previewInvites))
	admin.POST("/invite-imports/:id/commit", s.handle(s.commitInvites))
	admin.GET("/invite-batches", s.handle(s.listBatches))
	admin.PATCH("/invite-batches/:id", s.handle(s.batchStatus))
	admin.GET("/invite-batches/:id/codes", s.handle(s.listCodes))
	admin.PATCH("/invite-codes/:id", s.handle(s.codeStatus))
	r.NoRoute(s.handle(func(c *gin.Context) (any, error) { return nil, notFound }))
	return r
}
func (s *Server) handle(fn func(*gin.Context) (any, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		if id := c.Param("id"); id != "" {
			if _, err := uuid.Parse(id); err != nil {
				s.fail(c, problem(400, "invalid_request", "无效的资源 ID。"))
				return
			}
		}
		if err := s.validateQuery(c); err != nil {
			s.fail(c, err)
			return
		}
		result, err := fn(c)
		if err != nil {
			s.fail(c, err)
			return
		}
		if c.Writer.Written() {
			return
		}
		status := 200
		if v, ok := c.Get("status"); ok {
			status = v.(int)
		}
		if status == 204 {
			c.Status(status)
		} else {
			c.JSON(status, result)
		}
	}
}
func (s *Server) fail(c *gin.Context, err error) {
	var a *apiError
	if !errors.As(err, &a) {
		var pe *pgconn.PgError
		if errors.Is(err, pgx.ErrNoRows) {
			a = notFound
		} else if errors.As(err, &pe) && pe.Code == "23505" {
			a = problem(409, "duplicate_resource", "资源已存在。")
		}
		if a == nil {
			attrs := []any{"request_id", c.GetString("request_id"), "operation", c.Request.Method + " " + c.FullPath(), "error_type", fmt.Sprintf("%T", err)}
			if pe != nil {
				attrs = append(attrs, "sqlstate", pe.Code, "constraint", pe.ConstraintName)
			}
			slog.Error("request failed", attrs...)
			a = problem(503, "service_unavailable", "服务暂不可用，请稍后重试。")
		}
	}
	if (a.Status == 429 || a.Code == "operation_in_progress") && c.Writer.Header().Get("Retry-After") == "" {
		c.Header("Retry-After", "60")
	}
	detail := gin.H{"code": a.Code, "message": a.Message, "request_id": c.GetString("request_id")}
	if a.Details != nil {
		detail["details"] = a.Details
	}
	c.AbortWithStatusJSON(a.Status, gin.H{"error": detail})
}
func (s *Server) operation(c *gin.Context) *openapi3.Operation {
	path := strings.ReplaceAll(c.FullPath(), "/api/v1", "")
	path = strings.ReplaceAll(path, ":id", "{id}")
	p := s.spec.Paths.Value(path)
	if p == nil {
		return nil
	}
	return p.GetOperation(c.Request.Method)
}
func bind[T any](s *Server, c *gin.Context) (T, error) {
	var out T
	mt, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || mt != "application/json" {
		return out, problem(415, "invalid_request", "请使用 application/json。")
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	b, err := io.ReadAll(c.Request.Body)
	if err != nil {
		var me *http.MaxBytesError
		if errors.As(err, &me) {
			return out, problem(413, "request_too_large", "请求体过大。")
		}
		return out, problem(400, "invalid_request", "无法读取请求。")
	}
	if !json.Valid(b) {
		return out, problem(400, "invalid_request", "无效的 JSON。")
	}
	var v any
	if err = json.Unmarshal(b, &v); err != nil {
		return out, problem(400, "invalid_request", "无效的 JSON。")
	}
	op := s.operation(c)
	if op == nil || op.RequestBody == nil {
		return out, errors.New("missing request schema")
	}
	if obj, ok := v.(map[string]any); ok {
		if doc, exists := obj["document"]; exists {
			if !boundedJSON(doc, 0, new(int)) || s.spec.Components.Schemas["Document"].Value.VisitJSON(doc) != nil {
				return out, problem(422, "unsupported_document", "文档格式不受支持。")
			}
		}
	}
	if err = op.RequestBody.Value.Content.Get("application/json").Schema.Value.VisitJSON(v); err != nil {
		return out, problem(422, "validation_failed", "请求字段不符合接口约定。")
	}
	if err = json.Unmarshal(b, &out); err != nil {
		return out, problem(422, "validation_failed", "无效的请求字段。")
	}
	c.Set("request_digest", digest(string(jsonBytes(v))))
	return out, nil
}
func (s *Server) validateQuery(c *gin.Context) error {
	op := s.operation(c)
	if op == nil {
		return nil
	}
	known := map[string]bool{}
	for _, ref := range op.Parameters {
		p := ref.Value
		if p.In != "query" {
			continue
		}
		known[p.Name] = true
		vs, has := c.Request.URL.Query()[p.Name]
		if !has {
			if p.Required {
				return problem(400, "invalid_request", "缺少查询参数。")
			}
			continue
		}
		if len(vs) != 1 {
			return problem(400, "invalid_request", "重复的查询参数。")
		}
		var val any = vs[0]
		schema := p.Schema.Value
		if schema.Type.Is("integer") {
			i, e := strconv.Atoi(vs[0])
			if e != nil {
				return problem(400, "invalid_request", "无效的数字参数。")
			}
			val = float64(i)
		}
		if schema.Type.Is("boolean") {
			if vs[0] != "true" && vs[0] != "false" {
				return problem(400, "invalid_request", "无效的布尔参数。")
			}
			val = vs[0] == "true"
		}
		if err := schema.VisitJSON(val); err != nil {
			return problem(400, "invalid_request", "查询参数不符合接口约定。")
		}
		if schema.Format == "date-time" {
			if _, e := time.Parse(time.RFC3339Nano, vs[0]); e != nil {
				return problem(400, "invalid_request", "无效的时间。")
			}
		}
		if schema.Format == "uuid" {
			if _, e := uuid.Parse(vs[0]); e != nil {
				return problem(400, "invalid_request", "无效的 ID。")
			}
		}
	}
	for k := range c.Request.URL.Query() {
		if !known[k] {
			return problem(400, "invalid_request", "未知的查询参数。")
		}
	}
	return nil
}
func idPG(id string) pgtype.UUID { u := uuid.MustParse(id); return pgtype.UUID{Bytes: u, Valid: true} }
func jsonBytes(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
func equalJSON(a, b any) bool { return bytes.Equal(canonicalJSON(a), canonicalJSON(b)) }
func canonicalJSON(v any) []byte {
	var normalized any
	if err := json.Unmarshal(jsonBytes(v), &normalized); err != nil {
		panic(err)
	}
	return jsonBytes(normalized)
}
func (s *Server) userTx(c *gin.Context) (pgx.Tx, error) {
	tx, err := s.Pool.Begin(c.Request.Context())
	if err != nil {
		return nil, err
	}
	if _, err = store.New(tx).LockUserChanges(c.Request.Context(), idPG(current(c).User.ID)); err != nil {
		_ = tx.Rollback(c.Request.Context())
		return nil, err
	}
	return tx, nil
}
func record(ctx context.Context, tx pgx.Tx, user, kind, id string, version int64) error {
	return store.New(tx).RecordChange(ctx, store.RecordChangeParams{UserID: idPG(user), ResourceType: kind, ResourceID: idPG(id), ResourceVersion: version, Action: "upsert"})
}

// Bound recursion before schema validation to protect recursive document unions.
func boundedJSON(v any, depth int, n *int) bool {
	*n++
	if depth > 64 || *n > 100000 {
		return false
	}
	switch x := v.(type) {
	case map[string]any:
		for _, child := range x {
			if !boundedJSON(child, depth+1, n) {
				return false
			}
		}
	case []any:
		for _, child := range x {
			if !boundedJSON(child, depth+1, n) {
				return false
			}
		}
	}
	return true
}
