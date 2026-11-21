package backend

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestImageModelDistinguishesTruncatedOutputAndKeepsUsage(t *testing.T) {
	tests := []struct {
		name, finish, content        string
		status, code, text, describe string
		truncated, metered           bool
	}{
		{
			name:   "dense blueprint exhausts the first string",
			finish: "length", content: `{"text":"` + strings.Repeat("密集合成蓝图文字 ", 120),
			status: "failed", code: "image_output_truncated_empty", truncated: true, metered: true,
		},
		{
			name:   "complete description survives interrupted excerpt",
			finish: "length", content: `{"description":"蓝图，园区供水管线","text":"未闭合`,
			status: "partial", code: "image_output_truncated", describe: "蓝图，园区供水管线", truncated: true, metered: true,
		},
		{
			name:   "invalid field does not publish a prefix",
			finish: "length", content: `{"description":"蓝图","reasoning":"推理内容"`,
			status: "failed", code: "invalid_model_output", metered: true,
		},
		{
			name:   "duplicate field invalidates the output",
			finish: "length", content: `{"text":"原字","text":"冲突`,
			status: "failed", code: "invalid_model_output", metered: true,
		},
		{
			name:   "closed object with missing field is invalid",
			finish: "length", content: `{"text":"原字"}`,
			status: "failed", code: "invalid_model_output", metered: true,
		},
		{
			name:   "empty valid completion",
			finish: "stop", content: `{"description":"","text":""}`,
			status: "succeeded", metered: true,
		},
		{
			name:   "stopped but incomplete JSON is invalid",
			finish: "stop", content: `{"description":"蓝图","text":"未闭合`,
			status: "failed", code: "invalid_model_output", metered: true,
		},
		{
			name:   "missing usage does not hide empty truncation",
			finish: "length", content: "",
			status: "failed", code: "image_output_truncated_empty", truncated: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var usage map[string]int
				if tt.metered {
					usage = map[string]int{"prompt_tokens": 1024, "completion_tokens": 512}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{
					"finish_reason": tt.finish,
					"message":       map[string]any{"content": tt.content, "reasoning_content": "不能用作识别结果的合成推理"},
				}}, "usage": usage})
			}))
			t.Cleanup(provider.Close)
			t.Setenv("SPARK_IMAGE_ANALYSIS_ENDPOINT", provider.URL+"/chat/completions")
			t.Setenv("SPARK_IMAGE_ANALYSIS_KEY_FILE", "")
			model, err := LoadImageModel("development")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(model.Close)
			request, err := buildImageRequest([]byte{0}, "image/jpeg")
			if err != nil {
				t.Fatal(err)
			}
			got := model.analyze(t.Context(), request)
			if got.Status != tt.status || got.Account.ErrorCode != tt.code ||
				got.Text != tt.text || got.Evidence.Description != tt.describe || got.Evidence.Truncated != tt.truncated {
				t.Errorf("unexpected model result: %+v", got)
			}
			if u := got.Account.Usage; (u != nil) != tt.metered || u != nil && (u.Input != 1024 || u.Output != 512) {
				t.Errorf("unexpected accounted usage: %+v", u)
			}
		})
	}
}

func TestImageModelUsesBoundedSummaryFirstPrompt(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil || !strings.Contains(string(raw), "description first") ||
			!strings.Contains(string(raw), "verbatim title/key lines max80") {
			t.Errorf("request did not prioritize the bounded description and representative exact excerpts")
		}
		modelReply(w, "stop", `{"description":"园区供水蓝图","text":"阀门V17"}`, map[string]int{"prompt_tokens": 1024, "completion_tokens": 60})
	}))
	t.Cleanup(provider.Close)
	t.Setenv("SPARK_IMAGE_ANALYSIS_ENDPOINT", provider.URL+"/chat/completions")
	t.Setenv("SPARK_IMAGE_ANALYSIS_KEY_FILE", "")
	model, err := LoadImageModel("development")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(model.Close)
	request, err := buildImageRequest([]byte{0}, "image/jpeg")
	if err != nil {
		t.Fatal(err)
	}
	if result := model.analyze(t.Context(), request); result.Status != "succeeded" ||
		result.Text != "阀门V17" || result.Evidence.Description != "园区供水蓝图" {
		t.Fatalf("complete bounded result was lost: %+v", result)
	}
}
