package backend

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

const projectSelect = `SELECT p.id,p.name,p.description,p.focus_points,p.state,p.version,p.created_at,p.updated_at,
 (SELECT count(*) FROM collection_projects cp JOIN collections c ON c.user_id=cp.user_id AND c.id=cp.collection_id WHERE cp.user_id=p.user_id AND cp.project_id=p.id AND cp.decision IN ('manual','confirmed','auto') AND c.deleted_at IS NULL)
 FROM projects p `

func scanProject(row pgx.Row) (contract.Project, error) {
	var p contract.Project
	var focus []byte
	err := row.Scan(&p.Id, &p.Name, &p.Description, &focus, &p.State, &p.Version, &p.CreatedAt, &p.UpdatedAt, &p.CollectionCount)
	if err == nil {
		err = json.Unmarshal(focus, &p.FocusPoints)
	}
	return p, err
}
func loadProject(ctx context.Context, q querier, uid, id string) (contract.Project, error) {
	return scanProject(q.QueryRow(ctx, projectSelect+`WHERE p.user_id=$1 AND p.id=$2`, uid, id))
}
func (s *Server) getProject(c *gin.Context) (any, error) {
	return loadProject(c.Request.Context(), s.Pool, current(c).User.ID, c.Param("id"))
}
func validateProject(name string, focus []string) error {
	if strings.TrimSpace(name) == "" {
		return problem(422, "validation_failed", "项目名称不能为空。")
	}
	for _, f := range focus {
		if strings.TrimSpace(f) == "" {
			return problem(422, "validation_failed", "关注点不能为空白。")
		}
	}
	return nil
}
func (s *Server) createProject(c *gin.Context) (any, error) {
	req, err := bind[contract.ProjectCreate](s, c)
	if err != nil {
		return nil, err
	}
	if err = validateProject(req.Name, req.FocusPoints); err != nil {
		return nil, err
	}
	return s.idempotent(c, req, 201, func(tx pgx.Tx) (any, error) {
		id := uuid.NewString()
		uid := current(c).User.ID
		ctx := c.Request.Context()
		if _, err = tx.Exec(ctx, `INSERT INTO projects(id,user_id,name,description,focus_points) VALUES($1,$2,$3,$4,$5)`, id, uid, req.Name, req.Description, jsonBytes(req.FocusPoints)); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "project", id, 1); err != nil {
			return nil, err
		}
		return loadProject(ctx, tx, uid, id)
	})
}
func (s *Server) updateProject(c *gin.Context) (any, error) {
	req, err := bind[contract.ProjectUpdate](s, c)
	if err != nil {
		return nil, err
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	defer tx.Rollback(ctx)
	uid := current(c).User.ID
	p, err := loadProject(ctx, tx, uid, c.Param("id"))
	if err != nil {
		return nil, err
	}
	if p.Version != req.BaseVersion {
		return nil, conflict("resource_conflict", "current_version", int64(p.Version))
	}
	before := p
	if req.Name != nil {
		p.Name = *req.Name
	}
	if req.Description != nil {
		p.Description = *req.Description
	}
	if req.FocusPoints != nil {
		p.FocusPoints = *req.FocusPoints
	}
	if req.State != nil {
		p.State = contract.ProjectState(*req.State)
	}
	if err = validateProject(p.Name, p.FocusPoints); err != nil {
		return nil, err
	}
	if !equalJSON(before, p) {
		p.Version++
		if _, err = tx.Exec(ctx, `UPDATE projects SET name=$3,description=$4,focus_points=$5,state=$6,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2`, uid, p.Id.String(), p.Name, p.Description, jsonBytes(p.FocusPoints), string(p.State)); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "project", p.Id.String(), int64(p.Version)); err != nil {
			return nil, err
		}
	}
	p, err = loadProject(ctx, tx, uid, p.Id.String())
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return p, nil
}
func (s *Server) listProjects(c *gin.Context) (any, error) {
	limit, cur, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	uid := current(c).User.ID
	var t any
	var id any
	if cur != nil {
		t = cur.Time
		id = cur.ID
	}
	rows, err := s.Pool.Query(c.Request.Context(), projectSelect+`WHERE p.user_id=$1 AND ($2::text='' OR p.state=$2) AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4::uuid)) ORDER BY p.created_at DESC,p.id DESC LIMIT $5`, uid, c.Query("state"), t, id, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []contract.Project{}
	for rows.Next() {
		p, e := scanProject(rows)
		if e != nil {
			return nil, e
		}
		items = append(items, p)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := contract.ProjectPage{Items: items}
	if len(items) > limit {
		out.Items = items[:limit]
		p := items[limit-1]
		next := s.nextCursor(c, p.CreatedAt, p.Id.String())
		out.NextCursor = &next
	}
	return out, nil
}
