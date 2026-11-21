package backend

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

const maxImageNoteChars = 2000

const imageNotesJSON = `COALESCE((
	SELECT jsonb_agg(jsonb_build_object('attachment_id',n.attachment_id,'version',n.version,'state',n.state,'text',n.text)
	ORDER BY a.position)
	FROM collection_image_notes n JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(n.user_id,n.collection_id,n.attachment_id)
	WHERE (n.user_id,n.collection_id)=(c.user_id,c.id) AND a.removed_at IS NULL AND n.state<>'removed'
 ),'[]'::jsonb)`

func storeImageNote(ctx context.Context, tx pgx.Tx, args imageAnalysisArgs, description string) error {
	description = shortText(strings.TrimSpace(description), maxImageNoteChars)
	if description == "" {
		return nil
	}
	tag, err := tx.Exec(ctx, `INSERT INTO collection_image_notes(user_id,collection_id,attachment_id,source_extraction_id,text,state)
		SELECT e.user_id,e.collection_id,e.attachment_id,e.id,$4,'generated' FROM extractions e
		WHERE (e.user_id,e.collection_id,e.id)=($1,$2,$3)
		ON CONFLICT (user_id,attachment_id) DO UPDATE SET source_extraction_id=EXCLUDED.source_extraction_id,
		 text=EXCLUDED.text,version=collection_image_notes.version+1
		WHERE collection_image_notes.state='generated'
		 AND (collection_image_notes.source_extraction_id,collection_image_notes.text) IS DISTINCT FROM (EXCLUDED.source_extraction_id,EXCLUDED.text)`,
		args.UserID, args.CollectionID, args.ExtractionID, description)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return recordImageNoteChange(ctx, tx, args.UserID, args.CollectionID)
}

func recordImageNoteChange(ctx context.Context, tx pgx.Tx, uid, collection string) error {
	var version int64
	if err := tx.QueryRow(ctx, `UPDATE collections SET resource_version=resource_version+1,updated_at=now()
		WHERE user_id=$1 AND id=$2 RETURNING resource_version`, uid, collection).Scan(&version); err != nil {
		return err
	}
	return record(ctx, tx, uid, "collection", collection, version)
}

func (s *Server) updateImageNote(c *gin.Context) (any, error) {
	req, err := bind[contract.ImageNoteUpdate](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, attachment := c.Request.Context(), current(c).User.ID, c.Param("id")
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var collection, state, text string
	var version int64
	var trashed bool
	if err := tx.QueryRow(ctx, `SELECT c.id,n.state,n.text,n.version,c.deleted_at IS NOT NULL
		FROM collection_image_notes n JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(n.user_id,n.collection_id,n.attachment_id)
		JOIN collections c ON (c.user_id,c.id)=(n.user_id,n.collection_id)
		WHERE n.user_id=$1 AND n.attachment_id=$2 AND a.removed_at IS NULL AND c.purge_requested_at IS NULL`, uid, attachment).
		Scan(&collection, &state, &text, &version, &trashed); err != nil {
		return nil, err
	}
	if trashed {
		return nil, problem(409, "collection_in_trash", "请先从回收站恢复收藏。")
	}
	if int64(req.BaseVersion) != version {
		return nil, conflict("image_note_conflict", "current_version", version)
	}
	nextText := strings.TrimSpace(req.Text)
	if strings.ContainsRune(nextText, 0) {
		return nil, problem(422, "validation_failed", "图片正文包含无效字符。")
	}
	nextState := "edited"
	if nextText == "" {
		nextState = "removed"
	}
	if nextState != state || nextText != text {
		if _, err := tx.Exec(ctx, `UPDATE collection_image_notes SET text=$3,state=$4,version=version+1
			WHERE user_id=$1 AND attachment_id=$2`, uid, attachment, nextText, nextState); err != nil {
			return nil, err
		}
		if err := recordImageNoteChange(ctx, tx, uid, collection); err != nil {
			return nil, err
		}
	}
	row, err := s.loadCollection(ctx, tx, uid, collection)
	if err != nil {
		return nil, err
	}
	return row.Collection, tx.Commit(ctx)
}
