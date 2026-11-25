package backend

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"
)

const maxAutomaticTopicChars = 12

func normalizeModelTopic(raw string) string {
	name := strings.Join(strings.Fields(norm.NFKC.String(raw)), " ")
	if strings.ContainsFunc(name, unicode.IsControl) {
		return ""
	}
	return name
}

// The run holds the account change lock. Check the latest human choices and
// the full account topic index before saving an automatic association.
func applyAutomaticProject(ctx context.Context, tx pgx.Tx, r runSnapshot, input textInput, result *organizationResult) (string, bool, error) {
	if len(result.Projects) == 0 && result.Topic == nil {
		return "", false, nil
	}
	var version int64
	var assigned, rejected bool
	if err := tx.QueryRow(ctx, `SELECT c.decision_version,
		EXISTS(SELECT 1 FROM collection_projects cp WHERE (cp.user_id,cp.collection_id)=(c.user_id,c.id)
		 AND cp.decision IN ('manual','confirmed','auto')),
		EXISTS(SELECT 1 FROM collection_projects cp WHERE (cp.user_id,cp.collection_id)=(c.user_id,c.id) AND cp.decision='rejected')
		FROM collections c WHERE c.user_id=$1 AND c.id=$2`, r.UID, r.CollectionID).
		Scan(&version, &assigned, &rejected); err != nil {
		return "", false, err
	}
	if assigned || version != input.decisionVersion {
		return "", false, nil
	}

	var project, reason string
	var projectVersion int64
	var evidence []modelEvidence
	archive := "linked"
	if len(result.Projects) != 0 {
		selected := result.Projects[0]
		project, reason, evidence = selected.ID, selected.Reason, selected.Evidence
		for _, p := range input.Projects {
			if p.ID == project {
				projectVersion = p.Version
				break
			}
		}
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE user_id=$1 AND id=$2 AND version=$3 AND state='active')`,
			r.UID, project, projectVersion).Scan(&active); err != nil {
			return "", false, err
		}
		if !active {
			return "", true, nil
		}
	} else {
		topic := result.Topic
		reason, evidence = topic.Reason, topic.Evidence
		name := normalizeModelTopic(topic.Name)
		if name == "" || utf8.RuneCountInString(name) > 100 {
			result.Topic, result.rejectedTopic = nil, true
			return "", false, nil
		}
		var state string
		var excluded bool
		err := tx.QueryRow(ctx, `SELECT p.id,p.version,p.state,
			EXISTS(SELECT 1 FROM collection_projects cp JOIN projects rejected ON (rejected.user_id,rejected.id)=(cp.user_id,cp.project_id)
			  WHERE cp.user_id=$1 AND cp.collection_id=$3 AND cp.decision='rejected'
			   AND spark_project_topic(rejected.name)=spark_project_topic($2::text))
			FROM projects p WHERE p.user_id=$1 AND spark_project_topic(p.name)=spark_project_topic($2::text)
			ORDER BY (p.state='active') DESC,p.updated_at DESC,p.id LIMIT 1`, r.UID, name, r.CollectionID).
			Scan(&project, &projectVersion, &state, &excluded)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if utf8.RuneCountInString(name) > maxAutomaticTopicChars {
				result.Topic, result.rejectedTopic = nil, true
				return "", false, nil
			}
			if rejected {
				return "", false, nil
			}
			// A model can echo a deleted or renamed candidate as a new
			// topic. Keep that stale snapshot from recreating the project.
			if len(input.Projects) > 0 {
				candidateNames := make([]string, 0, len(input.Projects))
				for _, candidate := range input.Projects {
					candidateNames = append(candidateNames, candidate.Name)
				}
				var stale bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS (
					SELECT 1 FROM unnest($1::text[]) AS candidate(name)
					WHERE spark_project_topic(candidate.name)=spark_project_topic($2))`,
					candidateNames, name).Scan(&stale); err != nil {
					return "", false, err
				}
				if stale {
					return "", true, nil
				}
			}
			project, projectVersion, archive = uuid.NewString(), 1, "created"
			if _, err := tx.Exec(ctx, `INSERT INTO projects(id,user_id,name,description,focus_points) VALUES($1,$2,$3,'','[]')`,
				project, r.UID, name); err != nil {
				return "", false, err
			}
			if err := record(ctx, tx, r.UID, "project", project, projectVersion); err != nil {
				return "", false, err
			}
		case err != nil:
			return "", false, err
		case state != "active" || excluded:
			return "", false, nil
		}
	}
	tag, err := tx.Exec(ctx, `INSERT INTO collection_projects(user_id,collection_id,project_id,decision,reason,evidence,project_version,run_id)
		VALUES($1,$2,$3,'auto',$4,$5,$6,$7)
		ON CONFLICT(collection_id,project_id) DO UPDATE SET decision='auto',reason=excluded.reason,evidence=excluded.evidence,
		project_version=excluded.project_version,run_id=excluded.run_id,updated_at=now()
		WHERE collection_projects.decision='suggested'`, r.UID, r.CollectionID, project, reason, jsonBytes(evidence), projectVersion, r.ID)
	if err != nil || tag.RowsAffected() == 0 {
		return "", false, err
	}
	return archive, false, nil
}
