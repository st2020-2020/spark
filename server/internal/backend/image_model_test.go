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
		outputTokens                 int
	}{
		{
			name:   "unfamiliar nested metadata never becomes evidence",
			finish: "stop", content: `{"layout":{"text":"伪造原文","parts":[{"description":"伪造描述"}]},"text":"V17 阀门","sections":["伪造标题"],"reasoning":"未对外的推理"}`,
			status: "succeeded", text: "V17 阀门", metered: true, outputTokens: 53,
		},
		{
			name:   "duplicate metadata is rejected",
			finish: "stop", content: `{"layout":{"id":1,"id":2},"text":"不发布"}`,
			status: "failed", code: "image_provider_content_invalid", metered: true, outputTokens: 53,
		},
		{
			name:   "excessive metadata nesting is rejected under length",
			finish: "length", content: `{"text":"不发布","layout":` + strings.Repeat("[", 24),
			status: "failed", code: "image_provider_content_invalid", metered: true, outputTokens: 53,
		},
		{
			name:   "length retains a closed excerpt before interrupted metadata",
			finish: "length", content: `{"text":"V17 阀门","layout":{"text":"未闭合`,
			status: "partial", code: "image_output_truncated", text: "V17 阀门", truncated: true, metered: true, outputTokens: 53,
		},
		{
			name:   "metadata alone is not a valid result",
			finish: "stop", content: `{"layout":{"text":"伪造原文"}}`,
			status: "failed", code: "image_provider_content_invalid", metered: true, outputTokens: 53,
		},
		{
			name:   "verified provider shape with metadata before the exact excerpt",
			finish: "stop", content: `{"type":"工程蓝图","chinese_topic":"合成主题需要独立验证","text":"供水总图 V17\n主管 DN200\n标高 +12.500\n设计流量 80 m³/h"}`,
			status: "succeeded", text: "供水总图 V17\n主管 DN200\n标高 +12.500\n设计流量 80 m³/h", metered: true, outputTokens: 53,
		},
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
			finish: "length", content: `{"description":"蓝图","reasoning":[nonsense`,
			status: "failed", code: "image_provider_content_invalid", metered: true,
		},
		{
			name:   "duplicate field invalidates the output",
			finish: "length", content: `{"text":"原字","text":"冲突`,
			status: "failed", code: "image_provider_content_invalid", metered: true,
		},
		{
			name:   "closed text-only object survives length",
			finish: "length", content: `{"text":"原字"}`,
			status: "partial", code: "image_output_truncated", text: "原字", truncated: true, metered: true, outputTokens: 53,
		},
		{
			name:   "one supplied string is usable at stop",
			finish: "stop", content: `{"text":"供水总图 V17"}`,
			status: "succeeded", text: "供水总图 V17", metered: true, outputTokens: 53,
		},
		{
			name:   "provider JSON mode can return spaces at stop",
			finish: "stop", content: "     \n",
			status: "failed", code: "image_provider_empty_output", metered: true, outputTokens: 53,
		},
		{
			name:   "filtered final answer is never extracted",
			finish: "content_filter", content: `{"text":"不要发布的片段"}`,
			status: "failed", code: "image_provider_content_filtered", metered: true, outputTokens: 53,
		},
		{
			name:   "provider may stop early due to resource shortage",
			finish: "insufficient_system_resource", content: "",
			status: "failed", code: "image_provider_interrupted", metered: true, outputTokens: 53,
		},
		{
			name:   "nested structure cannot masquerade as exact excerpts",
			finish: "stop", content: `{"text":["猜测文字"],"description":"蓝图"}`,
			status: "failed", code: "image_provider_content_invalid", metered: true, outputTokens: 53,
		},
		{
			name:   "empty valid completion",
			finish: "stop", content: `{"description":"","text":""}`,
			status: "succeeded", metered: true,
		},
		{
			name:   "stopped but incomplete JSON is invalid",
			finish: "stop", content: `{"description":"蓝图","text":"未闭合`,
			status: "failed", code: "image_provider_content_invalid", metered: true,
		},
		{
			name:   "missing usage does not hide empty truncation",
			finish: "length", content: "",
			status: "failed", code: "image_output_truncated_empty", truncated: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outputTokens := tt.outputTokens
			if outputTokens == 0 {
				outputTokens = 512
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var usage map[string]int
				if tt.metered {
					usage = map[string]int{"prompt_tokens": 999, "completion_tokens": outputTokens}
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
			if u := got.Account.Usage; (u != nil) != tt.metered || u != nil && (u.Input != 999 || u.Output != int64(outputTokens)) {
				t.Errorf("unexpected accounted usage: %+v", u)
			}
		})
	}
}

func TestImageModelUsesBoundedSummaryFirstPrompt(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil || !strings.Contains(string(raw), `{\"description\":\"\",\"text\":\"\"}`) ||
			!strings.Contains(string(raw), "exact title/lines max80") {
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
