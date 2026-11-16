package ai

import (
	"context"
	"os"
	"strings"

	"spark/internal/model"
)

type Result struct {
	model.Organization
	Provider string
	Status   model.Status
}

func CurrentProvider() Provider {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AI_PROVIDER"))) {
	case "openai":
		return OpenAIProvider{}
	case "anthropic":
		return AnthropicProvider{}
	default:
		return RulesProvider{}
	}
}

func Organize(ctx context.Context, input OrganizeInput) Result {
	p := CurrentProvider()
	org, err := p.Organize(ctx, input)
	if err == nil {
		return Result{
			Organization: org,
			Provider:     p.Name(),
			Status:       model.StatusReady,
		}
	}
	return Result{
		Organization: OrganizeWithRules(input),
		Provider:     "rules",
		Status:       model.StatusFallback,
	}
}
