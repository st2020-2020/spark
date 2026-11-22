package backend

import (
	"context"
	"slices"
	"strings"
	"time"
)

const (
	textImageConsentVersion      = "spark-ai-image-material-v1"
	textImageNotesConsentVersion = "spark-ai-image-notes-v1"
	textImageTagsConsentVersion  = "spark-ai-image-notes-v2"
	organizationImagePoll        = 2 * time.Second
)

func allowsTextImageMaterial(consent string) bool {
	return consent == textImageConsentVersion || allowsImageArchive(consent)
}

func allowsImageArchive(consent string) bool {
	return consent == textImageNotesConsentVersion || consent == textImageTagsConsentVersion || allowsWebArchive(consent)
}

type ImageOrganizationScope struct {
	Enabled bool
	AdminID string
}

func (s ImageOrganizationScope) allows(uid, role string) bool {
	return s.Enabled && (s.AdminID == "" || s.AdminID == uid && role == "admin")
}

type imageSourceRef struct {
	ExtractionID   string
	ContentVersion int64
	PolicyVersion  int64
}

func (s ImageOrganizationScope) candidates(ctx context.Context, q querier, uid, collection, role string, archive bool) (available, pending bool, err error) {
	if !s.allows(uid, role) {
		return false, false, nil
	}
	if archive {
		sources, pending, err := s.sources(ctx, q, uid, collection, true)
		return len(sources) > 0 || pending, pending, err
	}
	err = q.QueryRow(ctx, `SELECT count(*)>0,coalesce(bool_or(status IN ('queued','running')),false)
		FROM organization_image_materials WHERE user_id=$1 AND collection_id=$2`, uid, collection).
		Scan(&available, &pending)
	return available, pending, err
}

func (s ImageOrganizationScope) sources(ctx context.Context, q querier, uid, collection string, archive bool) ([]textSource, bool, error) {
	if !s.Enabled || s.AdminID != "" && s.AdminID != uid {
		return nil, false, nil
	}
	rows, err := q.Query(ctx, `SELECT m.extraction_id,m.attachment_id,m.content_version,m.image_user_policy_version,m.status,
		m.recognized_text,CASE WHEN $4 AND n.state IN ('edited','removed') THEN '' ELSE m.description END
		FROM organization_image_materials m
		LEFT JOIN collection_image_notes n ON (n.user_id,n.attachment_id)=(m.user_id,m.attachment_id)
		WHERE m.user_id=$1 AND m.collection_id=$2 AND ($3::text='' OR m.role='admin')
		ORDER BY m.position,m.attachment_id`, uid, collection, s.AdminID, archive)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var pending bool
	var sources []textSource
	for rows.Next() {
		var ref imageSourceRef
		var attachment, state, text, description string
		if err := rows.Scan(&ref.ExtractionID, &attachment, &ref.ContentVersion, &ref.PolicyVersion, &state, &text, &description); err != nil {
			return nil, false, err
		}
		if state == "queued" || state == "running" {
			pending = true
			continue
		}
		if text = strings.TrimSpace(text); text != "" {
			sources = append(sources, textSource{ID: "image_text:" + attachment, Text: text, image: ref})
		}
		if description = strings.TrimSpace(description); description != "" {
			sources = append(sources, textSource{ID: "image_description:" + attachment, Text: description, image: ref})
		}
	}
	return sources, pending, rows.Err()
}

func (i textInput) imagePolicyVersion() int64 {
	for _, src := range i.Sources {
		if src.image.ExtractionID != "" {
			return src.image.PolicyVersion
		}
	}
	return 0
}

// An OCR excerpt and a description can have the same extraction ID. Keep
// their identities distinct so removing one changes the actual input set.
func imageMaterialKeys(sources []textSource) []string {
	ids := make([]string, 0, len(sources))
	for _, source := range sources {
		if source.image.ExtractionID != "" {
			ids = append(ids, source.ID+":"+source.image.ExtractionID)
		}
	}
	slices.Sort(ids)
	return slices.Compact(ids)
}

// Re-check the actual submitted prefixes and extraction identity, not a
// collection-wide image flag. No raw object information enters this path.
func (s ImageOrganizationScope) stillValid(ctx context.Context, q querier, run runSnapshot, sent textInput) (bool, error) {
	if sent.imagePolicyVersion() == 0 {
		return true, nil
	}
	current, _, err := s.sources(ctx, q, run.UID, run.CollectionID, sent.imageArchiveConsent)
	if err != nil {
		return false, err
	}
	byID := make(map[string]textSource, len(current))
	for _, source := range current {
		byID[source.ID] = source
	}
	for _, source := range sent.Sources {
		if source.image.ExtractionID == "" {
			continue
		}
		ref := byID[source.ID]
		if ref.image != source.image || !strings.HasPrefix(ref.Text, source.Text) {
			return false, nil
		}
	}
	return true, nil
}

func boundedOrganizationSources(text, intent string, images []textSource, limit int) []textSource {
	ownLimit := limit
	if len(images) > 0 {
		ownLimit = limit / 2
	}
	intent = shortText(intent, ownLimit/4)
	text = shortText(text, ownLimit-len([]rune(intent)))
	out := []textSource{{ID: "original_text", Text: text}, {ID: "intent", Text: intent}}
	budget := limit - len([]rune(text)) - len([]rune(intent))
	for i, img := range images {
		img.Text = shortText(img.Text, budget/(len(images)-i))
		budget -= len([]rune(img.Text))
		out = append(out, img)
	}
	return out
}
