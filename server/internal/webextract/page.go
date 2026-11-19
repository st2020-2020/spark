package webextract

import (
	"strings"
	"unicode"

	"golang.org/x/net/html"
)

const maxText = 8000

func extractPage(doc *html.Node, host string) (Page, error) {
	var title string
	var primary, body *html.Node
	formRestricted := false
	meta := make(map[string]string, 4)
	walk(doc, func(n *html.Node) bool {
		switch n.Data {
		case "title":
			if title == "" {
				title = clean(textOf(n), 200)
			}
		case "meta":
			name := strings.ToLower(strings.TrimSpace(attr(n, "property")))
			if name == "" {
				name = strings.ToLower(strings.TrimSpace(attr(n, "name")))
			}
			switch name {
			case "og:title", "og:site_name", "og:description", "description":
				if meta[name] == "" {
					meta[name] = clean(attr(n, "content"), 280)
				}
			}
		case "body":
			body = n
		case "main", "article":
			if primary == nil {
				primary = n
			}
		case "input":
			if strings.EqualFold(attr(n, "type"), "password") || strings.EqualFold(attr(n, "name"), "captcha") {
				formRestricted = true
			}
		}
		return true
	})
	text := paragraphs(primary)
	if text == "" {
		text = paragraphs(body)
	}
	if formRestricted && text == "" {
		return Page{}, &Failure{Code: "fetch_restricted"}
	}
	title = clean(first(meta["og:title"], title), 200)
	summary := clean(first(meta["og:description"], meta["description"], text), 280)
	if title == "" && summary == "" {
		return Page{}, &Failure{Code: "empty_page"}
	}
	return Page{Title: title, Summary: summary, SiteName: clean(first(meta["og:site_name"], host), 120), Text: text}, nil
}

func paragraphs(root *html.Node) string {
	var parts []string
	size := 0
	walk(root, func(n *html.Node) bool {
		if size >= maxText {
			return false
		}
		if n.Type == html.ElementNode && n.Data == "p" {
			p := clean(textOf(n), maxText-size)
			if p != "" {
				parts = append(parts, p)
				size += len([]rune(p)) + 1
			}
			return false
		}
		return true
	})
	return strings.Join(parts, "\n")
}

func walk(n *html.Node, visit func(*html.Node) bool) {
	if n == nil {
		return
	}
	if n.Type == html.ElementNode {
		switch n.Data {
		case "script", "style", "nav", "header", "footer", "aside", "template", "noscript", "svg":
			return
		}
		if attr(n, "aria-hidden") == "true" {
			return
		}
		for _, a := range n.Attr {
			if a.Key == "hidden" {
				return
			}
		}
	}
	if visit(n) {
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			walk(child, visit)
		}
	}
}

func textOf(n *html.Node) string {
	var b strings.Builder
	walk(n, func(n *html.Node) bool {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		if n.Type == html.ElementNode && n.Data == "br" {
			b.WriteByte(' ')
		}
		return true
	})
	return b.String()
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func clean(raw string, limit int) string {
	s := strings.Join(strings.FieldsFunc(raw, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}), " ")
	runes := []rune(s)
	if len(runes) > limit {
		return strings.TrimSpace(string(runes[:limit]))
	}
	return s
}

func first(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
