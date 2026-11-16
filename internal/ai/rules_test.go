package ai

import (
	"context"
	"slices"
	"strings"
	"testing"

	"spark/internal/model"
)

func TestOrganizeWithRules(t *testing.T) {
	res := OrganizeWithRules(OrganizeInput{
		Content: "用 MyGo 做 AI 笔记。 #个人项目",
		Source:  model.SourceText,
	})
	for _, want := range []string{"个人项目", "AI", "开发"} {
		if !slices.Contains(res.Tags, want) {
			t.Fatalf("expected tag %q in %v", want, res.Tags)
		}
	}
	if !strings.Contains(res.Summary, "MyGo") {
		t.Fatalf("unexpected summary: %q", res.Summary)
	}

	img := OrganizeWithRules(OrganizeInput{
		Content:   "",
		Source:    model.SourceImage,
		ImageName: "cat.png",
	})
	if !slices.Equal(img.Tags, []string{"图片收藏"}) {
		t.Fatalf("expected default image tag, got %v", img.Tags)
	}
	if !strings.Contains(img.Summary, "补充文字") || strings.Contains(img.Summary, "cat") {
		t.Fatalf("unexpected image summary: %q", img.Summary)
	}

	if _, err := ParseOrganization([]byte(`{"tags":[],"summary":"记录"}`)); err == nil {
		t.Fatalf("expected error on empty tags")
	}
}

func TestFallbackWhenAPIKeyMissing(t *testing.T) {
	t.Setenv("AI_PROVIDER", "openai")
	t.Setenv("OPENAI_API_KEY", "")

	res := Organize(context.Background(), OrganizeInput{
		Content: "明天读书",
		Source:  model.SourceText,
	})
	if res.Status != model.StatusFallback || res.Provider != "rules" {
		t.Fatalf("expected fallback/rules, got %s/%s", res.Status, res.Provider)
	}
	if !slices.Contains(res.Tags, "阅读") {
		t.Fatalf("expected tag 阅读, got %v", res.Tags)
	}
}
