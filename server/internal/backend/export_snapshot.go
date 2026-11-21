package backend

import (
	"context"
	"encoding/json"
	"iter"
	"time"

	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

const (
	exportPageSize        = 200
	exportContentPageSize = 16
)

// Finish each query before yielding. This lets the collection and decision
// cursors share a single snapshot without holding two pgx result sets open.
func exportPages[T any](ctx context.Context, pageSize int, fetch func(*T) (pgx.Rows, error), scan pgx.RowToFunc[T]) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var after *T
		var zero T
		for {
			if err := ctx.Err(); err != nil {
				yield(zero, err)
				return
			}
			rows, err := fetch(after)
			if err != nil {
				yield(zero, err)
				return
			}
			page, err := pgx.CollectRows(rows, scan)
			if err != nil {
				yield(zero, err)
				return
			}
			for i := range page {
				if err := ctx.Err(); err != nil {
					yield(zero, err)
					return
				}
				if !yield(page[i], nil) {
					return
				}
			}
			if len(page) < pageSize {
				return
			}
			last := page[len(page)-1]
			after = &last
		}
	}
}

type exportSnapshot struct {
	ctx context.Context
	tx  pgx.Tx
	uid string
}

func (s exportSnapshot) projects() iter.Seq2[contract.Project, error] {
	return exportPages(s.ctx, exportPageSize, func(after *contract.Project) (pgx.Rows, error) {
		var id any
		if after != nil {
			id = after.Id
		}
		return s.tx.Query(s.ctx, projectSelect+`WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.id>$2)
            ORDER BY p.id LIMIT $3`, s.uid, id, exportPageSize)
	}, func(r pgx.CollectableRow) (contract.Project, error) { return scanProject(r) })
}

type exportCollection struct {
	ID              string               `json:"id"`
	Document        json.RawMessage      `json:"document"`
	ImageNotes      []contract.ImageNote `json:"image_notes,omitempty"`
	PlainText       string               `json:"plain_text"`
	ManualTitle     string               `json:"manual_title"`
	DisplayTitle    string               `json:"display_title"`
	GeneratedTitle  *string              `json:"generated_title,omitempty"`
	Summary         *string              `json:"summary,omitempty"`
	Intent          string               `json:"intent"`
	OriginalURL     string               `json:"original_url"`
	CreatedAt       time.Time            `json:"created_at"`
	UpdatedAt       time.Time            `json:"updated_at"`
	ReadAt          *time.Time           `json:"read_at,omitempty"`
	AIExcluded      bool                 `json:"ai_excluded"`
	ResourceVersion int64                `json:"resource_version"`
	ContentVersion  int64                `json:"content_version"`
	DecisionVersion int64                `json:"decision_version"`
}

func (s exportSnapshot) collections() iter.Seq2[exportCollection, error] {
	return exportPages(s.ctx, exportContentPageSize, func(after *exportCollection) (pgx.Rows, error) {
		var id any
		if after != nil {
			id = after.ID
		}
		return s.tx.Query(s.ctx, `SELECT c.id,c.document,c.plain_text,c.manual_title,c.intent,c.original_url,
            c.created_at,c.updated_at,c.read_at,c.ai_excluded,c.resource_version,c.content_version,c.decision_version,
            oc.generated_title,oc.summary,`+imageNotesJSON+` FROM collections c LEFT JOIN organization_current oc
            ON (oc.user_id,oc.collection_id,oc.content_version)=(c.user_id,c.id,c.content_version)
            WHERE c.user_id=$1 AND c.deleted_at IS NULL AND ($2::uuid IS NULL OR c.id>$2)
            ORDER BY c.id LIMIT $3`, s.uid, id, exportContentPageSize)
	}, func(r pgx.CollectableRow) (exportCollection, error) {
		var c exportCollection
		err := r.Scan(&c.ID, &c.Document, &c.PlainText, &c.ManualTitle, &c.Intent, &c.OriginalURL, &c.CreatedAt, &c.UpdatedAt, &c.ReadAt, &c.AIExcluded, &c.ResourceVersion, &c.ContentVersion, &c.DecisionVersion, &c.GeneratedTitle, &c.Summary, &c.ImageNotes)
		c.DisplayTitle = titleFor(c.PlainText, c.ManualTitle, c.OriginalURL)
		if c.ManualTitle == "" && value(c.GeneratedTitle) != "" {
			c.DisplayTitle = *c.GeneratedTitle
		}
		return c, err
	})
}

type exportDecision struct {
	collectionID string
	unassigned   bool
	contract.ProjectAssociation
}

func (s exportSnapshot) decisions() iter.Seq2[exportDecision, error] {
	return exportPages(s.ctx, exportPageSize, func(after *exportDecision) (pgx.Rows, error) {
		var cid, pid any
		var unassigned bool
		if after != nil {
			cid = after.collectionID
			unassigned = after.unassigned
			pid = after.ProjectId
		}
		return s.tx.Query(s.ctx, `SELECT cp.collection_id, cp.decision NOT IN ('manual','confirmed','auto') AS unassigned,
            cp.project_id,p.name,cp.decision,cp.reason,cp.evidence,cp.project_version
            FROM collection_projects cp JOIN projects p ON (p.user_id,p.id)=(cp.user_id,cp.project_id)
            JOIN collections c ON (c.user_id,c.id)=(cp.user_id,cp.collection_id)
            WHERE cp.user_id=$1 AND c.deleted_at IS NULL
            AND ($2::uuid IS NULL OR (cp.collection_id,cp.decision NOT IN ('manual','confirmed','auto'),cp.project_id)>($2,$3::boolean,$4::uuid))
            ORDER BY cp.collection_id,unassigned,cp.project_id LIMIT $5`, s.uid, cid, unassigned, pid, exportPageSize)
	}, func(r pgx.CollectableRow) (exportDecision, error) {
		var d exportDecision
		err := r.Scan(&d.collectionID, &d.unassigned, &d.ProjectId, &d.Name, &d.Decision, &d.Reason, &d.Evidence, &d.ProjectVersion)
		return d, err
	})
}

func (s exportSnapshot) tags() iter.Seq2[contract.Tag, error] {
	return exportPages(s.ctx, exportPageSize, func(after *contract.Tag) (pgx.Rows, error) {
		var id any
		if after != nil {
			id = after.Id
		}
		return s.tx.Query(s.ctx, tagSelect+`WHERE t.user_id=$1 AND ($2::uuid IS NULL OR t.id>$2)
			ORDER BY t.id LIMIT $3`, s.uid, id, exportPageSize)
	}, func(r pgx.CollectableRow) (contract.Tag, error) {
		tag, _, err := scanTag(r)
		return tag, err
	})
}

type exportTagDecision struct {
	collectionID string
	contract.TagAssociation
}

func (s exportSnapshot) tagDecisions() iter.Seq2[exportTagDecision, error] {
	return exportPages(s.ctx, exportPageSize, func(after *exportTagDecision) (pgx.Rows, error) {
		var cid, tagID any
		if after != nil {
			cid, tagID = after.collectionID, after.TagId
		}
		return s.tx.Query(s.ctx, `SELECT ct.collection_id,ct.tag_id,t.name,ct.decision
			FROM collection_tags ct JOIN tags t ON (t.user_id,t.id)=(ct.user_id,ct.tag_id)
			JOIN collections c ON (c.user_id,c.id)=(ct.user_id,ct.collection_id)
			WHERE ct.user_id=$1 AND c.deleted_at IS NULL
			  AND ($2::uuid IS NULL OR (ct.collection_id,ct.tag_id)>($2,$3::uuid))
			ORDER BY ct.collection_id,ct.tag_id LIMIT $4`, s.uid, cid, tagID, exportPageSize)
	}, func(r pgx.CollectableRow) (exportTagDecision, error) {
		var t exportTagDecision
		err := r.Scan(&t.collectionID, &t.TagId, &t.Path, &t.Decision)
		return t, err
	})
}
