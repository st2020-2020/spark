package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

type AIConfig struct {
	Version        string    `json:"version"`
	MaxAttempts    int       `json:"max_attempts"`
	TimeoutSeconds int       `json:"timeout_seconds"`
	MaxInputChars  int       `json:"max_input_chars"`
	Routes         []AIRoute `json:"routes"`
}
type AIRoute struct {
	Name                            string `json:"name"`
	Endpoint                        string `json:"endpoint"`
	Model                           string `json:"model"`
	APIKeyFile                      string `json:"api_key_file,omitempty"`
	AllowUnauthenticatedDevelopment bool   `json:"allow_unauthenticated_development,omitempty"`
	OutputMode                      string `json:"output_mode"`
	MaxOutputTokens                 int    `json:"max_output_tokens"`
	MaxContextTokens                int    `json:"max_context_tokens,omitempty"`
	InputPrice                      int64  `json:"input_price_units_per_million_tokens"`
	OutputPrice                     int64  `json:"output_price_units_per_million_tokens"`
	key                             string
}

func LoadAIConfig(path, env string) (AIConfig, error) {
	var cfg AIConfig
	if path == "" {
		return cfg, errors.New("SPARK_AI_CONFIG_FILE is required")
	}
	f, err := os.Open(path)
	if err != nil {
		return cfg, errors.New("AI route configuration is unreadable")
	}
	defer f.Close()
	dec := json.NewDecoder(io.LimitReader(f, 65537))
	dec.DisallowUnknownFields()
	if dec.Decode(&cfg) != nil {
		return cfg, errors.New("invalid AI route configuration")
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return cfg, errors.New("unexpected trailing AI configuration")
	}
	if cfg.Version == "" || len(cfg.Version) > 100 || cfg.MaxAttempts < 1 || cfg.MaxAttempts > 3 || cfg.TimeoutSeconds < 1 || cfg.TimeoutSeconds > 120 || cfg.MaxInputChars < 100 || cfg.MaxInputChars > 12000 || len(cfg.Routes) < 1 || len(cfg.Routes) > 2 {
		return cfg, errors.New("invalid AI limits or route count")
	}
	names := map[string]bool{}
	for i := range cfg.Routes {
		r := &cfg.Routes[i]
		u, e := url.Parse(r.Endpoint)
		if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") || !strings.HasSuffix(u.Path, "/chat/completions") || r.Model == "" || len(r.Model) > 200 || r.Name == "" || len(r.Name) > 64 || names[r.Name] {
			return cfg, errors.New("invalid or duplicate AI route")
		}
		names[r.Name] = true
		if r.OutputMode != "json_object" && r.OutputMode != "json_schema" && r.OutputMode != "json_text" {
			return cfg, errors.New("unsupported output_mode")
		}
		if r.MaxContextTokens == 0 {
			r.MaxContextTokens = 32768
		}
		if r.MaxOutputTokens < 100 || r.MaxOutputTokens > 4096 || r.MaxContextTokens < 2048 || r.MaxContextTokens > 200000 || r.MaxOutputTokens >= r.MaxContextTokens || r.InputPrice < 0 || r.OutputPrice < 0 || r.InputPrice > 1000000000000 || r.OutputPrice > 1000000000000 {
			return cfg, errors.New("invalid AI route capacity or estimated price")
		}
		if r.AllowUnauthenticatedDevelopment && (env != "development" || !(isLoopback(u.Hostname()) || u.Hostname() == "host.docker.internal")) {
			return cfg, errors.New("unauthenticated AI route is only allowed for explicitly trusted local development")
		}
		if r.APIKeyFile != "" {
			b, e := os.ReadFile(r.APIKeyFile)
			if e != nil || len(b) > 8192 {
				return cfg, errors.New("AI credential file is unreadable or oversized")
			}
			r.key = strings.TrimSpace(string(b))
			if r.key == "" || strings.ContainsAny(r.key, "\r\n") {
				return cfg, errors.New("invalid AI credential file")
			}
		}
		if r.key == "" && !r.AllowUnauthenticatedDevelopment {
			return cfg, errors.New("authenticated AI route requires api_key_file")
		}
	}
	return cfg, nil
}

type TokenUsage struct{ Input, Output int64 }
type ModelOutput struct {
	Content                      string
	Model                        string
	Usage                        *TokenUsage
	Sent, SafeFailure, Retryable bool
	ErrorCode                    string
}
type TextGenerator interface {
	Generate(context.Context, AIRoute, AIConfig, []byte, int64) ModelOutput
}
type CompatibleTextClient struct{ HTTP *http.Client }

func NewTextClient() *CompatibleTextClient {
	return &CompatibleTextClient{HTTP: &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 4, MaxIdleConnsPerHost: 2, IdleConnTimeout: 60 * time.Second, TLSHandshakeTimeout: 10 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (c *CompatibleTextClient) Close() { c.HTTP.CloseIdleConnections() }
func (c *CompatibleTextClient) Generate(ctx context.Context, route AIRoute, cfg AIConfig, payload []byte, inputUpper int64) ModelOutput {
	out := ModelOutput{Model: route.Model}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()
	var sent atomic.Bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteHeaders: func() { sent.Store(true) }})
	req, err := http.NewRequestWithContext(ctx, "POST", route.Endpoint, bytes.NewReader(payload))
	if err != nil {
		out.ErrorCode = "provider_unavailable"
		return out
	}
	req.Header.Set("Content-Type", "application/json")
	if route.key != "" {
		req.Header.Set("Authorization", "Bearer "+route.key)
	}
	resp, err := c.HTTP.Do(req)
	out.Sent = sent.Load()
	if err != nil {
		out.ErrorCode = "provider_unavailable"
		if ctx.Err() != nil {
			out.ErrorCode = "provider_timeout"
		}
		out.Retryable = !out.Sent
		return out
	}
	defer resp.Body.Close()
	out.Sent = true
	if resp.StatusCode != 200 {
		switch resp.StatusCode {
		case 401, 403:
			out.ErrorCode = "provider_auth_failed"
			out.SafeFailure = true
			out.Retryable = true
		case 429:
			out.ErrorCode = "provider_rate_limited"
			out.SafeFailure = true
			out.Retryable = true
		case 400, 404, 422:
			out.ErrorCode = "provider_request_rejected"
			out.SafeFailure = true
		default:
			out.ErrorCode = "provider_unavailable"
		}
		return out
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (256<<10)+1))
	if err != nil || len(raw) > 256<<10 {
		out.ErrorCode = "invalid_model_output"
		return out
	}
	var response struct {
		Model   string `json:"model"`
		Choices []struct {
			Finish  string `json:"finish_reason"`
			Message struct {
				Content   string            `json:"content"`
				ToolCalls []json.RawMessage `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			Input  *int64 `json:"prompt_tokens"`
			Output *int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &response) != nil {
		out.ErrorCode = "invalid_model_output"
		return out
	}
	if response.Model != "" && len(response.Model) <= 200 {
		out.Model = response.Model
	}
	if response.Usage != nil && response.Usage.Input != nil && response.Usage.Output != nil && *response.Usage.Input >= 0 && *response.Usage.Output >= 0 && *response.Usage.Input <= inputUpper && *response.Usage.Output <= int64(route.MaxOutputTokens) {
		out.Usage = &TokenUsage{Input: *response.Usage.Input, Output: *response.Usage.Output}
	}
	if len(response.Choices) != 1 || len(response.Choices[0].Message.ToolCalls) > 0 || response.Choices[0].Finish != "stop" {
		out.ErrorCode = "invalid_model_output"
		return out
	}
	out.Content = response.Choices[0].Message.Content
	if out.Usage == nil {
		out.ErrorCode = "usage_uncertain"
	}
	return out
}
func tokenCost(r AIRoute, input, output int64) (int64, error) {
	if input < 0 || output < 0 {
		return 0, errors.New("negative token usage")
	}
	sum := new(big.Int).Mul(big.NewInt(input), big.NewInt(r.InputPrice))
	sum.Add(sum, new(big.Int).Mul(big.NewInt(output), big.NewInt(r.OutputPrice)))
	sum.Add(sum, big.NewInt(999999))
	sum.Div(sum, big.NewInt(1000000))
	if !sum.IsInt64() {
		return 0, errors.New("estimated token cost overflow")
	}
	return sum.Int64(), nil
}
