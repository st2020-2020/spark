package backend

import (
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func hasRequestHeader(c *gin.Context, name string) bool {
	return len(c.Request.Header.Values(name)) != 0
}

// Match the registered method and Gin template. A new private route does
// not gain desktop access merely by living under the same resource prefix.
func desktopBusinessAllowed(c *gin.Context) bool {
	switch c.Request.Method + " " + c.FullPath() {
	case "POST /api/v1/collections", "GET /api/v1/collections", "GET /api/v1/collections/:id",
		"GET /api/v1/projects", "GET /api/v1/tags", "GET /api/v1/search",
		"POST /api/v1/uploads", "GET /api/v1/uploads/:id", "POST /api/v1/uploads/:id/complete",
		"GET /api/v1/attachments/:id/download", "GET /api/v1/attachments/:id/thumbnail":
		return true
	}
	return false
}

func (s *Server) authenticateBusiness(c *gin.Context) {
	if !hasRequestHeader(c, "Authorization") {
		s.authenticate(c)
		return
	}
	s.authenticateDesktopRequest(c, true)
}

func (s *Server) authenticateDesktop(c *gin.Context) {
	s.authenticateDesktopRequest(c, false)
}

func (s *Server) authenticateDesktopRequest(c *gin.Context, business bool) {
	if hasRequestHeader(c, "Authorization") && hasRequestHeader(c, "Cookie") {
		s.fail(c, mixedCredentials)
		return
	}
	session, err := s.bearerSession(c, desktopSessionKind)
	if err != nil {
		s.fail(c, err)
		return
	}
	if business && !desktopBusinessAllowed(c) {
		s.fail(c, problem(403, "desktop_scope_forbidden", "桌面会话不能使用此功能。"))
		return
	}
	c.Set("session", session)
	c.Next()
}

func (s *Server) cookieOrigin(c *gin.Context) {
	if current(c).Kind == desktopSessionKind {
		c.Next()
		return
	}
	s.origin(c)
}

func (s *Server) cookieCSRF(c *gin.Context) {
	if current(c).Kind == desktopSessionKind {
		c.Next()
		return
	}
	s.csrf(c)
}

// Recheck after acquiring the normal account write lock. This closes the
// gap between request authentication and mutation or idempotent replay.
func lockDesktopWriteSession(c *gin.Context, tx pgx.Tx) error {
	session := current(c)
	if session.Kind != desktopSessionKind {
		return nil
	}
	_, err := lockDevicePrincipal(c.Request.Context(), tx, session.User.ID, session.ID, desktopSessionKind)
	if errors.Is(err, pgx.ErrNoRows) {
		return desktopSessionExpired
	}
	return err
}
