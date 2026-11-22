package backend

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func validateOrganizationTags(input textInput, candidates []modelTag, validEvidence func([]modelEvidence, bool) bool) ([]modelTag, bool) {
	if !input.tagConsent {
		return candidates, len(candidates) == 0
	}
	offered := make(map[string]string, len(input.Tags))
	for _, tag := range input.Tags {
		offered[tag.ID] = tag.Name
	}
	seen := make(map[string]bool, len(candidates))
	accepted := make([]modelTag, 0, len(candidates))
	for _, tag := range candidates {
		if tag.ID == "" && !input.createTags {
			continue
		}
		if tag.ID != "" {
			if name, ok := offered[tag.ID]; !ok || name != tag.Name {
				return nil, false
			}
		} else {
			name, err := tagName(tag.Name)
			if err != nil {
				return nil, false
			}
			tag.Name = name
			if len(tag.Evidence) == 0 {
				found := false
				key := tagKey(name)
				for _, source := range input.Sources {
					if strings.Contains(tagKey(source.Text), key) {
						found = true
						break
					}
				}
				if !found {
					return nil, false
				}
			}
		}
		key := tagKey(tag.Name)
		if seen[key] || len(tag.Evidence) > 0 && !validEvidence(tag.Evidence, false) {
			return nil, false
		}
		seen[key] = true
		accepted = append(accepted, tag)
	}
	return accepted, true
}

// Completion holds the account change lock. Resolve names against the complete
// account catalog and reconcile only machine-owned associations.
func applyOrganizationTags(ctx context.Context, tx pgx.Tx, r runSnapshot, candidates []modelTag) (bool, error) {
	desired := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		var id string
		var err error
		if candidate.ID == "" {
			key := tagKey(candidate.Name)
			if _, err := tx.Exec(ctx, `INSERT INTO tags(id,user_id,name,normalized_name) VALUES($1,$2,$3,$4)
				ON CONFLICT (user_id,normalized_name) DO NOTHING`, uuid.NewString(), r.UID, candidate.Name, key); err != nil {
				return false, err
			}
			err = tx.QueryRow(ctx, `SELECT id FROM tags WHERE user_id=$1 AND normalized_name=$2`, r.UID, key).Scan(&id)
		} else {
			// The tag may have changed while the network call was in flight.
			err = tx.QueryRow(ctx, `SELECT id FROM tags WHERE user_id=$1 AND id=$2 AND name=$3`,
				r.UID, candidate.ID, candidate.Name).Scan(&id)
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
		}
		if err != nil {
			return false, err
		}
		desired = append(desired, id)
	}
	removed, err := tx.Exec(ctx, `DELETE FROM collection_tags WHERE user_id=$1 AND collection_id=$2 AND decision='auto'
		AND NOT (tag_id::text=ANY($3::text[]))`, r.UID, r.CollectionID, desired)
	if err != nil {
		return false, err
	}
	changed := removed.RowsAffected() > 0
	for _, id := range desired {
		applied, err := tx.Exec(ctx, `INSERT INTO collection_tags(user_id,collection_id,tag_id,decision,run_id)
			VALUES($1,$2,$3,'auto',$4) ON CONFLICT (collection_id,tag_id) DO NOTHING`, r.UID, r.CollectionID, id, r.ID)
		if err != nil {
			return false, err
		}
		changed = changed || applied.RowsAffected() > 0
	}
	return changed, nil
}
