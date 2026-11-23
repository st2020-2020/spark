package backend

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCompatibleTextClientDiagnosesLengthAndPreservesUsage(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"synthetic reasoning"}}],"usage":{"prompt_tokens":2048,"completion_tokens":2048}}`))
	}))
	defer provider.Close()
	client := NewTextClient()
	defer client.Close()
	out := client.Generate(t.Context(), AIRoute{Endpoint: provider.URL, MaxOutputTokens: 2048}, AIConfig{TimeoutSeconds: 2}, []byte("{}"), 4096)
	if out.ErrorCode != modelOutputTruncated || out.Usage == nil || *out.Usage != (TokenUsage{2048, 2048}) || out.Content != "" || out.Retryable {
		t.Fatalf("unexpected length diagnosis and usage: %+v", out)
	}
}

func TestAIRouteConfigurationHasOneSourceForBudgets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	config := `{"version":"synthetic-price-v1","max_attempts":1,"timeout_seconds":2,"max_input_chars":1000,"routes":[{"name":"primary","endpoint":"http://127.0.0.1:10001/v1/chat/completions","model":"synthetic-model","allow_unauthenticated_development":true,"output_mode":"json_object","max_output_tokens":500,"input_price_units_per_million_tokens":1000000,"output_price_units_per_million_tokens":2000000}]}`
	if err := os.WriteFile(path, []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadAIConfig(path, "development"); err != nil {
		t.Fatal("one approved local route must be valid:", err)
	}
	if _, err := LoadAIConfig(path, "production"); err == nil {
		t.Fatal("production accepted an unauthenticated route")
	}
	for _, field := range []string{`"enabled":true`, `"concurrency":2`, `"worker_concurrency":2`, `"platform_daily_units":1`, `"user_daily_units":1`} {
		bad := config[:len(config)-1] + "," + field + "}"
		if err := os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadAIConfig(path, "development"); err == nil {
			t.Fatalf("route file accepted obsolete field %s", field)
		}
	}
}
