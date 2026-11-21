package backend

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"spark/server/internal/contract"
)

func tagKey(name string) string {
	return norm.NFC.String(cases.Fold().String(norm.NFC.String(strings.TrimSpace(name))))
}

func tagName(raw string) (string, error) {
	name := norm.NFC.String(strings.TrimSpace(raw))
	if name == "" || utf8.RuneCountInString(name) > 24 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", problem(422, "validation_failed", "标签名称须为 1 至 24 个字符，且不能含控制字符。")
	}
	return name, nil
}

const tagSelect = `SELECT t.id,t.name,t.created_at,(
	SELECT count(*) FROM collection_tags ct JOIN collections c ON (c.user_id,c.id)=(ct.user_id,ct.collection_id)
	WHERE (ct.user_id,ct.tag_id)=(t.user_id,t.id) AND ct.decision<>'rejected'
	  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL
) FROM tags t `

func scanTag(row pgx.Row) (contract.Tag, time.Time, error) {
	var tag contract.Tag
	var created time.Time
	err := row.Scan(&tag.Id, &tag.Name, &created, &tag.CollectionCount)
	tag.Path = tag.Name
	return tag, created, err
}

func loadTag(ctx context.Context, q querier, uid, id string) (contract.Tag, error) {
	tag, _, err := scanTag(q.QueryRow(ctx, tagSelect+`WHERE t.user_id=$1 AND t.id=$2`, uid, id))
	return tag, err
}

func (s *Server) createTag(c *gin.Context) (any, error) {
	req, err := bind[contract.TagCreate](s, c)
	if err != nil {
		return nil, err
	}
	name, err := tagName(req.Name)
	if err != nil {
		return nil, err
	}
	uid, ctx := current(c).User.ID, c.Request.Context()
	return s.idempotentWithReplay(c, req, http.StatusCreated, func(tx pgx.Tx) (any, error) {
		id := uuid.NewString()
		if _, err := tx.Exec(ctx, `INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,$3,$4)`,
			id, uid, name, tagKey(name)); err != nil {
			return nil, err
		}
		return loadTag(ctx, tx, uid, id)
	}, func(tx pgx.Tx, body json.RawMessage) (any, error) {
		var original contract.Tag
		if err := json.Unmarshal(body, &original); err != nil {
			return nil, err
		}
		return loadTag(ctx, tx, uid, original.Id.String())
	})
}

func (s *Server) listTags(c *gin.Context) (any, error) {
	limit, cursor, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	var before, id any
	if cursor != nil {
		before, id = cursor.Time, cursor.ID
	}
	rows, err := s.Pool.Query(c.Request.Context(), tagSelect+`WHERE t.user_id=$1
		AND ($2::text='' OR strpos(t.normalized_name,$2)>0)
		AND ($3::timestamptz IS NULL OR (t.created_at,t.id)<($3,$4::uuid))
		ORDER BY t.created_at DESC,t.id DESC LIMIT $5`, current(c).User.ID, tagKey(c.Query("q")), before, id, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := contract.TagPage{Items: []contract.Tag{}}
	var created time.Time
	for rows.Next() {
		tag, createdAt, err := scanTag(rows)
		if err != nil {
			return nil, err
		}
		if len(page.Items) == limit {
			next := s.nextCursor(c, created, page.Items[limit-1].Id.String())
			page.NextCursor = &next
			break
		}
		page.Items = append(page.Items, tag)
		created = createdAt
	}
	return page, rows.Err()
}

func checkTagName(ctx context.Context, tx pgx.Tx, uid, id, expected string) error {
	var currentName string
	if err := tx.QueryRow(ctx, `SELECT name FROM tags WHERE user_id=$1 AND id=$2`, uid, id).Scan(&currentName); err != nil {
		return err
	}
	if currentName != expected {
		return problem(409, "tag_conflict", "标签名称已变化，请刷新后重试。")
	}
	return nil
}

func (s *Server) renameTag(c *gin.Context) (any, error) {
	req, err := bind[contract.TagRename](s, c)
	if err != nil {
		return nil, err
	}
	name, err := tagName(req.Name)
	if err != nil {
		return nil, err
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	defer tx.Rollback(ctx)
	if err := checkTagName(ctx, tx, uid, id, req.ExpectedName); err != nil {
		return nil, err
	}
	if name != req.ExpectedName {
		if _, err := tx.Exec(ctx, `UPDATE tags SET name=$3,normalized_name=$4,updated_at=now() WHERE user_id=$1 AND id=$2`,
			uid, id, name, tagKey(name)); err != nil {
			return nil, err
		}
	}
	tag, err := loadTag(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	return tag, tx.Commit(ctx)
}

func (s *Server) deleteTag(c *gin.Context) (any, error) {
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	defer tx.Rollback(ctx)
	if err := checkTagName(ctx, tx, uid, id, c.Query("expected_name")); err != nil {
		return nil, err
	}
	// Removing a tag changes decisions even for collections currently in trash.
	// Allocate change-event sequence numbers under the same account lock.
	if _, err := tx.Exec(ctx, `WITH affected AS (
		UPDATE collections c SET decision_version=c.decision_version+1,
			resource_version=c.resource_version+1,updated_at=now()
		FROM collection_tags ct
		WHERE (c.user_id,c.id)=(ct.user_id,ct.collection_id) AND ct.user_id=$1 AND ct.tag_id=$2
		  AND c.purge_requested_at IS NULL
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
	if _, err := tx.Exec(ctx, `DELETE FROM tags WHERE user_id=$1 AND id=$2`, uid, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}

func (s *Server) tagDecisions(c *gin.Context) (any, error) {
	req, err := bind[contract.TagDecisionUpdate](s, c)
	if err != nil {
		return nil, err
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	defer tx.Rollback(ctx)
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err := checkActive(row); err != nil {
		return nil, err
	}
	if row.DecisionVersion != req.BaseDecisionVersion {
		return nil, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
	}
	ids := make([]uuid.UUID, 0, len(req.Operations))
	seen := make(map[uuid.UUID]bool, len(req.Operations))
	for _, op := range req.Operations {
		if seen[op.Id] {
			return nil, problem(422, "validation_failed", "一次操作不能重复指定同一标签。")
		}
		seen[op.Id] = true
		ids = append(ids, op.Id)
	}
	if err := checkOwnedTags(ctx, tx, uid, ids); err != nil {
		return nil, err
	}
	existing := make(map[uuid.UUID]string, len(row.Tags))
	for _, tag := range row.Tags {
		existing[tag.TagId] = string(tag.Decision)
	}
	changed := false
	for _, op := range req.Operations {
		decision, update := nextManualDecision(existing[op.Id], string(op.Action))
		if !update {
			continue
		}
		if decision == "" {
			_, err = tx.Exec(ctx, `DELETE FROM collection_tags WHERE user_id=$1 AND collection_id=$2 AND tag_id=$3`, uid, id, op.Id)
		} else {
			_, err = tx.Exec(ctx, `INSERT INTO collection_tags(user_id,collection_id,tag_id,decision)
				VALUES($1,$2,$3,$4) ON CONFLICT(collection_id,tag_id) DO UPDATE
				SET decision=EXCLUDED.decision,run_id=NULL,updated_at=now()`, uid, id, op.Id, decision)
		}
		if err != nil {
			return nil, err
		}
		changed = true
	}
	if !changed {
		return row.Collection, tx.Commit(ctx)
	}
	result, err := s.finishCollectionDecisions(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func checkOwnedTags(ctx context.Context, tx pgx.Tx, uid string, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tags WHERE user_id=$1 AND id=ANY($2::uuid[])`, uid, ids).Scan(&count); err != nil {
		return err
	}
	if count != len(ids) {
		return notFound
	}
	return nil
}
