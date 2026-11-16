package ai

import (
	"context"
	"regexp"
	"strings"
	"unicode/utf8"

	"spark/internal/model"
)

type ruleGroup struct {
	tag   string
	regex *regexp.Regexp
}

var ruleGroups = []ruleGroup{
	{"AI", regexp.MustCompile(`(?i)人工智能|大模型|机器学习|\b(ai|llm|gpt|claude|openai|anthropic)\b`)},
	{"开发", regexp.MustCompile(`(?i)编程|代码|开发|接口|数据库|\b(react|next\.?js|typescript|javascript|python|golang|mygo|github|api|sqlite)\b`)},
	{"设计", regexp.MustCompile(`(?i)设计|排版|交互|配色|\b(ui|ux|figma|design)\b`)},
	{"阅读", regexp.MustCompile(`(?i)读书|阅读|文章|书单|笔记|\b(book|read|article)\b`)},
	{"工作", regexp.MustCompile(`(?i)工作|会议|项目|客户|需求|计划|汇报|\b(work|meeting|project)\b`)},
	{"生活", regexp.MustCompile(`(?i)生活|旅行|旅游|做饭|美食|运动|散步|跑步|健身|\b(travel|food|life)\b`)},
	{"灵感", regexp.MustCompile(`(?i)灵感|想法|创意|点子|也许|\b(idea|inspiration)\b`)},
	{"待办", regexp.MustCompile(`(?i)待办|明天|下周|记得|需要|\b(todo|to-do|remind)\b`)},
}

var (
	hashtagRegex    = regexp.MustCompile(`(?:^|\s)#([\p{L}\p{N}_-]{1,24})`)
	urlStripRegex   = regexp.MustCompile(`(?i)https?://\S+`)
	firstSentenceRe = regexp.MustCompile(`^.*?[。！？.!?](?:\s|$)`)
	endPunctRe      = regexp.MustCompile(`[。！？.!?…]$`)
)

func OrganizeWithRules(input OrganizeInput) model.Organization {
	text := strings.TrimSpace(input.Title + " " + input.Content)

	seen := make(map[string]struct{})
	var tags []string
	addTag := func(tag string) {
		if tag == "" || len(tags) >= 5 {
			return
		}
		if _, ok := seen[tag]; ok {
			return
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}

	for _, m := range hashtagRegex.FindAllStringSubmatch(text, -1) {
		if len(m) > 1 {
			addTag(m[1])
		}
	}
	for _, g := range ruleGroups {
		if g.regex.MatchString(text) {
			addTag(g.tag)
		}
	}
	if len(tags) == 0 {
		switch input.Source {
		case model.SourceImage:
			addTag("图片收藏")
		case model.SourceURL:
			addTag("稍后阅读")
		default:
			addTag("随手记")
		}
	}

	rawSource := input.Title
	if strings.TrimSpace(rawSource) == "" {
		rawSource = input.Content
	}
	raw := strings.Join(strings.Fields(urlStripRegex.ReplaceAllString(rawSource, "")), " ")
	first := raw
	if m := firstSentenceRe.FindString(raw); m != "" {
		first = strings.TrimSpace(m)
	}

	summary := first
	if utf8.RuneCountInString(summary) > 78 {
		runes := []rune(summary)
		summary = string(runes[:77]) + "…"
	}
	if summary == "" {
		if input.Source == model.SourceImage {
			summary = "保存了一张图片，可补充文字帮助整理。"
		} else {
			summary = "收藏了一个链接，留待稍后阅读。"
		}
	} else if !endPunctRe.MatchString(summary) {
		summary += "。"
	}

	return model.Organization{
		Tags:    tags,
		Summary: summary,
	}
}

type RulesProvider struct{}

func (RulesProvider) Name() string { return "rules" }

func (RulesProvider) Organize(_ context.Context, input OrganizeInput) (model.Organization, error) {
	return OrganizeWithRules(input), nil
}
