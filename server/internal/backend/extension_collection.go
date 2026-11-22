package backend

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"spark/server/internal/contract"
)

func (s *Server) listExtensionProjects(c *gin.Context) (any, error) {
	rows, limit, err := s.queryProjectPage(c, "active", `SELECT p.id,p.name,p.created_at FROM projects p `)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := contract.ExtensionProjectPage{Items: make([]contract.ExtensionProjectOption, 0, limit)}
	var lastTime time.Time
	for rows.Next() {
		var item contract.ExtensionProjectOption
		var createdAt time.Time
		if err := rows.Scan(&item.Id, &item.Name, &createdAt); err != nil {
			return nil, err
		}
		if len(page.Items) == limit {
			last := page.Items[limit-1]
			next := s.nextCursor(c, lastTime, last.Id.String())
			page.NextCursor = &next
			break
		}
		page.Items = append(page.Items, item)
		lastTime = createdAt
	}
	return page, rows.Err()
}

func extensionDocument(selectedText string) (contract.Document, error) {
	paragraph := contract.Paragraph{Type: "paragraph"}
	if selectedText != "" {
		var content contract.Paragraph_Content_Item
		if err := content.FromTextNode(contract.TextNode{Type: "text", Text: selectedText}); err != nil {
			return contract.Document{}, err
		}
		nodes := []contract.Paragraph_Content_Item{content}
		paragraph.Content = &nodes
	}
	var item contract.DocumentRoot_Content_Item
	if err := item.FromParagraph(paragraph); err != nil {
		return contract.Document{}, err
	}
	return contract.Document{
		SchemaVersion: 1,
		Content:       contract.DocumentRoot{Type: "doc", Content: []contract.DocumentRoot_Content_Item{item}},
	}, nil
}

func (s *Server) createExtensionCollection(c *gin.Context) (any, error) {
	req, err := bind[contract.ExtensionCollectionCreate](s, c)
	if err != nil {
		return nil, err
	}
	selectedText, intent := value(req.SelectedText), value(req.Intent)
	if strings.ContainsRune(selectedText, 0) || strings.ContainsRune(intent, 0) || strings.ContainsRune(value(req.ManualTitle), 0) {
		return nil, problem(422, "validation_failed", "选文、标题和用途不能包含空字符。")
	}
	seenProjects := make(map[uuid.UUID]bool, len(req.ProjectIds))
	for _, project := range req.ProjectIds {
		if seenProjects[project] {
			return nil, problem(422, "validation_failed", "创建时不能重复指定同一项目。")
		}
		seenProjects[project] = true
	}
	document, err := extensionDocument(selectedText)
	if err != nil {
		return nil, err
	}
	plain, originalURL, err := validateContent(document, intent, req.OriginalUrl, false)
	if err != nil {
		return nil, err
	}
	input := contract.CollectionCreate{
		Id: req.Id, Document: document, OriginalUrl: &originalURL, Intent: intent,
		ManualTitle: req.ManualTitle, ProjectIds: req.ProjectIds,
	}
	session, ctx := current(c), c.Request.Context()
	uid, id := session.User.ID, req.Id.String()
	if err := s.rate(ctx, "extension:collect:"+uid, 30, time.Minute); err != nil {
		return nil, err
	}
	authorize := func(tx pgx.Tx) error {
		if _, err := lockDevicePrincipal(ctx, tx, uid, session.ID, extensionSessionKind); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return extensionSessionExpired
			}
			return err
		}
		return checkCollectionTombstone(ctx, tx, uid, id)
	}
	return s.idempotentWithReplay(c, req, 201, func(tx pgx.Tx) (any, error) {
		if err := authorize(tx); err != nil {
			return nil, err
		}
		if err := s.persistCollection(ctx, tx, uid, input, plain, originalURL, true); err != nil {
			return nil, err
		}
		return contract.ExtensionCollectionReceipt{Id: req.Id}, nil
	}, func(tx pgx.Tx, response json.RawMessage) (any, error) {
		if err := authorize(tx); err != nil {
			return nil, err
		}
		return response, nil
	})
}
