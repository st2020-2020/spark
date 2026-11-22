package backend

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"spark/server/internal/contract"
)

func (s *Server) getCollectionThread(c *gin.Context) (any, error) {
	limit, cursor, err := s.pagination(c)
	if err != nil {
		return nil, err
	}
	var since any
	afterID := uuid.Nil.String()
	if cursor != nil {
		since, afterID = cursor.Time, cursor.ID
	}

	// Read the anchor and page in the same snapshot. A left join distinguishes
	// the end of an existing thread from a missing or inactive anchor.
	rows, err := s.Pool.Query(c.Request.Context(), `
		SELECT a.thread_id,n.id,n.created_at,n.deleted_at IS NOT NULL,
		       CASE WHEN n.deleted_at IS NULL THEN n.manual_title END,
		       CASE WHEN n.deleted_at IS NULL THEN n.plain_text END,
		       CASE WHEN n.deleted_at IS NULL THEN n.original_url END,
		       CASE WHEN n.deleted_at IS NULL THEN
		         (SELECT oc.generated_title FROM organization_current oc
		          WHERE (oc.user_id,oc.collection_id,oc.content_version)=(n.user_id,n.id,n.content_version))
		       END,
		       CASE WHEN n.deleted_at IS NULL THEN
		         (SELECT cover.filename FROM attachments cover
		          WHERE (cover.user_id,cover.collection_id)=(n.user_id,n.id) AND cover.removed_at IS NULL
		          ORDER BY cover.position LIMIT 1)
		       END
		FROM collections a LEFT JOIN LATERAL (
		    SELECT m.id,m.user_id,m.created_at,m.deleted_at,m.plain_text,m.manual_title,m.original_url,m.content_version
		    FROM collections m
		    WHERE (m.user_id,m.thread_id)=(a.user_id,a.thread_id) AND m.purge_requested_at IS NULL
		      AND (m.created_at,m.id)>(coalesce($3::timestamptz,'-infinity'),$4::uuid)
		    ORDER BY m.created_at,m.id LIMIT $5
		) n ON true
		WHERE a.user_id=$1 AND a.id=$2 AND a.deleted_at IS NULL AND a.purge_requested_at IS NULL
		ORDER BY n.created_at,n.id`, current(c).User.ID, c.Param("id"), since, afterID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := contract.CollectionThread{Items: make([]contract.CollectionThreadItem, 0, limit)}
	found := false
	for rows.Next() {
		found = true
		var id pgtype.UUID
		var createdAt pgtype.Timestamptz
		var deleted bool
		var manual, plain, rawURL, generated, cover *string
		if err := rows.Scan(&result.ThreadId, &id, &createdAt, &deleted, &manual, &plain, &rawURL, &generated, &cover); err != nil {
			return nil, err
		}
		if !id.Valid {
			continue
		}
		item := contract.CollectionThreadItem{
			Id: uuid.UUID(id.Bytes), CreatedAt: createdAt.Time, Status: contract.CollectionThreadItemStatusDeleted,
		}
		if !deleted {
			title := collectionDisplayTitle(value(plain), value(manual), value(rawURL), value(generated), value(cover))
			item.DisplayTitle = &title
			item.Status = contract.CollectionThreadItemStatusActive
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, notFound
	}
	if len(result.Items) > limit {
		result.Items = result.Items[:limit]
		last := result.Items[limit-1]
		next := s.nextCursor(c, last.CreatedAt, last.Id.String())
		result.NextCursor = &next
	}
	return result, nil
}
