package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
	"spark/server/internal/store"
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
	ctx, uid := c.Request.Context(), current(c).User.ID
	return s.idempotentWithReplay(c, req, 201, func(tx pgx.Tx) (any, error) {
		id := uuid.NewString()
		if _, err = tx.Exec(ctx, `INSERT INTO projects(id,user_id,name,description,focus_points) VALUES($1,$2,$3,$4,$5)`, id, uid, req.Name, req.Description, jsonBytes(req.FocusPoints)); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, uid, "project", id, 1); err != nil {
			return nil, err
		}
		return loadProject(ctx, tx, uid, id)
	}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
		var saved struct {
			ID uuid.UUID `json:"id"`
		}
		if err := json.Unmarshal(response, &saved); err != nil {
			return nil, err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE user_id=$1 AND id=$2)`,
			uid, saved.ID).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, notFound
		}
		return response, nil
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
func (s *Server) deleteProject(c *gin.Context) (any, error) {
	baseVersion, err := strconv.ParseInt(c.Query("base_version"), 10, 64)
	if err != nil || baseVersion < 1 {
		return nil, problem(400, "invalid_request", "无效的项目版本。")
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	return s.idempotent(c, baseVersion, http.StatusNoContent, func(tx pgx.Tx) (any, error) {
		var version int64
		if err := tx.QueryRow(ctx, `SELECT version FROM projects WHERE user_id=$1 AND id=$2`, uid, id).Scan(&version); err != nil {
			return nil, err
		}
		if version != baseVersion {
			return nil, conflict("resource_conflict", "current_version", version)
		}
		// The account change lock serializes deletion with manual decisions and
		// organization write-back. Version live and restorable notes alike.
		if _, err := tx.Exec(ctx, `WITH detached AS (
			DELETE FROM collection_projects WHERE user_id=$1 AND project_id=$2 RETURNING collection_id
		), affected AS (
			UPDATE collections c SET decision_version=c.decision_version+1,
				resource_version=c.resource_version+1,updated_at=now()
			FROM detached WHERE c.user_id=$1 AND c.id=detached.collection_id AND c.purge_requested_at IS NULL
			RETURNING c.id,c.resource_version
		), sequence AS (
			UPDATE user_change_counters SET last_seq=last_seq+(SELECT count(*) FROM affected)
			WHERE user_id=$1 RETURNING last_seq-(SELECT count(*) FROM affected) AS previous
		)
		INSERT INTO change_events(user_id,seq,resource_type,resource_id,resource_version,action)
		SELECT $1,sequence.previous+row_number() OVER(ORDER BY affected.id),
			'collection',affected.id,affected.resource_version,'upsert' FROM sequence CROSS JOIN affected`, uid, id); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM projects WHERE user_id=$1 AND id=$2`, uid, id); err != nil {
			return nil, err
		}
		return nil, store.New(tx).RecordChange(ctx, store.RecordChangeParams{
			UserID: idPG(uid), ResourceType: "project", ResourceID: idPG(id), ResourceVersion: version + 1, Action: "delete",
		})
	})
}

func (s *Server) queryProjectPage(c *gin.Context, state, projection string) (pgx.Rows, int, error) {
	limit, cur, err := s.pagination(c)
	if err != nil {
		return nil, 0, err
	}
	uid := current(c).User.ID
	var t any
	var id any
	if cur != nil {
		t = cur.Time
		id = cur.ID
	}
	rows, err := s.Pool.Query(c.Request.Context(), projection+`WHERE p.user_id=$1 AND ($2::text='' OR p.state=$2) AND ($3::timestamptz IS NULL OR (p.created_at,p.id)<($3,$4::uuid)) AND ($6::text='' OR strpos(lower(p.name),lower($6))>0) ORDER BY p.created_at DESC,p.id DESC LIMIT $5`, uid, state, t, id, limit+1, strings.TrimSpace(c.Query("q")))
	return rows, limit, err
}

func (s *Server) listProjects(c *gin.Context) (any, error) {
	rows, limit, err := s.queryProjectPage(c, c.Query("state"), projectSelect)
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
