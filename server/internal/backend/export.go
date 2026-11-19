package backend

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

const (
	exportPath         = "/api/v1/me/export"
	exportTimeout      = 2 * time.Minute
	exportWriteTimeout = 10 * time.Second
)

// Each export holds a snapshot connection until the archive is streamed.
var exportSlots = make(chan struct{}, 2)

// Count is a grant indicator (1) or a denial (2). A denied request never moves
// the window. The upsert serializes simultaneous attempts across API replicas.
func (s *Server) reserveExport(ctx context.Context, uid string) (int, error) {
	var retry int
	err := s.Pool.QueryRow(ctx, `INSERT INTO auth_rate_limits AS r (key,window_start,count)
        VALUES ($1,statement_timestamp(),1)
        ON CONFLICT (key) DO UPDATE SET
        window_start=CASE WHEN r.window_start <= EXCLUDED.window_start - interval '10 minutes'
            THEN EXCLUDED.window_start ELSE r.window_start END,
        count=CASE WHEN r.window_start <= EXCLUDED.window_start - interval '10 minutes' THEN 1 ELSE 2 END
        RETURNING CASE WHEN count=1 THEN 0 ELSE GREATEST(1,ceil(extract(epoch FROM
            window_start + interval '10 minutes' - clock_timestamp()))::int) END`, s.mac("rate", "export:"+uid)).Scan(&retry)
	return retry, err
}

type exportHTTPWriter struct {
	ctx        context.Context
	w          io.Writer
	controller *http.ResponseController
	deadline   time.Time
}

func (w exportHTTPWriter) setWriteDeadline() error {
	deadline := time.Now().Add(exportWriteTimeout)
	if w.deadline.Before(deadline) {
		deadline = w.deadline
	}
	return w.controller.SetWriteDeadline(deadline)
}

func (w exportHTTPWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if err := w.setWriteDeadline(); err != nil {
		return 0, err
	}
	n, err := w.w.Write(p)
	if err == nil {
		err = w.controller.SetWriteDeadline(w.deadline)
	}
	return n, err
}

func (s *Server) exportMyData(c *gin.Context) (any, error) {
	ctx := c.Request.Context()
	if s.crossOriginRead(c) {
		return nil, problem(403, "forbidden", "数据导出仅支持同源请求。")
	}
	uid := current(c).User.ID
	format := c.Query("format")
	if format != "markdown" && format != "json" {
		return nil, problem(400, "invalid_request", "请选择导出格式。")
	}
	select {
	case exportSlots <- struct{}{}:
		defer func() { <-exportSlots }()
	default:
		return nil, problem(503, "service_unavailable", "正在处理其他导出，请稍后重试。")
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, fmt.Errorf("missing export request deadline")
	}
	controller := http.NewResponseController(c.Writer)
	if w, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter }); ok {
		controller = http.NewResponseController(w.Unwrap())
	}
	if err := controller.SetWriteDeadline(deadline); err != nil {
		return nil, err
	}
	retry, err := s.reserveExport(ctx, uid)
	if err != nil {
		return nil, err
	}
	if retry > 0 {
		c.Header("Retry-After", strconv.Itoa(retry))
		return nil, problem(429, "rate_limited", "导出过于频繁，请稍后重试。")
	}
	start := time.Now()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var at time.Time
	if err = tx.QueryRow(ctx, "SELECT transaction_timestamp()").Scan(&at); err != nil {
		return nil, err
	}
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", `attachment; filename="spark-export-`+at.In(budgetLocation).Format("20060102")+`.zip"`)
	c.Header("X-Accel-Buffering", "no")
	output := exportHTTPWriter{ctx, c.Writer, controller, deadline}
	z := zip.NewWriter(output)
	count, err := writeExport(ctx, tx, uid, z, format, at)
	if err == nil {
		err = tx.Commit(ctx)
	}
	// Only a complete snapshot gets a ZIP central directory. Once streaming
	// started, appending an API error would corrupt the download further.
	if err == nil {
		err = z.Close()
	}
	if err == nil {
		err = output.setWriteDeadline()
		if err == nil {
			err = controller.Flush()
		}
	}
	result := "ok"
	if err != nil {
		result = "failed"
	}
	slog.Info("data export", "user_id", uid, "collections", count, "duration_ms", time.Since(start).Milliseconds(), "result", result)
	if err != nil {
		if c.Writer.Written() {
			panic(http.ErrAbortHandler)
		}
		c.Writer.Header().Del("Content-Disposition")
		c.Writer.Header().Del("Content-Type")
		return nil, err
	}
	return nil, nil
}
