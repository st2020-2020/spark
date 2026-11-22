package api

import "time"

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type DesktopTokenResult struct {
	Token        string    `json:"token"`
	AccountID    string    `json:"account_id"`
	AccountLabel string    `json:"account_label"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// DesktopSession matches GET /api/v1/desktop/session 200 response.
type DesktopSession struct {
	AccountID    string    `json:"account_id"`
	AccountLabel string    `json:"account_label"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// SparkDocument matches contracts/document.schema.json (schema_version: 1).
type SparkDocument struct {
	SchemaVersion int          `json:"schema_version"`
	Content       DocumentRoot `json:"content"`
}

type DocumentRoot struct {
	Type    string      `json:"type"`
	Content []BlockNode `json:"content"`
}

type BlockNode struct {
	Type    string       `json:"type"`
	Content []InlineNode `json:"content,omitempty"`
}

type InlineNode struct {
	Content []InlineNode `json:"content,omitempty"`
	Type    string       `json:"type"`
	Text    string       `json:"text,omitempty"`
	Marks   []TextMark   `json:"marks,omitempty"`
}

type TextMark struct {
	Type  string         `json:"type"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// CollectionCreate matches POST /api/v1/collections request body.
// Desktop captures are standard collections (never impersonating extension capture_source).
type CollectionCreate struct {
	ID          string        `json:"id"`
	Document    SparkDocument `json:"document"`
	Intent      string        `json:"intent"`
	OriginalURL *string       `json:"original_url,omitempty"`
	ManualTitle *string       `json:"manual_title,omitempty"`
	UploadIDs   []string      `json:"upload_ids"`
	ProjectIDs  []string      `json:"project_ids"`
	TagIDs      []string      `json:"tag_ids"`
	AIExcluded  bool          `json:"ai_excluded"`
}

type Project struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	Focus           string `json:"focus,omitempty"`
	State           string `json:"state"`
	Version         int    `json:"version"`
	CollectionCount int    `json:"collection_count,omitempty"`
	CreatedAt       string `json:"created_at,omitempty"`
	UpdatedAt       string `json:"updated_at,omitempty"`
}

type ProjectPage struct {
	Items      []Project `json:"items"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type Tag struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Path            string `json:"path,omitempty"`
	CollectionCount int    `json:"collection_count,omitempty"`
}

type TagPage struct {
	Items      []Tag  `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type UploadRequest struct {
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type"`
	SizeBytes int    `json:"size_bytes"`
}

type UploadGrant struct {
	ID        string            `json:"id"`
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt time.Time         `json:"expires_at"`
}

type Upload struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	ExpiresAt time.Time `json:"expires_at"`
	SizeBytes *int      `json:"size_bytes,omitempty"`
	MimeType  *string   `json:"mime_type,omitempty"`
	ErrorCode *string   `json:"error_code,omitempty"`
}

type DownloadGrant struct {
	URL       string    `json:"url"`
	ExpiresAt time.Time `json:"expires_at"`
}

type Attachment struct {
	ID        string `json:"id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type"`
	SizeBytes int    `json:"size_bytes"`
	Order     int    `json:"position,omitempty"`
}

type ProjectAssociation struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"name,omitempty"`
	Decision    string `json:"decision"`
	Reason      string `json:"reason,omitempty"`
}

type TagAssociation struct {
	TagID    string `json:"tag_id"`
	TagName  string `json:"path,omitempty"`
	Decision string `json:"decision"`
}

type Organization struct {
	Status       string `json:"status,omitempty"`
	Title        string `json:"generated_title,omitempty"`
	Summary      string `json:"summary,omitempty"`
	ErrorCode    string `json:"error_code,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type ImageNote struct {
	AttachmentID string `json:"attachment_id"`
	Version      int    `json:"version"`
	State        string `json:"state"`
	Text         string `json:"text"`
}

type CollectionSummary struct {
	ID                 string               `json:"id"`
	DisplayTitle       string               `json:"display_title,omitempty"`
	ManualTitle        string               `json:"manual_title,omitempty"`
	PlainText          string               `json:"excerpt,omitempty"`
	CoverAttachmentID  string               `json:"cover_attachment_id,omitempty"`
	Intent             string               `json:"intent,omitempty"`
	OriginalURL        string               `json:"original_url,omitempty"`
	PrimaryType        string               `json:"primary_type,omitempty"`
	ReadAt             *string              `json:"read_at,omitempty"`
	DeletedAt          *string              `json:"deleted_at,omitempty"`
	CreatedAt          string               `json:"created_at"`
	UpdatedAt          string               `json:"updated_at"`
	AttachmentCount    int                  `json:"attachment_count,omitempty"`
	FollowUpCount      int                  `json:"follow_up_count,omitempty"`
	Projects           []ProjectAssociation `json:"projects,omitempty"`
	Tags               []TagAssociation     `json:"tags,omitempty"`
	OrganizationStatus string               `json:"organization_status,omitempty"`
}

type Collection struct {
	ID              string               `json:"id"`
	DisplayTitle    string               `json:"display_title,omitempty"`
	ManualTitle     string               `json:"manual_title,omitempty"`
	Document        *SparkDocument       `json:"document,omitempty"`
	PlainText       string               `json:"plain_text,omitempty"`
	Intent          string               `json:"intent,omitempty"`
	OriginalURL     string               `json:"original_url,omitempty"`
	PrimaryType     string               `json:"primary_type,omitempty"`
	ReadAt          *string              `json:"read_at,omitempty"`
	DeletedAt       *string              `json:"deleted_at,omitempty"`
	ContentVersion  int                  `json:"content_version,omitempty"`
	DecisionVersion int                  `json:"decision_version,omitempty"`
	ResourceVersion int                  `json:"resource_version,omitempty"`
	CreatedAt       string               `json:"created_at"`
	UpdatedAt       string               `json:"updated_at"`
	Attachments     []Attachment         `json:"attachments,omitempty"`
	Projects        []ProjectAssociation `json:"projects,omitempty"`
	Tags            []TagAssociation     `json:"tags,omitempty"`
	Organization    *Organization        `json:"organization,omitempty"`
	ImageNotes      []ImageNote          `json:"image_notes,omitempty"`
}

type CollectionPage struct {
	Items      []CollectionSummary `json:"items"`
	NextCursor string              `json:"next_cursor,omitempty"`
}

type SearchHit struct {
	Collection CollectionSummary `json:"collection"`
	Snippets   []struct {
		Field string `json:"field"`
		Text  string `json:"text"`
	} `json:"snippets"`
}

type SearchPage struct {
	Items      []SearchHit `json:"items"`
	NextCursor string      `json:"next_cursor,omitempty"`
}
