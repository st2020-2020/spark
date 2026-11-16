package entries

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"

	"spark/internal/ai"
	"spark/internal/model"
	"spark/internal/urltitle"
	"spark/internal/validation"
)

const selectColumns = "id,content,source,COALESCE(url,''),COALESCE(title,''),image_name IS NOT NULL,COALESCE(image_type,''),COALESCE(image_name,''),summary,tags,status,provider,version,created_at,updated_at"

type Service struct {
	db        *sql.DB
	mu        sync.Mutex
	active    map[string]struct{}
	onUpdated func(id string)
}

func NewService(db *sql.DB) *Service {
	return &Service{
		db:     db,
		active: make(map[string]struct{}),
	}
}

func (s *Service) SetOnUpdated(fn func(id string)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onUpdated = fn
}

func scanEntry(scanner interface{ Scan(...any) error }) (model.Entry, error) {
	var e model.Entry
	var srcStr, statusStr, tagsJSON string
	if err := scanner.Scan(
		&e.ID,
		&e.Content,
		&srcStr,
		&e.URL,
		&e.Title,
		&e.HasImage,
		&e.ImageType,
		&e.ImageName,
		&e.Summary,
		&tagsJSON,
		&statusStr,
		&e.Provider,
		&e.Version,
		&e.CreatedAt,
		&e.UpdatedAt,
	); err != nil {
		return model.Entry{}, err
	}
	e.Source = model.Source(srcStr)
	e.Status = model.Status(statusStr)
	if err := json.Unmarshal([]byte(tagsJSON), &e.Tags); err != nil {
		e.Tags = nil
	}
	if e.Tags == nil {
		e.Tags = []string{}
	}
	return e, nil
}

func (s *Service) ListEntries() ([]model.Entry, error) {
	rows, err := s.db.Query("SELECT " + selectColumns + " FROM entries ORDER BY created_at DESC, rowid DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []model.Entry
	for rows.Next() {
		entry, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, entry)
	}
	return list, rows.Err()
}

func (s *Service) GetEntry(id string) (model.Entry, bool, error) {
	row := s.db.QueryRow("SELECT "+selectColumns+" FROM entries WHERE id=?", id)
	entry, err := scanEntry(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Entry{}, false, nil
	}
	if err != nil {
		return model.Entry{}, false, err
	}
	return entry, true, nil
}

func (s *Service) GetEntryImage(id string) (data []byte, mimeType string, ok bool, err error) {
	var raw []byte
	var typ sql.NullString
	err = s.db.QueryRow("SELECT image, image_type FROM entries WHERE id=?", id).Scan(&raw, &typ)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", false, nil
	}
	if err != nil {
		return nil, "", false, err
	}
	if len(raw) == 0 {
		return nil, "", false, nil
	}
	return raw, typ.String, true, nil
}

func (s *Service) CreateEntry(content string, image *model.ImagePayload) (model.Entry, error) {
	clean, err := validation.ValidateContent(content, image != nil)
	if err != nil {
		return model.Entry{}, err
	}

	var imgData []byte
	var imgType, imgName sql.NullString
	if image != nil {
		mimeType, cleanName, err := validation.ValidateImage(image.Data, image.Name)
		if err != nil {
			return model.Entry{}, err
		}
		imgData = image.Data
		imgType = sql.NullString{String: mimeType, Valid: true}
		imgName = sql.NullString{String: cleanName, Valid: true}
	}

	id := uuid.NewString()
	extractedURL := validation.ExtractURL(clean)
	var urlVal sql.NullString
	if extractedURL != "" {
		urlVal = sql.NullString{String: extractedURL, Valid: true}
	}

	src := model.SourceText
	if image != nil {
		src = model.SourceImage
	} else if extractedURL != "" {
		src = model.SourceURL
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.Exec(
		`INSERT INTO entries (id, content, source, url, image, image_type, image_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
		id, clean, string(src), urlVal, imgData, imgType, imgName, now, now,
	)
	if err != nil {
		return model.Entry{}, err
	}

	entry, _, err := s.GetEntry(id)
	return entry, err
}

func (s *Service) UpdateEntry(id string, content string, version int) (model.Entry, error) {
	existing, found, err := s.GetEntry(id)
	if err != nil {
		return model.Entry{}, err
	}
	if !found {
		return model.Entry{}, validation.NewInputError("这条记录不存在或已被删除。", 404)
	}

	clean, err := validation.ValidateContent(content, existing.HasImage)
	if err != nil {
		return model.Entry{}, err
	}

	extractedURL := validation.ExtractURL(clean)
	var urlVal sql.NullString
	if extractedURL != "" {
		urlVal = sql.NullString{String: extractedURL, Valid: true}
	}

	src := model.SourceText
	if existing.HasImage {
		src = model.SourceImage
	} else if extractedURL != "" {
		src = model.SourceURL
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.db.Exec(
		`UPDATE entries SET content=?, url=?, source=?, title=NULL, summary='', tags='[]', status='pending', version=version+1, updated_at=? WHERE id=? AND version=?`,
		clean, urlVal, string(src), now, id, version,
	)
	if err != nil {
		return model.Entry{}, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return model.Entry{}, err
	}
	if affected == 0 {
		return model.Entry{}, validation.NewInputError("记录已在其他位置更新，请刷新后再编辑。当前输入仍保留。", 409)
	}

	updated, _, err := s.GetEntry(id)
	return updated, err
}

func (s *Service) DeleteEntry(id string) error {
	res, err := s.db.Exec("DELETE FROM entries WHERE id=?", id)
	if err != nil {
		return err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return validation.NewInputError("这条记录不存在或已被删除。", 404)
	}
	return nil
}

func (s *Service) EnrichEntry(ctx context.Context, id string) {
	s.mu.Lock()
	if _, running := s.active[id]; running {
		s.mu.Unlock()
		return
	}
	s.active[id] = struct{}{}
	cb := s.onUpdated
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.active, id)
		s.mu.Unlock()
	}()

	entry, found, err := s.GetEntry(id)
	if err != nil || !found || entry.Status != model.StatusPending {
		return
	}

	var fetchedTitle string
	if entry.URL != "" {
		fetchedTitle = urltitle.FetchURLTitle(ctx, entry.URL)
	}
	if ctx.Err() != nil {
		return
	}

	result := ai.Organize(ctx, ai.OrganizeInput{
		Content:   entry.Content,
		Title:     fetchedTitle,
		Source:    entry.Source,
		ImageName: entry.ImageName,
	})
	tagsJSON, _ := json.Marshal(result.Tags)
	var titleVal sql.NullString
	if fetchedTitle != "" {
		titleVal = sql.NullString{String: fetchedTitle, Valid: true}
	}

	res, err := s.db.Exec(
		`UPDATE entries SET title=?, summary=?, tags=?, status=?, provider=? WHERE id=? AND version=? AND status='pending'`,
		titleVal, result.Summary, string(tagsJSON), string(result.Status), result.Provider, id, entry.Version,
	)
	if err != nil {
		return
	}
	if affected, _ := res.RowsAffected(); affected > 0 && cb != nil {
		cb(id)
	}
}

func (s *Service) ResumePending(ctx context.Context) {
	rows, err := s.db.Query("SELECT id FROM entries WHERE status='pending' ORDER BY created_at DESC")
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	if len(ids) == 0 {
		return
	}

	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(entryID string) {
			defer wg.Done()
			defer func() { <-sem }()
			s.EnrichEntry(ctx, entryID)
		}(id)
	}
	wg.Wait()
}
