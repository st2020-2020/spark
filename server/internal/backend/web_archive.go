package backend

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const extensionArchiveConsentVersion = "spark-ai-extension-archive-v1"

func allowsWebArchive(consent string) bool {
	return consent == extensionArchiveConsentVersion
}

type webArchiveMaterial struct {
	title, text, intent string
}

var webMaterialURL = regexp.MustCompile(`(?i)https?://[^\s<>\p{Z}\p{Cc}]+`)

func withoutWebURLs(raw string) string {
	return strings.TrimSpace(webMaterialURL.ReplaceAllString(raw, " "))
}

func (m webArchiveMaterial) filtered() webArchiveMaterial {
	return webArchiveMaterial{withoutWebURLs(m.title), withoutWebURLs(m.text), withoutWebURLs(m.intent)}
}

func (m webArchiveMaterial) available() bool {
	clean := m.filtered()
	return clean.title != "" || clean.text != "" || clean.intent != ""
}

func (m webArchiveMaterial) sources(limit int) []textSource {
	clean := m.filtered()
	title := shortText(clean.title, limit/4)
	sources := boundedOrganizationSources(clean.text, clean.intent, nil, limit-utf8.RuneCountInString(title))
	sources[0].original, sources[1].original = m.text, m.intent
	if title != "" {
		sources = append(sources, textSource{ID: "page_title", Text: title, original: m.title})
	}
	return sources
}

// A stray punctuation mark or single-character quote is not enough to file a note.
func substantiveWebEvidence(evidence []modelEvidence) bool {
	for _, item := range evidence {
		n := 0
		for _, r := range item.Quote {
			if unicode.IsLetter(r) || unicode.IsNumber(r) {
				n++
				if n == 2 {
					return true
				}
			}
		}
	}
	return false
}
