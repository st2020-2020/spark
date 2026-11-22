package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"spark/apps/desktop/internal/api"
)

// UpsertCachedCollections stores remote CollectionSummary items for accountID.
func (s *Store) UpsertCachedCollections(accountID string, items []api.CollectionSummary) error {
	if accountID == "" || len(items) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
		INSERT INTO cached_collections (
			account_id, id, display_title, plain_text, intent, original_url,
			primary_type, read_at, created_at, updated_at, searchable_text, summary_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, id) DO UPDATE SET
			display_title=excluded.display_title,
			plain_text=excluded.plain_text,
			intent=excluded.intent,
			original_url=excluded.original_url,
			primary_type=excluded.primary_type,
			read_at=excluded.read_at,
			created_at=excluded.created_at,
			updated_at=excluded.updated_at,
			searchable_text=excluded.searchable_text,
			summary_json=excluded.summary_json, detail_json=''
        WHERE cached_collections.detail_json='' OR cached_collections.updated_at!=excluded.updated_at`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, c := range items {
		raw, err := json.Marshal(c)
		if err != nil {
			return err
		}
		readAt := ""
		if c.ReadAt != nil {
			readAt = *c.ReadAt
		}
		searchable := buildSearchableSummary(c)
		if _, err := stmt.Exec(
			accountID, c.ID, c.DisplayTitle, c.PlainText, c.Intent, c.OriginalURL,
			c.PrimaryType, readAt, c.CreatedAt, c.UpdatedAt, searchable, string(raw),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpsertCachedCollectionDetail caches a full Collection detail and updates its summary projection.
func (s *Store) UpsertCachedCollectionDetail(accountID string, c api.Collection) error {
	if accountID == "" || c.ID == "" {
		return nil
	}
	if c.Document != nil {
		c.PlainText = c.Document.PlainText()
	}
	summary := api.CollectionSummary{
		ID:              c.ID,
		DisplayTitle:    c.DisplayTitle,
		ManualTitle:     c.ManualTitle,
		PlainText:       c.PlainText,
		Intent:          c.Intent,
		OriginalURL:     c.OriginalURL,
		PrimaryType:     c.PrimaryType,
		ReadAt:          c.ReadAt,
		DeletedAt:       c.DeletedAt,
		CreatedAt:       c.CreatedAt,
		UpdatedAt:       c.UpdatedAt,
		AttachmentCount: len(c.Attachments),
		Projects:        c.Projects,
		Tags:            c.Tags,
	}
	if len(c.Attachments) > 0 {
		summary.CoverAttachmentID = c.Attachments[0].ID
	}
	if c.Organization != nil {
		summary.OrganizationStatus = c.Organization.Status
	}
	sumJSON, err := json.Marshal(summary)
	if err != nil {
		return err
	}
	detJSON, err := json.Marshal(c)
	if err != nil {
		return err
	}
	readAt := ""
	if c.ReadAt != nil {
		readAt = *c.ReadAt
	}
	parts := []string{buildSearchableSummary(summary)}
	if c.Organization != nil {
		parts = append(parts, c.Organization.Title, c.Organization.Summary)
	}
	for _, note := range c.ImageNotes {
		parts = append(parts, note.Text)
	}
	searchable := strings.ToLower(strings.Join(parts, " "))

	_, err = s.db.Exec(`
		INSERT INTO cached_collections (
			account_id, id, display_title, plain_text, intent, original_url,
			primary_type, read_at, created_at, updated_at, searchable_text, summary_json, detail_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id, id) DO UPDATE SET
			display_title=excluded.display_title,
			plain_text=excluded.plain_text,
			intent=excluded.intent,
			original_url=excluded.original_url,
			primary_type=excluded.primary_type,
			read_at=excluded.read_at,
			created_at=excluded.created_at,
			updated_at=excluded.updated_at,
			searchable_text=excluded.searchable_text,
			summary_json=excluded.summary_json,
			detail_json=excluded.detail_json`,
		accountID, c.ID, c.DisplayTitle, c.PlainText, c.Intent, c.OriginalURL,
		c.PrimaryType, readAt, c.CreatedAt, c.UpdatedAt, searchable, string(sumJSON), string(detJSON))
	return err
}

func (s *Store) ListCachedCollections(accountID string, projectID string, limit int) ([]api.CollectionSummary, error) {
	if accountID == "" {
		return []api.CollectionSummary{}, nil
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`
		SELECT summary_json FROM cached_collections
		WHERE account_id=? ORDER BY created_at DESC LIMIT ?`, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]api.CollectionSummary, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var item api.CollectionSummary
		if json.Unmarshal([]byte(raw), &item) != nil {
			continue
		}
		if projectID != "" && !hasActiveProject(item.Projects, projectID) {
			continue
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) GetCachedCollectionDetail(accountID, id string) (api.Collection, bool, error) {
	var raw string
	err := s.db.QueryRow(`SELECT detail_json FROM cached_collections WHERE account_id=? AND id=?`, accountID, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && raw == "") {
		return api.Collection{}, false, nil
	}
	if err != nil {
		return api.Collection{}, false, err
	}
	var c api.Collection
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return api.Collection{}, false, err
	}
	return c, true, nil
}

// LocalSearchHit represents an instant local search match from cached collections or local outbox.
type LocalSearchHit struct {
	Projects     []api.ProjectAssociation `json:"projects,omitempty"`
	ID           string                   `json:"id"`
	Source       string                   `json:"source"` // "cache" | "outbox"
	SyncState    string                   `json:"sync_state"`
	DisplayTitle string                   `json:"display_title"`
	Snippet      string                   `json:"snippet"`
	OriginalURL  string                   `json:"original_url,omitempty"`
	PrimaryType  string                   `json:"primary_type"`
	CreatedAt    string                   `json:"created_at"`
}

// SearchLocal performs instant offline substring search across account-scoped outbox + cached collections.
func (s *Store) SearchLocal(accountID, query string, limit int) ([]LocalSearchHit, error) {
	if accountID == "" {
		return []LocalSearchHit{}, nil
	}
	if limit <= 0 {
		limit = 20
	}
	// Search before limiting: an older capture must still be findable after hundreds of newer captures.
	terms, err := json.Marshal(strings.Fields(strings.ToLower(query)))
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`
        WITH entries AS (
            SELECT id, 'outbox' AS source, state, manual_title AS title, raw_text AS plain,
                original_url, created_at, 0 AS rank,
                (SELECT filename FROM outbox_attachments a WHERE a.outbox_id=o.id ORDER BY ord LIMIT 1) AS filename,
                lower(manual_title||' '||raw_text||' '||intent||' '||original_url||' '||
                    COALESCE((SELECT group_concat(name,' ') FROM cached_projects p
                        WHERE p.account_id=o.account_id AND p.id IN (SELECT value FROM json_each(o.project_ids_json))), '')||' '||
                    COALESCE((SELECT group_concat(name,' ') FROM cached_tags t
                        WHERE t.account_id=o.account_id AND t.id IN (SELECT value FROM json_each(o.tag_ids_json))), '')) AS hay,
                '' AS kind, '[]' AS projects
            FROM outbox_items o WHERE account_id=? AND state!='synced'
            UNION ALL
            SELECT c.id, 'cache', 'synced', display_title, plain_text, original_url, created_at, 1,
                NULL, searchable_text, primary_type, COALESCE(json_extract(summary_json, '$.projects'), '[]') FROM cached_collections c
            WHERE account_id=? AND NOT EXISTS (SELECT 1 FROM outbox_items o WHERE o.id=c.id AND o.account_id=c.account_id AND o.state!='synced')
        )
        SELECT id,source,state,title,plain,original_url,created_at,COALESCE(filename,''),kind,projects FROM entries
        WHERE NOT EXISTS (SELECT 1 FROM json_each(?) WHERE instr(hay,value)=0)
        ORDER BY rank,created_at DESC,id LIMIT ?`, accountID, accountID, string(terms), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := make([]LocalSearchHit, 0)
	for rows.Next() {
		var hit LocalSearchHit
		var plain, filename, projects string
		if err := rows.Scan(&hit.ID, &hit.Source, &hit.SyncState, &hit.DisplayTitle, &plain, &hit.OriginalURL, &hit.CreatedAt, &filename, &hit.PrimaryType, &projects); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(projects), &hit.Projects); err != nil {
			return nil, fmt.Errorf("decode cached project associations: %w", err)
		}
		hit.Snippet = firstLine(plain, 120)
		if hit.DisplayTitle == "" {
			hit.DisplayTitle = firstLine(plain, 48)
		}
		if hit.DisplayTitle == "" {
			hit.DisplayTitle = hit.OriginalURL
		}
		if hit.DisplayTitle == "" {
			hit.DisplayTitle = filename
		}
		if hit.PrimaryType == "" {
			switch {
			case filename != "":
				hit.PrimaryType = "image"
			case hit.OriginalURL != "":
				hit.PrimaryType = "url"
			default:
				hit.PrimaryType = "text"
			}
		}
		hits = append(hits, hit)
	}
	return hits, rows.Err()
}

func (s *Store) ReplaceCachedProjects(accountID string, projects []api.Project) error {
	if accountID == "" {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM cached_projects WHERE account_id=?`, accountID); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`
		INSERT INTO cached_projects (account_id, id, name, description, state, collection_count, updated_at, raw_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range projects {
		raw, _ := json.Marshal(p)
		if _, err := stmt.Exec(accountID, p.ID, p.Name, p.Description, p.State, p.CollectionCount, p.UpdatedAt, string(raw)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ListCachedProjects(accountID string) ([]api.Project, error) {
	if accountID == "" {
		return []api.Project{}, nil
	}
	rows, err := s.db.Query(`SELECT raw_json FROM cached_projects WHERE account_id=? ORDER BY name ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]api.Project, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var p api.Project
		if json.Unmarshal([]byte(raw), &p) == nil {
			out = append(out, p)
		}
	}
	return out, rows.Err()
}

func (s *Store) ReplaceCachedTags(accountID string, tags []api.Tag) error {
	if accountID == "" {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM cached_tags WHERE account_id=?`, accountID); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO cached_tags (account_id, id, name, collection_count, raw_json) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, t := range tags {
		raw, _ := json.Marshal(t)
		if _, err := stmt.Exec(accountID, t.ID, t.Name, t.CollectionCount, string(raw)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ListCachedTags(accountID string) ([]api.Tag, error) {
	if accountID == "" {
		return []api.Tag{}, nil
	}
	rows, err := s.db.Query(`SELECT raw_json FROM cached_tags WHERE account_id=? ORDER BY collection_count DESC, name ASC`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]api.Tag, 0)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var t api.Tag
		if json.Unmarshal([]byte(raw), &t) == nil {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

func (s *Store) GetPref(key, fallback string) string {
	var val string
	if err := s.db.QueryRow(`SELECT value FROM local_prefs WHERE key=?`, key).Scan(&val); err != nil {
		return fallback
	}
	return val
}

func (s *Store) SetPref(key, value string) error {
	_, err := s.db.Exec(`
		INSERT INTO local_prefs (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func buildSearchableSummary(c api.CollectionSummary) string {
	parts := []string{c.DisplayTitle, c.ManualTitle, c.PlainText, c.Intent, c.OriginalURL}
	for _, p := range c.Projects {
		parts = append(parts, p.ProjectName)
	}
	for _, t := range c.Tags {
		parts = append(parts, t.TagName)
	}
	return strings.ToLower(strings.Join(parts, " "))
}

func hasActiveProject(list []api.ProjectAssociation, projectID string) bool {
	for _, p := range list {
		if p.ProjectID == projectID && (p.Decision == "manual" || p.Decision == "confirmed" || p.Decision == "auto") {
			return true
		}
	}
	return false
}

func firstLine(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		s = strings.TrimSpace(s[:idx])
	}
	runes := []rune(s)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]) + "…"
	}
	return s
}
