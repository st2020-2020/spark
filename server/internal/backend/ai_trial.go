package backend

import (
	"errors"
	"strings"

	"github.com/google/uuid"
)

const aiTrialUnavailable = "ai_trial_not_available"

// AITrialScope is a process configuration snapshot. Its zero value denies all.
type AITrialScope struct {
	users       map[uuid.UUID]struct{}
	development bool
}

func ParseAITrialScope(env, raw string) (AITrialScope, error) {
	if strings.TrimSpace(raw) == "" {
		return AITrialScope{development: env == "development"}, nil
	}
	scope := AITrialScope{users: make(map[uuid.UUID]struct{})}
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || !strings.EqualFold(id.String(), value) {
			return AITrialScope{}, errors.New("SPARK_AI_TRIAL_USER_IDS must contain comma-separated user UUIDs")
		}
		scope.users[id] = struct{}{}
	}
	return scope, nil
}

func (s AITrialScope) allows(userID string) bool {
	id, err := uuid.Parse(userID)
	if err != nil || id == uuid.Nil {
		return false
	}
	_, allowed := s.users[id]
	return s.development || allowed
}
