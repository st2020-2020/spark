package backend

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/oapi-codegen/runtime/types"
	"spark/server/internal/contract"
)

func (s *Server) recordCollectionOpened(c *gin.Context) (any, error) {
	var changed, inTrash bool
	err := s.Pool.QueryRow(c.Request.Context(), `WITH opened AS (
		UPDATE collections SET last_opened_at=GREATEST(last_opened_at,clock_timestamp())
		WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL AND purge_requested_at IS NULL
		RETURNING id
	)
	SELECT EXISTS(SELECT FROM opened), EXISTS(
		SELECT FROM collections WHERE user_id=$1 AND id=$2
		  AND deleted_at IS NOT NULL AND purge_requested_at IS NULL
	)`, current(c).User.ID, c.Param("id")).Scan(&changed, &inTrash)
	if err != nil {
		return nil, err
	}
	if !changed {
		if inTrash {
			return nil, problem(409, "collection_in_trash", "请先从回收站恢复收藏。")
		}
		return nil, notFound
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}

func (s *Server) getResurfacePreferences(c *gin.Context) (any, error) {
	var result contract.ResurfacePreferences
	err := s.Pool.QueryRow(c.Request.Context(), `SELECT resurface_enabled FROM users WHERE id=$1`,
		current(c).User.ID).Scan(&result.Enabled)
	return result, err
}

func (s *Server) setResurfacePreferences(c *gin.Context) (any, error) {
	req, err := bind[contract.ResurfacePreferences](s, c)
	if err != nil {
		return nil, err
	}
	_, err = s.Pool.Exec(c.Request.Context(), `UPDATE users SET resurface_enabled=$2
		WHERE id=$1 AND resurface_enabled<>$2`, current(c).User.ID, req.Enabled)
	return req, err
}

func (s *Server) getResurface(c *gin.Context) (any, error) {
	location, err := calendarLocation(c.Query("tz"))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	date := civilDateAt(now, location)
	result := contract.ResurfaceResult{Date: types.Date{Time: date}, Items: []contract.ResurfaceItem{}}
	uid := current(c).User.ID
	ctx := c.Request.Context()
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		var enabled bool
		if err := tx.QueryRow(ctx, `SELECT resurface_enabled FROM users WHERE id=$1 FOR SHARE`, uid).Scan(&enabled); err != nil || !enabled {
			return err
		}
		// The unique date row also records an empty selection. A concurrent
		// request waits for the first transaction to publish the entire list.
		day, err := tx.Exec(ctx, `INSERT INTO resurface_days(user_id,local_date)
			VALUES($1,$2) ON CONFLICT DO NOTHING`, uid, date)
		if err != nil {
			return err
		}
		if day.RowsAffected() == 1 {
			if err := createResurfaceItems(ctx, tx, uid, date, now, location); err != nil {
				return err
			}
			// Retain every date that can still be current in another zone.
			cutoff := civilDateAt(now, time.UTC).AddDate(0, 0, -1)
			if _, err := tx.Exec(ctx, `DELETE FROM resurface_days WHERE user_id=$1 AND local_date<$2`, uid, cutoff); err != nil {
				return err
			}
		}
		rows, err := tx.Query(ctx, `SELECT `+collectionJSON+`,i.reason
			FROM resurface_items i JOIN collections c ON (c.user_id,c.id)=(i.user_id,i.collection_id)
			WHERE i.user_id=$1 AND i.local_date=$2 AND NOT i.hidden
			  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL
			ORDER BY i.position`, uid, date)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var reason contract.ResurfaceReason
			item, err := scanCollection(rows, &reason)
			if err != nil {
				return err
			}
			result.Items = append(result.Items, contract.ResurfaceItem{
				Collection: summary(s.collectionView(item)), Reason: reason,
			})
		}
		return rows.Err()
	})
	return result, err
}

func createResurfaceItems(ctx context.Context, tx pgx.Tx, uid string, date, now time.Time, location *time.Location) error {
	yearStart := time.Date(date.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	yearBoundary, err := localDayStart(yearStart, location)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		WITH unclassified AS (
			SELECT c.id, c.created_at AS sort_time
			FROM collections c
			WHERE c.user_id=$1 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND c.created_at<=$3
			  AND NOT EXISTS (
				SELECT FROM collection_projects cp
				WHERE (cp.user_id,cp.collection_id)=(c.user_id,c.id)
				  AND cp.decision IN ('manual','confirmed','auto')
			  )
			ORDER BY c.created_at,c.id LIMIT 3
		), active_project AS (
			SELECT c.id, COALESCE(c.last_opened_at,c.created_at) AS sort_time
			FROM collections c
			WHERE c.user_id=$1 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL
			  AND COALESCE(c.last_opened_at,c.created_at)<=$4
			  AND c.id NOT IN (SELECT id FROM unclassified)
			  AND EXISTS (
				SELECT FROM collection_projects cp JOIN projects p ON (p.user_id,p.id)=(cp.user_id,cp.project_id)
				WHERE (cp.user_id,cp.collection_id)=(c.user_id,c.id)
				  AND cp.decision IN ('manual','confirmed','auto') AND p.state='active'
			  )
			ORDER BY sort_time,c.id LIMIT (3-(SELECT count(*) FROM unclassified))
		), anniversary AS (
			SELECT c.id,c.created_at AS sort_time
			FROM collections c
			WHERE c.user_id=$1 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND c.created_at<$5
			  AND EXTRACT(MONTH FROM c.created_at AT TIME ZONE $6::text)=EXTRACT(MONTH FROM $2::date)
			  AND EXTRACT(DAY FROM c.created_at AT TIME ZONE $6::text)=EXTRACT(DAY FROM $2::date)
			  AND c.id NOT IN (SELECT id FROM unclassified UNION ALL SELECT id FROM active_project)
			ORDER BY c.created_at DESC,c.id LIMIT (3-(SELECT count(*) FROM unclassified)-(SELECT count(*) FROM active_project))
		), candidates AS (
			SELECT id,sort_time,1 AS priority,'unclassified' AS reason FROM unclassified
			UNION ALL SELECT id,sort_time,2,'inactive_project' FROM active_project
			UNION ALL SELECT id,sort_time,3,'anniversary' FROM anniversary
		), numbered AS (
			SELECT id,reason,row_number() OVER(ORDER BY priority,
				CASE WHEN priority=3 THEN sort_time END DESC,
				CASE WHEN priority<>3 THEN sort_time END ASC,id) AS position
			FROM candidates
		)
		INSERT INTO resurface_items(user_id,local_date,collection_id,position,reason)
		SELECT $1,$2,numbered.id,numbered.position,numbered.reason
		FROM numbered JOIN collections c ON c.user_id=$1 AND c.id=numbered.id
		WHERE c.deleted_at IS NULL AND c.purge_requested_at IS NULL
		FOR KEY SHARE OF c`, uid, date, now.Add(-7*24*time.Hour), now.Add(-30*24*time.Hour),
		yearBoundary, location.String())
	return err
}

func (s *Server) hideResurfaceItem(c *gin.Context) (any, error) {
	location, err := calendarLocation(c.Query("tz"))
	if err != nil {
		return nil, err
	}
	date, err := parseCivilDate(c.Query("date"))
	if err != nil {
		return nil, err
	}
	if !date.Equal(civilDateAt(time.Now(), location)) {
		return nil, problem(409, "resurface_day_changed", "日期已切换，请刷新今日重现。")
	}
	tag, err := s.Pool.Exec(c.Request.Context(), `UPDATE resurface_items i SET hidden=true
		FROM collections c
		WHERE i.user_id=$1 AND i.local_date=$2 AND i.collection_id=$3
		  AND (c.user_id,c.id)=(i.user_id,i.collection_id)
		  AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL`, current(c).User.ID, date, c.Param("id"))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, notFound
	}
	c.Set("status", http.StatusNoContent)
	return nil, nil
}
