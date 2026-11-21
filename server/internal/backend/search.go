package backend

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

func (s *Server) listCollections(c *gin.Context) (any, error) {
	ctx := c.Request.Context()
	var q querier = s.Pool
	var total *int
	if c.Query("has_suggestion") != "" {
		tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly, IsoLevel: pgx.RepeatableRead})
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(ctx)
		q = tx
		total = new(int)
	}
	rows, next, err := s.findCollections(c, q, nil, total)
	if err != nil {
		return nil, err
	}
	items := []contract.CollectionSummary{}
	for _, row := range rows {
		items = append(items, summary(row))
	}
	return contract.CollectionPage{Items: items, NextCursor: next, Total: total}, nil
}
func (s *Server) search(c *gin.Context) (any, error) {
	terms := strings.Fields(strings.TrimSpace(c.Query("q")))
	if len(terms) == 0 || len(terms) > 10 {
		return nil, problem(422, "validation_failed", "请输入 1 至 10 个关键词。")
	}
	for i := range terms {
		terms[i] = strings.ToLower(terms[i])
	}
	rows, next, err := s.findCollections(c, s.Pool, terms, nil)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, row := range rows {
		snippets := []any{}
		for _, field := range []struct{ name, text string }{{"title", row.DisplayTitle}, {"text", row.PlainText}, {"intent", row.Intent}, {"url", value(row.OriginalUrl)}, {"extraction", row.URLSearchText}, {"image_text", row.ImageSearchText}, {"image_description", row.ImageDescription}} {
			if snip, ok := matchingSnippet(field.text, terms); ok {
				snippets = append(snippets, gin.H{"field": field.name, "text": snip})
			}
		}
		for _, tag := range row.Tags {
			if tag.Decision == "rejected" {
				continue
			}
			for _, term := range terms {
				if strings.Contains(tagKey(tag.Path), tagKey(term)) {
					snippets = append(snippets, gin.H{"field": "tag", "text": tag.Path})
					break
				}
			}
		}
		items = append(items, gin.H{"collection": summary(row), "snippets": snippets})
	}
	out := gin.H{"items": items}
	if next != nil {
		out["next_cursor"] = *next
	}
	return out, nil
}
func matchingSnippet(text string, terms []string) (string, bool) {
	lower := strings.ToLower(text)
	first := -1
	for _, term := range terms {
		pos := strings.Index(lower, term)
		if pos >= 0 && (first < 0 || pos < first) {
			first = pos
		}
	}
	if first < 0 {
		return "", false
	}
	pos := utf8.RuneCountInString(lower[:first])
	runes := []rune(text)
	start := max(0, pos-40)
	end := min(len(runes), max(pos+80, start+160))
	return string(runes[start:end]), true
}
func (s *Server) findCollections(c *gin.Context, q querier, terms []string, total *int) ([]collectionRow, *string, error) {
	limit, cur, err := s.pagination(c)
	if err != nil {
		return nil, nil, err
	}
	args := []any{current(c).User.ID}
	where := []string{"c.user_id=$1"}
	add := func(format string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(format, len(args)))
	}
	switch c.Query("scope") {
	case "trash":
		where = append(where, "c.deleted_at IS NOT NULL", "c.purge_requested_at IS NULL")
	case "unclassified":
		where = append(where, "c.deleted_at IS NULL", "NOT EXISTS (SELECT 1 FROM collection_projects cp WHERE cp.user_id=c.user_id AND cp.collection_id=c.id AND cp.decision IN ('manual','confirmed','auto'))")
	default:
		where = append(where, "c.deleted_at IS NULL")
	}
	if project := c.Query("project_id"); project != "" {
		add(`EXISTS(SELECT 1 FROM collection_projects cp WHERE cp.user_id=c.user_id AND cp.collection_id=c.id AND cp.project_id=$%d::uuid AND cp.decision IN ('manual','confirmed','auto'))`, project)
	}
	if tagID := c.Query("tag_id"); tagID != "" {
		add(`EXISTS (SELECT FROM collection_tags ct WHERE (ct.user_id,ct.collection_id)=(c.user_id,c.id)
			AND ct.tag_id=$%d::uuid AND ct.decision<>'rejected')`, tagID)
	}
	if c.Query("type") == "image" {
		where = append(where, "EXISTS (SELECT 1 FROM attachments a WHERE (a.user_id,a.collection_id)=(c.user_id,c.id) AND a.removed_at IS NULL)")
	}
	if c.Query("type") == "text" {
		where = append(where, "btrim(c.plain_text)<>''")
	}
	if c.Query("type") == "url" {
		where = append(where, "c.original_url<>''")
	}
	if read := c.Query("read"); read != "" {
		if read == "true" {
			where = append(where, "c.read_at IS NOT NULL")
		} else {
			where = append(where, "c.read_at IS NULL")
		}
	}
	from, to := c.Query("created_from"), c.Query("created_to")
	fromTime, _ := time.Parse(time.RFC3339Nano, from) // validateQuery has validated the supplied bounds.
	toTime, _ := time.Parse(time.RFC3339Nano, to)
	if from != "" && to != "" && fromTime.After(toTime) {
		return nil, nil, problem(400, "invalid_request", "创建时间起点不得晚于终点。")
	}
	if from != "" {
		add("c.created_at >= $%d::timestamptz", roundUpToMicrosecond(fromTime))
	}
	if to != "" {
		add("c.created_at < $%d::timestamptz", roundUpToMicrosecond(toTime))
	}

	title := `COALESCE(NULLIF(c.manual_title,''),(SELECT NULLIF(generated_title,'') FROM organization_current oc WHERE oc.user_id=c.user_id AND oc.collection_id=c.id AND oc.content_version=c.content_version),NULLIF(c.plain_text,''),c.original_url)`
	selectCollections := collectionSelect
	if len(terms) > 0 {
		selectCollections = `SELECT ` + collectionJSON + `||jsonb_build_object('url_search_text',page.source_text,'image_search_text',images.image_text,'image_search_description',images.description)
			FROM collections c LEFT JOIN LATERAL (
			 SELECT concat_ws(E'\n',e.source_title,e.evidence_meta->>'site_name',e.evidence_meta->>'summary',e.text) AS source_text
			 FROM extractions e
			 WHERE (e.user_id,e.collection_id,e.content_version,e.source_id)=(c.user_id,c.id,c.content_version,c.original_url)
			   AND e.source_kind='url' AND e.extractor_version='` + urlExtractorVersion + `' AND e.status='succeeded'
			   AND c.deleted_at IS NULL
			) page ON true LEFT JOIN LATERAL (
			 SELECT string_agg(e.text,E'\n' ORDER BY a.position) AS image_text,
			        string_agg(e.evidence_meta->>'description',E'\n' ORDER BY a.position) AS description
			 FROM attachments a JOIN extractions e ON (e.user_id,e.collection_id,e.attachment_id)=(a.user_id,a.collection_id,a.id)
			 WHERE (a.user_id,a.collection_id)=(c.user_id,c.id) AND a.removed_at IS NULL AND c.deleted_at IS NULL
			   AND e.source_kind='image' AND e.extractor_version='` + imageExtractorVersion + `' AND e.status IN ('succeeded','partial')
			) images ON true `
		for _, term := range terms {
			args = append(args, term, tagKey(term))
			n := len(args) - 1
			where = append(where, fmt.Sprintf(`(strpos(lower(%s),$%d)>0 OR strpos(lower(c.plain_text),$%d)>0 OR strpos(lower(c.intent),$%d)>0 OR strpos(lower(c.original_url),$%d)>0 OR strpos(lower(page.source_text),$%d)>0 OR strpos(lower(images.image_text),$%d)>0 OR strpos(lower(images.description),$%d)>0
				OR EXISTS(SELECT FROM collection_tags ct JOIN tags t ON (t.user_id,t.id)=(ct.user_id,ct.tag_id)
					WHERE (ct.user_id,ct.collection_id)=(c.user_id,c.id) AND ct.decision<>'rejected'
					  AND strpos(t.normalized_name,$%d)>0))`, title, n, n, n, n, n, n, n, n+1))
		}
	}
	if filter := c.Query("has_suggestion"); filter != "" {
		prefix := ""
		if filter == "false" {
			prefix = "NOT "
		}
		where = append(where, prefix+"EXISTS (SELECT 1 FROM organization_pending_suggestions sp WHERE (sp.user_id,sp.collection_id)=(c.user_id,c.id))")
	}
	if total != nil {
		if err := q.QueryRow(c.Request.Context(), "SELECT count(*) FROM collections c WHERE "+strings.Join(where, " AND "), args...).Scan(total); err != nil {
			return nil, nil, err
		}
	}
	if cur != nil {
		args = append(args, cur.Time, cur.ID)
		where = append(where, fmt.Sprintf("(c.created_at,c.id)<($%d::timestamptz,$%d::uuid)", len(args)-1, len(args)))
	}
	args = append(args, limit+1)
	query := selectCollections + "WHERE " + strings.Join(where, " AND ") + fmt.Sprintf(" ORDER BY c.created_at DESC,c.id DESC LIMIT $%d", len(args))
	rows, err := q.Query(c.Request.Context(), query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := []collectionRow{}
	for rows.Next() {
		row, e := scanCollection(rows)
		if e != nil {
			return nil, nil, e
		}
		items = append(items, s.collectionView(row))
	}
	if err = rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		v := s.nextCursor(c, last.CreatedAt, last.Id.String())
		next = &v
	}
	return items, next, nil
}

// PostgreSQL stores timestamps at microsecond precision. Rounding both
// bounds up preserves inclusive lower and exclusive upper comparisons.
func roundUpToMicrosecond(instant time.Time) time.Time {
	truncated := instant.Truncate(time.Microsecond)
	if truncated.Before(instant) {
		return truncated.Add(time.Microsecond)
	}
	return truncated
}
