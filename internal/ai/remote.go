package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"spark/internal/model"
)

type OpenAIProvider struct{}

func (OpenAIProvider) Name() string { return "openai" }

func (OpenAIProvider) Organize(ctx context.Context, input OrganizeInput) (model.Organization, error) {
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		return model.Organization{}, errors.New("missing OPENAI_API_KEY")
	}
	modelName := strings.TrimSpace(os.Getenv("OPENAI_MODEL"))
	if modelName == "" {
		modelName = "gpt-4.1-mini"
	}

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	reqBody, _ := json.Marshal(map[string]any{
		"model": modelName,
		"messages": []map[string]string{
			{"role": "user", "content": Instruction(input)},
		},
		"response_format": map[string]string{"type": "json_object"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.openai.com/v1/chat/completions", bytes.NewReader(reqBody))
	if err != nil {
		return model.Organization{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.Organization{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return model.Organization{}, errors.New("openai request failed")
	}

	var payload struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(&payload); err != nil {
		return model.Organization{}, err
	}
	if len(payload.Choices) == 0 {
		return model.Organization{}, errors.New("empty openai response")
	}
	return ParseOrganization([]byte(extractJSON(payload.Choices[0].Message.Content)))
}

type AnthropicProvider struct{}

func (AnthropicProvider) Name() string { return "anthropic" }

func (AnthropicProvider) Organize(ctx context.Context, input OrganizeInput) (model.Organization, error) {
	apiKey := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if apiKey == "" {
		return model.Organization{}, errors.New("missing ANTHROPIC_API_KEY")
	}
	modelName := strings.TrimSpace(os.Getenv("ANTHROPIC_MODEL"))
	if modelName == "" {
		modelName = "claude-sonnet-4-20250514"
	}

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	reqBody, _ := json.Marshal(map[string]any{
		"model":      modelName,
		"max_tokens": 300,
		"messages": []map[string]string{
			{"role": "user", "content": Instruction(input)},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(reqBody))
	if err != nil {
		return model.Organization{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return model.Organization{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return model.Organization{}, errors.New("anthropic request failed")
	}

	var payload struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 256*1024)).Decode(&payload); err != nil {
		return model.Organization{}, err
	}
	for _, block := range payload.Content {
		if block.Type == "text" {
			return ParseOrganization([]byte(extractJSON(block.Text)))
		}
	}
	return model.Organization{}, errors.New("empty anthropic response")
}

func extractJSON(raw string) string {
	s := strings.TrimSpace(raw)
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start >= 0 && end > start {
		return s[start : end+1]
	}
	return s
}
