package store

import (
	"database/sql"
	"encoding/json"
	"errors"
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
			summary_json=excluded.summary_json`)
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
	if errors.Is(err, sql.ErrNoRows) || raw == "" {
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
	ID           string `json:"id"`
	Source       string `json:"source"` // "cache" | "outbox"
	SyncState    string `json:"sync_state"`
	DisplayTitle string `json:"display_title"`
	Snippet      string `json:"snippet"`
	OriginalURL  string `json:"original_url,omitempty"`
	PrimaryType  string `json:"primary_type"`
	CreatedAt    string `json:"created_at"`
}

// SearchLocal performs instant offline substring search across account-scoped outbox + cached collections.
func (s *Store) SearchLocal(accountID, query string, limit int) ([]LocalSearchHit, error) {
	if accountID == "" {
		return []LocalSearchHit{}, nil
	}
	if limit <= 0 {
		limit = 20
	}
	tokens := strings.Fields(strings.ToLower(strings.TrimSpace(query)))

	hits := make([]LocalSearchHit, 0, limit)
	seen := make(map[string]struct{})

	// 1. Search local unsynced/review outbox items first so fresh captures show up immediately.
	outboxItems, err := s.ListOutbox(accountID, 100)
	if err == nil {
		for _, item := range outboxItems {
			if item.State == OutboxSynced {
				continue
			}
			hay := strings.ToLower(strings.Join([]string{item.ManualTitle, item.RawText, item.Intent, item.OriginalURL}, " "))
			if !matchesAllTokens(hay, tokens) {
				continue
			}
			title := item.ManualTitle
			if title == "" {
				title = firstLine(item.RawText, 48)
			}
			if title == "" && item.OriginalURL != "" {
				title = item.OriginalURL
			}
			if title == "" && len(item.Attachments) > 0 {
				title = item.Attachments[0].Filename
			}
			pType := "text"
			if len(item.Attachments) > 0 {
				pType = "image"
			} else if item.OriginalURL != "" {
				pType = "url"
			}
			hits = append(hits, LocalSearchHit{
				ID:           item.ID,
				Source:       "outbox",
				SyncState:    string(item.State),
				DisplayTitle: title,
				Snippet:      firstLine(item.RawText, 120),
				OriginalURL:  item.OriginalURL,
				PrimaryType:  pType,
				CreatedAt:    item.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
			seen[item.ID] = struct{}{}
			if len(hits) >= limit {
				return hits, nil
			}
		}
	}

	// 2. Search cached remote collections.
	rows, err := s.db.Query(`
		SELECT id, display_title, plain_text, original_url, primary_type, created_at, searchable_text
		FROM cached_collections WHERE account_id=? ORDER BY created_at DESC LIMIT 500`, accountID)
	if err != nil {
		return hits, err
	}
	defer rows.Close()

	for rows.Next() {
		var id, title, plain, origURL, pType, createdAt, searchable string
		if err := rows.Scan(&id, &title, &plain, &origURL, &pType, &createdAt, &searchable); err != nil {
			return hits, err
		}
		if _, ok := seen[id]; ok {
			continue
		}
		if !matchesAllTokens(searchable, tokens) {
			continue
		}
		if title == "" {
			title = firstLine(plain, 48)
		}
		hits = append(hits, LocalSearchHit{
			ID:           id,
			Source:       "cache",
			SyncState:    "synced",
			DisplayTitle: title,
			Snippet:      firstLine(plain, 120),
			OriginalURL:  origURL,
			PrimaryType:  pType,
			CreatedAt:    createdAt,
		})
		if len(hits) >= limit {
			break
		}
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

func matchesAllTokens(haystack string, tokens []string) bool {
	for _, tok := range tokens {
		if !strings.Contains(haystack, tok) {
			return false
		}
	}
	return true
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
