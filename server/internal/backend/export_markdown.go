package backend

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"spark/server/internal/contract"
)

var markdownEscape = strings.NewReplacer(
	"\\", "\\\\", "&", "&amp;", "<", "&lt;", ">", "&gt;", "*", "\\*", "_", "\\_", "[", "\\[", "]", "\\]",
	"`", "\\`", "#", "\\#", "|", "\\|", "~", "\\~", "=", "\\=", "!", "\\!", "-", "\\-", "+", "\\+", ".", "\\.", ")", "\\)",
)

var markdownLinkEscape = strings.NewReplacer("<", "%3C", ">", "%3E", "\\", "%5C", "&", "&amp;")

func mdLine(text string) string {
	return markdownEscape.Replace(strings.Join(strings.Fields(text), " "))
}

type markdownNode struct {
	Type    string
	Text    string
	Content []markdownNode
	Attrs   struct{ Start int }
	Marks   []struct {
		Type  string
		Attrs struct{ Href string }
	}
}

func documentMarkdown(raw json.RawMessage) (string, error) {
	var doc struct {
		Version int `json:"schema_version"`
		Content markdownNode
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", err
	}
	if doc.Version != 1 || doc.Content.Type != "doc" {
		return "", fmt.Errorf("unsupported document in export")
	}
	return renderMarkdown(doc.Content)
}

func renderMarkdown(n markdownNode) (string, error) {
	switch n.Type {
	case "text":
		text := markdownEscape.Replace(n.Text)
		for _, m := range n.Marks {
			switch m.Type {
			case "bold":
				text = "**" + text + "**"
			case "highlight":
				text = "==" + text + "=="
			case "link":
				if !validURL(m.Attrs.Href) {
					return "", fmt.Errorf("invalid document link in export")
				}
				dest := markdownLinkEscape.Replace(m.Attrs.Href)
				text = "[" + text + "](<" + dest + ">)"
			default:
				return "", fmt.Errorf("unsupported document mark in export")
			}
		}
		return text, nil
	case "hardBreak":
		return "  \n", nil
	case "doc", "listItem", "paragraph", "orderedList", "bulletList":
	default:
		return "", fmt.Errorf("unsupported document node in export")
	}
	var out strings.Builder
	for i, child := range n.Content {
		text, err := renderMarkdown(child)
		if err != nil {
			return "", err
		}
		switch n.Type {
		case "doc", "listItem":
			if i > 0 {
				out.WriteString("\n\n")
			}
		case "paragraph":
		case "orderedList", "bulletList":
			if i > 0 {
				out.WriteByte('\n')
			}
			prefix := "- "
			if n.Type == "orderedList" {
				prefix = strconv.Itoa(max(1, n.Attrs.Start)+i) + ". "
			}
			out.WriteString(prefix)
			text = strings.ReplaceAll(text, "\n", "\n"+strings.Repeat(" ", len(prefix)))
		}
		out.WriteString(text)
	}
	return out.String(), nil
}

func exportComponent(name string) string {
	var out strings.Builder
	for _, r := range norm.NFC.String(name) {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || strings.ContainsRune(`/\:*?"<>|`, r) {
			r = '_'
		}
		if out.Len()+utf8.RuneLen(r) > 80 {
			break
		}
		out.WriteRune(r)
	}
	clean := strings.Trim(out.String(), ". ")
	if clean == "" {
		return "未命名"
	}
	device, _, _ := strings.Cut(strings.ToUpper(clean), ".")
	device = strings.TrimRight(device, " ")
	switch device {
	case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
		return "_" + clean
	}
	if len(device) > 3 && (strings.HasPrefix(device, "LPT") || strings.HasPrefix(device, "COM")) && utf8.RuneCountInString(device[3:]) == 1 && strings.Contains("123456789¹²³", device[3:]) {
		return "_" + clean
	}
	return clean
}

type markdownArchive struct {
	zip     *zip.Writer
	folders map[uuid.UUID]string
	used    map[string]int
}

func newMarkdownArchive(z *zip.Writer) markdownArchive {
	return markdownArchive{z, make(map[uuid.UUID]string), make(map[string]int)}
}

// Check the final candidate too: a real project may already be named "A (2)".
func (m *markdownArchive) name(dir, base, ext string) string {
	path := dir + "/" + exportComponent(base)
	key := cases.Fold().String(path + ext)
	for n := m.used[key] + 1; ; n++ {
		candidate := path
		if n > 1 {
			candidate += fmt.Sprintf(" (%d)", n)
		}
		candidate += ext
		folded := cases.Fold().String(candidate)
		if m.used[folded] == 0 {
			m.used[folded] = 1
			m.used[key] = n
			return candidate
		}
	}
}

func (m *markdownArchive) readme(at time.Time) error {
	w, err := m.zip.Create("README.md")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "# Spark 数据导出\n\n导出时间 %s\n\n每个项目的资料保存在 projects/ 下的项目文件夹，PROJECT.md 记录项目信息。收藏按项目 ID 放入第一个已归入的项目，文件内列出全部项目决定。待归类收藏位于 unclassified/。\n", at.In(budgetLocation).Format(time.RFC3339))
	return err
}

func (m *markdownArchive) project(p contract.Project) error {
	dir := m.name("projects", p.Name, "")
	m.folders[p.Id] = dir
	w, err := m.zip.Create(dir + "/PROJECT.md")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "# %s\n\n项目 ID：%s\n\n状态：%s\n\n创建时间：%s\n\n更新时间：%s\n\n版本：%d\n\n%s\n\n## 关注点\n", mdLine(p.Name), p.Id, p.State, p.CreatedAt.Format(time.RFC3339Nano), p.UpdatedAt.Format(time.RFC3339Nano), p.Version, markdownEscape.Replace(p.Description))
	if err != nil {
		return err
	}
	for _, point := range p.FocusPoints {
		if _, err = fmt.Fprintf(w, "- %s\n", mdLine(point)); err != nil {
			return err
		}
	}
	return nil
}

func (m *markdownArchive) collection(folder string, c exportCollection) (io.Writer, error) {
	title := titleFor(c.PlainText, c.ManualTitle, c.OriginalURL)
	base := c.CreatedAt.In(budgetLocation).Format(time.DateOnly) + "-" + title
	w, err := m.zip.Create(m.name(folder, base, ".md"))
	if err != nil {
		return nil, err
	}
	source := mdLine(c.OriginalURL)
	if validURL(c.OriginalURL) {
		source = "<" + markdownLinkEscape.Replace(c.OriginalURL) + ">"
	}
	_, err = fmt.Fprintf(w, "# %s\n\n创建时间：%s\n\n更新时间：%s\n\n来源网址：%s\n\n用途：%s\n\n项目决定：\n", mdLine(title), c.CreatedAt.Format(time.RFC3339Nano), c.UpdatedAt.Format(time.RFC3339Nano), source, markdownEscape.Replace(c.Intent))
	return w, err
}
