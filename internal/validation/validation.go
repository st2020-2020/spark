package validation

import (
	"bytes"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	MaxContent = 50_000
	MaxImage   = 5 * 1024 * 1024
)

type InputError struct {
	Message string
	Status  int
}

func (e *InputError) Error() string {
	return e.Message
}

func NewInputError(message string, status ...int) error {
	code := 400
	if len(status) > 0 && status[0] > 0 {
		code = status[0]
	}
	return &InputError{Message: message, Status: code}
}

func ValidateContent(value string, hasImage bool) (string, error) {
	content := strings.TrimSpace(value)
	if content == "" && !hasImage {
		return "", NewInputError("写点什么，或上传一张图片再保存。")
	}
	if utf8.RuneCountInString(content) > MaxContent {
		return "", NewInputError("内容不能超过 50,000 字，请拆成多条记录。")
	}
	return content, nil
}

var urlPattern = regexp.MustCompile(`(?i)https?://[^\s<>"'，。；！？]+`)
var trailingPunct = regexp.MustCompile(`[).,;!?]+$`)

func ExtractURL(content string) string {
	match := urlPattern.FindString(content)
	if match == "" {
		return ""
	}
	cleaned := trailingPunct.ReplaceAllString(match, "")
	parsed, err := url.Parse(cleaned)
	if err != nil {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if (scheme != "http" && scheme != "https") || parsed.Host == "" {
		return ""
	}
	return parsed.String()
}

func ValidateImage(data []byte, fileName string) (mimeType string, cleanName string, err error) {
	if len(data) == 0 {
		return "", "", NewInputError("图片是空文件，请重新选择。")
	}
	if len(data) > MaxImage {
		return "", "", NewInputError("图片不能超过 5 MB，请压缩后重试。")
	}

	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		mimeType = "image/png"
	case len(data) >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255:
		mimeType = "image/jpeg"
	case len(data) >= 6 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		mimeType = "image/gif"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		mimeType = "image/webp"
	default:
		return "", "", NewInputError("请选择有效的 JPG、PNG、GIF 或 WebP 图片。")
	}

	base := strings.TrimSpace(filepath.Base(fileName))
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "图片"
	}
	runes := []rune(base)
	if len(runes) > 200 {
		base = string(runes[:200])
	}
	return mimeType, base, nil
}
