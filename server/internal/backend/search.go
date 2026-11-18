package backend

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"spark/server/internal/contract"
)

func (s *Server) listCollections(c *gin.Context) (any, error) {
	rows, next, err := s.findCollections(c, nil)
	if err != nil {
		return nil, err
	}
	items := []contract.CollectionSummary{}
	for _, row := range rows {
		items = append(items, summary(row))
	}
	return contract.CollectionPage{Items: items, NextCursor: next}, nil
}
func (s *Server) search(c *gin.Context) (any, error) {
	terms := strings.Fields(strings.TrimSpace(c.Query("q")))
	if len(terms) == 0 || len(terms) > 10 {
		return nil, problem(422, "validation_failed", "请输入 1 至 10 个关键词。")
	}
	for i := range terms {
		terms[i] = strings.ToLower(terms[i])
	}
	rows, next, err := s.findCollections(c, terms)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, row := range rows {
		snippets := []any{}
		for _, field := range []struct{ name, text string }{{"title", row.DisplayTitle}, {"text", row.PlainText}, {"intent", row.Intent}, {"url", value(row.OriginalUrl)}} {
			if snip, ok := matchingSnippet(field.text, terms); ok {
				snippets = append(snippets, gin.H{"field": field.name, "text": snip})
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
func (s *Server) findCollections(c *gin.Context, terms []string) ([]collectionRow, *string, error) {
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
		where = append(where, "c.deleted_at IS NOT NULL")
	case "unclassified":
		where = append(where, "c.deleted_at IS NULL", "NOT EXISTS (SELECT 1 FROM collection_projects cp WHERE cp.user_id=c.user_id AND cp.collection_id=c.id AND cp.decision IN ('manual','confirmed','auto'))")
	default:
		where = append(where, "c.deleted_at IS NULL")
	}
	if project := c.Query("project_id"); project != "" {
		add(`EXISTS(SELECT 1 FROM collection_projects cp WHERE cp.user_id=c.user_id AND cp.collection_id=c.id AND cp.project_id=$%d::uuid AND cp.decision IN ('manual','confirmed','auto'))`, project)
	}
	if c.Query("tag_id") != "" || c.Query("type") == "image" {
		where = append(where, "false")
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
	if from := c.Query("created_from"); from != "" {
		add("c.created_at >= $%d::timestamptz", from)
	}
	if to := c.Query("created_to"); to != "" {
		add("c.created_at < $%d::timestamptz", to)
	}
	if cur != nil {
		args = append(args, cur.Time, cur.ID)
		where = append(where, fmt.Sprintf("(c.created_at,c.id)<($%d::timestamptz,$%d::uuid)", len(args)-1, len(args)))
	}
	title := `COALESCE(NULLIF(c.manual_title,''),NULLIF(c.plain_text,''),c.original_url)`
	for _, term := range terms {
		args = append(args, term)
		n := len(args)
		where = append(where, fmt.Sprintf(`(strpos(lower(%s),$%d)>0 OR strpos(lower(c.plain_text),$%d)>0 OR strpos(lower(c.intent),$%d)>0 OR strpos(lower(c.original_url),$%d)>0)`, title, n, n, n, n))
	}
	args = append(args, limit+1)
	query := collectionSelect + "WHERE " + strings.Join(where, " AND ") + fmt.Sprintf(" ORDER BY c.created_at DESC,c.id DESC LIMIT $%d", len(args))
	rows, err := s.Pool.Query(c.Request.Context(), query, args...)
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
		items = append(items, row)
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
