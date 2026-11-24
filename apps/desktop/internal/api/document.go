package api

import (
	"bytes"
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	MaxContentRunes = 50_000
	MaxImageBytes   = 5 * 1024 * 1024
	MaxImagesPerCol = 9
)

var (
	urlPattern    = regexp.MustCompile(`(?i)https?://[^\s<>"'，。；！？]+`)
	trailingPunct = regexp.MustCompile(`[).,;!?]+$`)
)

// BuildDocument converts plain text into a valid Spark Document v1 matching contracts/document.schema.json.
func BuildDocument(plain string) SparkDocument {
	normalized := strings.ReplaceAll(plain, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	trimmed := strings.TrimSpace(normalized)
	if trimmed == "" {
		return SparkDocument{
			SchemaVersion: 1,
			Content: DocumentRoot{
				Type: "doc",
				Content: []BlockNode{
					{Type: "paragraph"},
				},
			},
		}
	}

	lines := strings.Split(normalized, "\n")
	blocks := make([]BlockNode, 0, len(lines))
	for _, line := range lines {
		if line == "" {
			blocks = append(blocks, BlockNode{Type: "paragraph"})
			continue
		}
		blocks = append(blocks, BlockNode{
			Type: "paragraph",
			Content: []InlineNode{
				{Type: "text", Text: line},
			},
		})
	}
	if len(blocks) == 0 {
		blocks = []BlockNode{{Type: "paragraph"}}
	}
	return SparkDocument{
		SchemaVersion: 1,
		Content: DocumentRoot{
			Type:    "doc",
			Content: blocks,
		},
	}
}

// PlainText keeps inline runs together and separates nested block nodes.
func (doc *SparkDocument) PlainText() string {
	if doc == nil {
		return ""
	}
	var lines []string
	for _, block := range doc.Content.Content {
		lines = append(lines, nodeText(block.Type, block.Content))
	}
	return strings.Join(lines, "\n")
}
func nodeText(kind string, content []InlineNode) string {
	var text strings.Builder
	for i, node := range content {
		if i > 0 && (kind == "bulletList" || kind == "orderedList" || kind == "listItem" || kind == "blockquote") {
			text.WriteByte('\n')
		}
		switch node.Type {
		case "text":
			text.WriteString(node.Text)
		case "hardBreak":
			text.WriteByte('\n')
		default:
			text.WriteString(nodeText(node.Type, node.Content))
		}
	}
	return text.String()
}

// ExtractFirstURL extracts the first valid HTTP(S) URL without embedded credentials.
func ExtractFirstURL(text string) string {
	match := urlPattern.FindString(text)
	if match == "" {
		return ""
	}
	cleaned := trailingPunct.ReplaceAllString(match, "")
	parsed, err := url.Parse(cleaned)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return ""
	}
	res := parsed.String()
	if utf8.RuneCountInString(res) > 4096 {
		return ""
	}
	return res
}

// ValidateCaptureInput validates text + intent length and non-empty invariant.
func ValidateCaptureInput(text, intent, originalURL string, imageCount int) error {
	cleanText := strings.TrimSpace(text)

	cleanURL := strings.TrimSpace(originalURL)

	if cleanText == "" && cleanURL == "" && imageCount == 0 {
		return errors.New("写点什么、粘贴链接或附上一张图片再收下。")
	}
	if imageCount > MaxImagesPerCol {
		return errors.New("单条收藏最多附带 9 张图片。")
	}
	if utf8.RuneCountInString(text)+utf8.RuneCountInString(intent) > MaxContentRunes {
		return errors.New("正文与用途说明合计不能超过 50,000 字。")
	}
	if cleanURL != "" {
		u, err := url.Parse(cleanURL)
		if err != nil || u.Host == "" || u.User != nil || (strings.ToLower(u.Scheme) != "http" && strings.ToLower(u.Scheme) != "https") {
			return errors.New("请输入有效的 HTTP(S) 网址。")
		}
		if utf8.RuneCountInString(cleanURL) > 4096 {
			return errors.New("网址长度不能超过 4,096 字符。")
		}
	}
	return nil
}

// ValidateImageBytes validates magic bytes, size limit (5 MiB), and sanitizes filename for server upload contract.
func ValidateImageBytes(data []byte, filename string) (mimeType string, safeName string, err error) {
	if len(data) == 0 {
		return "", "", errors.New("图片内容为空。")
	}
	if len(data) > MaxImageBytes {
		return "", "", errors.New("单张图片不能超过 5 MiB。")
	}

	var defaultExt string
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		mimeType = "image/png"
		defaultExt = ".png"
	case len(data) >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255:
		mimeType = "image/jpeg"
		defaultExt = ".jpg"
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		mimeType = "image/gif"
		defaultExt = ".gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		mimeType = "image/webp"
		defaultExt = ".webp"
	default:
		return "", "", errors.New("仅支持 JPG、PNG、GIF 或 WebP 图片。")
	}

	safeName = sanitizeFilename(filename, defaultExt)
	return mimeType, safeName, nil
}

func sanitizeFilename(raw, defaultExt string) string {
	base := strings.TrimSpace(filepath.Base(raw))
	var b strings.Builder
	for _, r := range base {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			continue
		}
		b.WriteRune(r)
	}
	clean := strings.TrimSpace(b.String())
	if clean == "" || clean == "." || clean == ".." {
		clean = "image" + defaultExt
	}
	runes := []rune(clean)
	if len(runes) > 180 {
		clean = string(runes[:180])
	}
	return clean
}
