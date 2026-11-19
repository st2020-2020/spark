package backend

import (
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

func (s *Server) listUsers(c *gin.Context) (any, error) {
	limit, cursor, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	var beforeTime, beforeID any
	if cursor != nil {
		beforeTime, beforeID = cursor.Time, cursor.ID
	}
	// created_at is used only as a cursor coordinate. Project the public fields
	// explicitly so credentials and account internals never leave this query.
	rows, err := s.Pool.Query(c.Request.Context(), `
		SELECT id, email_normalized, role, status, ai_enabled, ai_policy_version, created_at
		FROM users
		WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1, $2::uuid))
		ORDER BY created_at DESC, id DESC
		LIMIT $3`, beforeTime, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("query admin users: %w", err)
	}
	type userRow struct {
		user      contract.User
		createdAt time.Time
	}
	users, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (userRow, error) {
		var result userRow
		u := &result.user
		err := row.Scan(&u.Id, &u.Email, &u.Role, &u.Status, &u.AiEnabled, &u.AiPolicyVersion, &result.createdAt)
		return result, err
	})
	if err != nil {
		return nil, fmt.Errorf("read admin users: %w", err)
	}
	page := contract.UserPage{Items: make([]contract.User, 0, min(len(users), limit))}
	if len(users) > limit {
		users = users[:limit]
		last := users[limit-1]
		next := s.nextCursor(c, last.createdAt, last.user.Id.String())
		page.NextCursor = &next
	}
	for _, row := range users {
		page.Items = append(page.Items, row.user)
	}
	return page, nil
}
