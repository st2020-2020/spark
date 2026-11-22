package backend

import (
	"context"
	"strings"
	"unicode"
	"unicode/utf8"
)

type webFilingTag struct {
	topic modelTopic
	tagID string
	key   string
	score int
}

func concreteWebFilingName(name string) bool {
	if n := utf8.RuneCountInString(name); n < 2 || n > maxAutomaticTopicChars {
		return false
	}
	if withoutWebURLs(name) != name || !strings.ContainsFunc(name, unicode.IsLetter) {
		return false
	}
	switch strings.ToLower(name) {
	case "其他", "其它", "杂项", "未分类", "待归类", "学习", "工作", "参考", "资料", "网页", "链接", "收藏", "笔记", "文章",
		"阅读", "项目", "随笔", "资源", "综合", "动态", "资讯", "新闻", "分享", "总结", "记录", "备忘", "技术",
		"网页收藏", "网站", "实用", "通用", "general", "misc", "other", "resource", "reference", "article", "news", "notes":
		return false
	}
	return true
}

// The model already validated these tags. Require a verifiable quote for
// filing, including a literal quote when a tag was returned without citations.
func groundedWebFilingTag(tag modelTag, sources []textSource) (webFilingTag, bool) {
	name := normalizeModelTopic(tag.Name)
	if !concreteWebFilingName(name) {
		return webFilingTag{}, false
	}
	out := webFilingTag{tagID: tag.ID, key: tagKey(tag.Name),
		topic: modelTopic{Name: name, Reason: "依据与网页材料相符的标签「" + name + "」。"}}
	for _, src := range sources {
		if src.ID != "page_title" && src.ID != "original_text" && src.ID != "intent" {
			continue
		}
		if len(tag.Evidence) == 0 {
			if strings.Contains(src.Text, tag.Name) && strings.Contains(src.original, tag.Name) {
				out.topic.Evidence = append(out.topic.Evidence, modelEvidence{SourceID: src.ID, Quote: tag.Name})
			}
			continue
		}
		for _, e := range tag.Evidence {
			if e.SourceID == src.ID && strings.TrimSpace(e.Quote) != "" && utf8.RuneCountInString(e.Quote) <= 300 &&
				strings.Contains(src.Text, e.Quote) && strings.Contains(src.original, e.Quote) {
				out.topic.Evidence = append(out.topic.Evidence, e)
			}
		}
	}
	if len(tag.Evidence) > 0 && len(out.topic.Evidence) != len(tag.Evidence) {
		return webFilingTag{}, false
	}
	for _, e := range out.topic.Evidence {
		n := 0
		for _, r := range e.Quote {
			if unicode.IsLetter(r) || unicode.IsNumber(r) {
				n++
			}
		}
		literal := strings.Contains(tagKey(e.Quote), out.key)
		if n < 2 || !literal && n < 4 {
			continue
		}
		score := 1
		if e.SourceID == "page_title" {
			score += 2
		}
		if literal {
			score++
		}
		out.score = max(out.score, score)
	}
	return out, out.score > 0
}

// Consider the complete topic index. A current project takes precedence over
// a new topic, and equally strong different topics stay unfiled.
func webFilingTopic(ctx context.Context, q querier, r runSnapshot, tags []modelTag, sources []textSource, historical bool) (*modelTopic, error) {
	var candidates []webFilingTag
	var keys, names []string
	for _, tag := range tags {
		if candidate, ok := groundedWebFilingTag(tag, sources); ok {
			candidates = append(candidates, candidate)
			keys = append(keys, candidate.key)
			names = append(names, candidate.topic.Name)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}

	rows, err := q.Query(ctx, `
		SELECT label.ord, t.id, matches.has_project, matches.has_active
		FROM unnest($3::text[],$4::text[]) WITH ORDINALITY label(tag_key,project_name,ord)
		JOIN tags t ON t.user_id=$1 AND t.normalized_name=label.tag_key
		JOIN collection_tags ct ON (ct.user_id,ct.tag_id)=(t.user_id,t.id) AND ct.collection_id=$2
		CROSS JOIN LATERAL (
			SELECT EXISTS(SELECT 1 FROM projects p WHERE p.user_id=$1
				AND spark_project_topic(p.name)=spark_project_topic(label.project_name)) AS has_project,
			       EXISTS(SELECT 1 FROM projects p WHERE p.user_id=$1 AND p.state='active'
				AND spark_project_topic(p.name)=spark_project_topic(label.project_name)) AS has_active
		) matches
		WHERE ct.decision<>'rejected' AND (NOT $5::boolean OR ct.decision='auto' AND ct.run_id=$6)
		  AND NOT EXISTS(SELECT 1 FROM collection_projects cp
			WHERE (cp.user_id,cp.collection_id)=($1,$2) AND cp.decision='rejected')`,
		r.UID, r.CollectionID, keys, names, historical, r.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var best *modelTopic
	bestScore := 0
	ambiguous := false
	for rows.Next() {
		var ord int
		var tagID string
		var hasProject, hasActive bool
		if err := rows.Scan(&ord, &tagID, &hasProject, &hasActive); err != nil {
			return nil, err
		}
		candidate := candidates[ord-1]
		if candidate.tagID != "" && candidate.tagID != tagID || hasProject && !hasActive {
			continue
		}
		score := candidate.score
		if hasActive {
			score += 10
		}
		if score > bestScore {
			best, bestScore, ambiguous = &candidate.topic, score, false
		} else if score == bestScore && !strings.EqualFold(best.Name, candidate.topic.Name) {
			ambiguous = true
		}
	}
	if err := rows.Err(); err != nil || ambiguous {
		return nil, err
	}
	return best, nil
}
