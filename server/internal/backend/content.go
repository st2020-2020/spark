package backend

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"spark/server/internal/contract"
)

type documentNode struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Content []documentNode `json:"content"`
	Marks   []struct {
		Type  string `json:"type"`
		Attrs struct {
			Href string `json:"href"`
		} `json:"attrs"`
	} `json:"marks"`
}

var urlInText = regexp.MustCompile(`https?://[^\s<>]+`)

func validURL(raw string) bool {
	if raw == "" || utf8.RuneCountInString(raw) > 4096 {
		return false
	}
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.Hostname() != "" && u.User == nil
}

// The OpenAPI schema validates the node allowlist. This traversal enforces the
// cross-node resource limits and derives text without interpreting any markup.
func documentText(doc contract.Document) (string, string, error) {
	var parsed struct {
		Content documentNode `json:"content"`
	}
	if err := json.Unmarshal(jsonBytes(doc), &parsed); err != nil {
		return "", "", err
	}
	var text strings.Builder
	firstURL := ""
	nodes := 0
	var walk func(documentNode, int) error
	walk = func(n documentNode, depth int) error {
		nodes++
		if nodes > 10000 {
			return problem(422, "unsupported_document", "文档节点过多。")
		}
		if n.Type == "bulletList" || n.Type == "orderedList" {
			depth++
			if depth > 3 {
				return problem(422, "unsupported_document", "列表最多嵌套三层。")
			}
		}
		for _, m := range n.Marks {
			if m.Type == "link" {
				if !validURL(m.Attrs.Href) {
					return problem(422, "unsupported_document", "链接仅支持无凭据的 HTTP(S) 地址。")
				}
				if firstURL == "" {
					firstURL = m.Attrs.Href
				}
			}
		}
		if n.Type == "text" {
			text.WriteString(n.Text)
			if firstURL == "" {
				for _, match := range urlInText.FindAllString(n.Text, -1) {
					match = strings.TrimRight(match, ".,;!?，。；！？）)]}》\"'")
					if validURL(match) {
						firstURL = match
						break
					}
				}
			}
		}
		if n.Type == "hardBreak" {
			text.WriteByte('\n')
		}
		for _, child := range n.Content {
			if err := walk(child, depth); err != nil {
				return err
			}
		}
		if n.Type == "paragraph" {
			text.WriteByte('\n')
		}
		return nil
	}
	if err := walk(parsed.Content, 0); err != nil {
		return "", "", err
	}
	return strings.TrimSuffix(text.String(), "\n"), firstURL, nil
}
func validateContent(doc contract.Document, intent, originalURL string) (string, string, error) {
	plain, derived, err := documentText(doc)
	if err != nil {
		return "", "", err
	}
	if utf8.RuneCountInString(plain)+utf8.RuneCountInString(intent) > 50000 {
		return "", "", problem(422, "validation_failed", "原文和用途合计最多 50,000 字。")
	}
	if originalURL != "" && !validURL(originalURL) {
		return "", "", problem(422, "validation_failed", "网址仅支持无凭据的 HTTP(S) 地址。")
	}
	if originalURL == "" {
		originalURL = derived
	}
	if strings.TrimSpace(plain) == "" && originalURL == "" {
		return "", "", problem(422, "validation_failed", "请填写文字或有效网址。")
	}
	return plain, originalURL, nil
}
func shortText(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
func titleFor(plain, manual, rawURL string) string {
	if manual != "" {
		return manual
	}
	if p := strings.TrimSpace(plain); p != "" {
		return shortText(strings.SplitN(p, "\n", 2)[0], 200)
	}
	if u, err := url.Parse(rawURL); err == nil {
		return u.Hostname()
	}
	return "收藏"
}
func value[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}
