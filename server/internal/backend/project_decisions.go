package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

type projectDecision struct {
	Decision       string          `json:"decision"`
	Reason         *string         `json:"reason,omitempty"`
	Evidence       json.RawMessage `json:"evidence"`
	ProjectVersion *int            `json:"project_version,omitempty"`
	RunID          *string         `json:"run_id,omitempty"`
}

type decisionTarget struct {
	version              int
	restorableSuggestion bool
	suggested            bool
	association          *projectDecision
}

type projectDecisionChange struct {
	ProjectID string           `json:"project_id"`
	Version   int              `json:"version"`
	Before    *projectDecision `json:"before"`
	After     *projectDecision `json:"after"`
}

type storedProjectUndo struct {
	ContentVersion  int                     `json:"content_version"`
	DecisionVersion int                     `json:"decision_version"`
	Changes         []projectDecisionChange `json:"changes"`
	Response        *contract.Collection    `json:"response,omitempty"`
}

func (s *Server) projectDecisions(c *gin.Context) (any, error) {
	req, err := bind[contract.AssociationUpdate](s, c)
	if err != nil {
		return nil, err
	}
	seen := make(map[uuid.UUID]bool, len(req.Operations))
	for _, op := range req.Operations {
		if seen[op.Id] {
			return nil, problem(422, "validation_failed", "一次操作不能重复指定同一项目。")
		}
		seen[op.Id] = true
	}
	key := c.GetHeader("Idempotency-Key")
	if key != "" {
		return s.idempotentWithReplay(c, req, 200, func(tx pgx.Tx) (any, error) {
			result, err := s.applyProjectDecisions(c, tx, req, key)
			if err == nil && result.UndoReceipt == nil {
				return idempotentCurrentResponse{body: result}, nil
			}
			return result, err
		}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
			row, err := s.loadCollection(c.Request.Context(), tx, current(c).User.ID, c.Param("id"))
			if err != nil {
				return nil, err
			}
			if err = checkActive(row); err != nil {
				return nil, err
			}
			if string(response) == idempotentCurrentMarker {
				return row.Collection, nil
			}
			return s.replayCollectionProjects(c.Request.Context(), tx, current(c).User.ID, c.Param("id"), response)
		})
	}
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	defer tx.Rollback(ctx)
	result, err := s.applyProjectDecisions(c, tx, req, "")
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) applyProjectDecisions(c *gin.Context, tx pgx.Tx, req contract.AssociationUpdate, key string) (contract.Collection, error) {
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return contract.Collection{}, err
	}
	if err = checkActive(row); err != nil {
		return contract.Collection{}, err
	}
	if row.DecisionVersion != req.BaseDecisionVersion {
		return contract.Collection{}, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
	}

	ids := make([]uuid.UUID, 0, len(req.Operations))
	for _, op := range req.Operations {
		ids = append(ids, op.Id)
	}
	targets, err := loadDecisionTargets(ctx, tx, uid, id, ids)
	if err != nil {
		return contract.Collection{}, err
	}
	changes := make([]projectDecisionChange, 0, len(ids))
	for _, op := range req.Operations {
		target, ok := targets[op.Id]
		if !ok {
			return contract.Collection{}, notFound
		}
		before := target.association
		if expected := op.ExpectedSuggestion; expected != nil {
			if !target.suggested || !target.restorableSuggestion || expected.RunId.String() != value(before.RunID) || expected.ProjectVersion != value(before.ProjectVersion) {
				return contract.Collection{}, suggestionConflict()
			}
		}
		currentDecision := ""
		if before != nil {
			currentDecision = before.Decision
		}
		if currentDecision == "suggested" && !target.suggested {
			// The collection view hides stale suggestions. Preserve legacy
			// manual selection, while keyed submissions require valid input.
			if key != "" {
				return contract.Collection{}, suggestionConflict()
			}
			currentDecision = ""
		}
		after, changed := nextProjectDecision(before, currentDecision, string(op.Action))
		if changed {
			changes = append(changes, projectDecisionChange{ProjectID: op.Id.String(), Version: target.version, Before: before, After: after})
		}
	}
	if len(changes) == 0 {
		return row.Collection, nil
	}
	for _, change := range changes {
		if err := writeProjectDecision(ctx, tx, uid, id, change.ProjectID, change.After); err != nil {
			return contract.Collection{}, err
		}
	}
	result, err := s.finishCollectionDecisions(ctx, tx, uid, id)
	if err != nil || key == "" {
		return result, err
	}
	receipt := storedProjectUndo{ContentVersion: row.ContentVersion, DecisionVersion: result.DecisionVersion, Changes: changes}
	requestDigest := c.MustGet("request_digest").([]byte) // bind validated and canonicalized the original request.
	expires, err := storeProjectUndo(ctx, tx, uid, id, key, requestDigest, receipt)
	if err != nil {
		return contract.Collection{}, err
	}
	result.UndoReceipt = &contract.ProjectUndoReceipt{OperationKey: key, DecisionVersion: result.DecisionVersion, ExpiresAt: expires}
	return result, nil
}

func nextManualDecision(current, action string) (string, bool) {
	if action == "reset" {
		return "", current == "manual" || current == "confirmed" || current == "rejected"
	}
	decision := "manual"
	switch {
	case action == "exclude":
		decision = "rejected"
	case current == "auto" || current == "suggested" || current == "confirmed":
		decision = "confirmed"
	}
	return decision, decision != current
}

func nextProjectDecision(before *projectDecision, current, action string) (*projectDecision, bool) {
	decision, changed := nextManualDecision(current, action)
	if decision == "" {
		return nil, changed
	}
	if !changed {
		return before, false
	}
	after := projectDecision{Evidence: json.RawMessage(`[]`)}
	if before != nil {
		after = *before
	}
	after.Decision = decision
	return &after, true
}

func loadDecisionTargets(ctx context.Context, tx pgx.Tx, uid, id string, projects []uuid.UUID) (map[uuid.UUID]decisionTarget, error) {
	rows, err := tx.Query(ctx, `
		SELECT p.id,p.version,
			p.state='active' AND EXISTS (
				SELECT 1 FROM organization_runs r
				JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
				WHERE r.user_id=p.user_id AND r.collection_id=$2 AND r.id=cp.run_id AND r.content_version=c.content_version
				AND r.status IN ('succeeded','partial') AND r.applied_at IS NOT NULL
				AND (r.image_user_policy_version IS NULL OR EXISTS (SELECT 1 FROM organization_current_image_runs ir
					WHERE (ir.user_id,ir.run_id)=(r.user_id,r.id)))
				AND NOT EXISTS (SELECT 1 FROM organization_current oc
					WHERE (oc.user_id,oc.collection_id,oc.content_version)=(r.user_id,r.collection_id,r.content_version)
					AND oc.run_id<>r.id)
			),cp.decision,cp.reason,
			COALESCE(cp.evidence,'[]'::jsonb),cp.project_version,cp.run_id,
			EXISTS(SELECT 1 FROM organization_pending_suggestions v
			       WHERE v.user_id=p.user_id AND v.collection_id=$2 AND v.project_id=p.id)
		FROM projects p LEFT JOIN collection_projects cp
		  ON cp.user_id=p.user_id AND cp.project_id=p.id AND cp.collection_id=$2
		WHERE p.user_id=$1 AND p.id=ANY($3::uuid[])`, uid, id, projects)
	if err != nil {
		return nil, fmt.Errorf("query project decisions: %w", err)
	}
	defer rows.Close()
	targets := make(map[uuid.UUID]decisionTarget, len(projects))
	for rows.Next() {
		var projectID uuid.UUID
		var decision *string
		var target decisionTarget
		var association projectDecision
		if err = rows.Scan(&projectID, &target.version, &target.restorableSuggestion, &decision, &association.Reason,
			&association.Evidence, &association.ProjectVersion, &association.RunID, &target.suggested); err != nil {
			return nil, fmt.Errorf("read project decision: %w", err)
		}
		if decision != nil {
			association.Decision = *decision
			target.association = &association
		}
		targets[projectID] = target
	}
	return targets, rows.Err()
}

func writeProjectDecision(ctx context.Context, tx pgx.Tx, uid, id, projectID string, decision *projectDecision) error {
	if decision == nil {
		_, err := tx.Exec(ctx, `DELETE FROM collection_projects WHERE user_id=$1 AND collection_id=$2 AND project_id=$3`, uid, id, projectID)
		return err
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO collection_projects(user_id,collection_id,project_id,decision,reason,evidence,project_version,run_id)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT(collection_id,project_id) DO UPDATE SET decision=excluded.decision,
			reason=excluded.reason,evidence=excluded.evidence,project_version=excluded.project_version,
			run_id=excluded.run_id,updated_at=now()
		WHERE collection_projects.user_id=excluded.user_id`,
		uid, id, projectID, decision.Decision, decision.Reason, decision.Evidence, decision.ProjectVersion, decision.RunID)
	return err
}

func (s *Server) finishCollectionDecisions(ctx context.Context, tx pgx.Tx, uid, id string) (contract.Collection, error) {
	var version int64
	if err := tx.QueryRow(ctx, `UPDATE collections SET decision_version=decision_version+1,
		resource_version=resource_version+1,updated_at=now() WHERE user_id=$1 AND id=$2
		RETURNING resource_version`, uid, id).Scan(&version); err != nil {
		return contract.Collection{}, err
	}
	if err := record(ctx, tx, uid, "collection", id, version); err != nil {
		return contract.Collection{}, err
	}
	row, err := s.loadCollection(ctx, tx, uid, id)
	return row.Collection, err
}

func suggestionConflict() error {
	return problem(409, "suggestion_conflict", "项目建议已变化，请刷新后再操作。")
}

func projectUndoNamespace(id string) string { return "triage_undo_receipt:" + id }

func (s *Server) undoProjectDecisions(c *gin.Context) (any, error) {
	req, err := bind[contract.UndoProjectDecision](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	tx, err := s.userTx(c)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	row, err := s.loadCollection(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	if err = checkActive(row); err != nil {
		return nil, err
	}
	var payload []byte
	err = tx.QueryRow(ctx, `SELECT response_json FROM idempotency_keys
		WHERE user_id=$1 AND operation=$2 AND key=$3 AND expires_at>now()`,
		uid, projectUndoNamespace(id), req.OperationKey).Scan(&payload)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem(409, "undo_unavailable", "撤销回执已失效，请刷新收藏。")
	}
	if err != nil {
		return nil, err
	}
	var receipt storedProjectUndo
	if err = json.Unmarshal(payload, &receipt); err != nil {
		return nil, fmt.Errorf("decode project undo receipt: %w", err)
	}
	if req.BaseDecisionVersion != receipt.DecisionVersion {
		return nil, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
	}
	if receipt.Response != nil {
		result, err := s.replayCollectionProjects(ctx, tx, uid, id, jsonBytes(receipt.Response))
		if err != nil {
			return nil, err
		}
		c.Header("Idempotent-Replayed", "true")
		return result, nil
	}
	if row.DecisionVersion != receipt.DecisionVersion {
		return nil, conflict("decision_conflict", "current_decision_version", int64(row.DecisionVersion))
	}
	if row.ContentVersion != receipt.ContentVersion {
		return nil, suggestionConflict()
	}
	if err = validateProjectUndo(ctx, tx, uid, id, receipt); err != nil {
		return nil, err
	}
	for _, change := range receipt.Changes {
		if err = writeProjectDecision(ctx, tx, uid, id, change.ProjectID, change.Before); err != nil {
			return nil, err
		}
	}
	result, err := s.finishCollectionDecisions(ctx, tx, uid, id)
	if err != nil {
		return nil, err
	}
	receipt.Response = &result
	if _, err = tx.Exec(ctx, `UPDATE idempotency_keys SET response_json=$4
		WHERE user_id=$1 AND operation=$2 AND key=$3`, uid, projectUndoNamespace(id), req.OperationKey, jsonBytes(receipt)); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func validateProjectUndo(ctx context.Context, tx pgx.Tx, uid, id string, receipt storedProjectUndo) error {
	ids := make([]uuid.UUID, 0, len(receipt.Changes))
	for _, change := range receipt.Changes {
		projectID, err := uuid.Parse(change.ProjectID)
		if err != nil {
			return fmt.Errorf("invalid project in undo receipt: %w", err)
		}
		ids = append(ids, projectID)
	}
	targets, err := loadDecisionTargets(ctx, tx, uid, id, ids)
	if err != nil {
		return err
	}
	for i, change := range receipt.Changes {
		target, found := targets[ids[i]]
		if !found || target.version != change.Version || !equalJSON(target.association, change.After) {
			return suggestionConflict()
		}
		before := change.Before
		if before == nil || before.Decision != "suggested" {
			continue
		}
		if !target.restorableSuggestion || value(before.ProjectVersion) != target.version {
			return suggestionConflict()
		}
	}
	return nil
}

func storeProjectUndo(ctx context.Context, tx pgx.Tx, uid, id, key string, requestDigest []byte, receipt storedProjectUndo) (time.Time, error) {
	var expires time.Time
	err := tx.QueryRow(ctx, `INSERT INTO idempotency_keys(user_id,operation,key,request_digest,response_status,response_json)
		VALUES($1,$2,$3,$4,200,$5)
		ON CONFLICT(user_id,operation,key) DO UPDATE SET request_digest=excluded.request_digest,
			response_json=excluded.response_json,expires_at=excluded.expires_at
		RETURNING expires_at`, uid, projectUndoNamespace(id), key, requestDigest, jsonBytes(receipt)).Scan(&expires)
	return expires, err
}
