package backend

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"spark/server/internal/contract"
	"spark/server/internal/store"
	"spark/server/internal/webextract"
)

const (
	urlExtractorVersion = "web-v1"
	urlExtractionQueue  = "url_extraction"
)

type urlExtractionArgs struct {
	UserID       string `json:"user_id"`
	CollectionID string `json:"collection_id"`
	ExtractionID string `json:"extraction_id"`
}

func (urlExtractionArgs) Kind() string { return "spark_extract_url" }

type webPageMetadata struct {
	SiteName string `json:"site_name,omitempty"`
	Summary  string `json:"summary,omitempty"`
}

func urlExtractionParams(uid, id string) store.GetCurrentURLExtractionParams {
	return store.GetCurrentURLExtractionParams{UserID: idPG(uid), CollectionID: idPG(id), ExtractorVersion: urlExtractorVersion}
}

// The caller holds the account change lock. The queued row and its River
// job become visible together with the saved collection.
func (s *Server) enqueueURLExtraction(ctx context.Context, tx pgx.Tx, uid, id string, refresh bool) (store.Extraction, error) {
	var row store.Extraction
	if !s.Config.URLExtractEnabled {
		return row, nil
	}
	params := urlExtractionParams(uid, id)
	var source string
	var version int64
	err := tx.QueryRow(ctx, `SELECT original_url,content_version FROM collections
		WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`, params.UserID, params.CollectionID).Scan(&source, &version)
	if err != nil {
		return row, err
	}
	if source == "" {
		if refresh {
			return row, problem(422, "missing_url", "这条收藏没有可获取的主要网址。")
		}
		return row, nil
	}
	q := store.New(tx)
	inserted, err := q.EnsureCurrentExtraction(ctx, store.EnsureCurrentExtractionParams{
		ID: idPG(uuid.NewString()), UserID: params.UserID, CollectionID: params.CollectionID,
		ContentVersion: version, SourceKind: "url", SourceID: source, ExtractorVersion: urlExtractorVersion,
	})
	if err != nil {
		return row, err
	}
	row, err = q.GetCurrentURLExtraction(ctx, params)
	if err != nil {
		return row, err
	}
	active := row.Status == "queued" || row.Status == "running"
	if inserted == 0 && !refresh && !active {
		return row, nil
	}
	if inserted == 0 && (!active || !refresh) {
		// A refresh replaces a terminal result. Restoring a collection can
		// also resume interrupted work. Give the replacement a new ID so
		// a finishing River job cannot consume or overwrite it.
		_, err = tx.Exec(ctx, `UPDATE extractions SET id=$4,status='queued',text=NULL,source_title=NULL,
			evidence_meta='{}',error_code=NULL,updated_at=clock_timestamp()
			WHERE user_id=$1 AND collection_id=$2 AND id=$3`, row.UserID, row.CollectionID, row.ID, idPG(uuid.NewString()))
		if err != nil {
			return row, err
		}
		row, err = q.GetCurrentURLExtraction(ctx, params)
		if err != nil {
			return row, err
		}
	}
	_, err = s.Organizer.Queue.InsertTx(ctx, tx, urlExtractionArgs{
		UserID: uid, CollectionID: id, ExtractionID: uuid.UUID(row.ID.Bytes).String(),
	}, &river.InsertOpts{
		Queue: urlExtractionQueue, MaxAttempts: 3,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRunning,
			rivertype.JobStateRetryable, rivertype.JobStateScheduled,
		}},
	})
	return row, err
}

func updateURLExtraction(ctx context.Context, q *store.Queries, row store.Extraction, status string, page webextract.Page, code string) (store.Extraction, error) {
	text := func(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }
	return q.UpdateCurrentExtraction(ctx, store.UpdateCurrentExtractionParams{
		UserID: row.UserID, CollectionID: row.CollectionID, ID: row.ID, ContentVersion: row.ContentVersion,
		ExpectedUpdatedAt: row.UpdatedAt, Status: status, Text: text(page.Text), SourceTitle: text(page.Title),
		EvidenceMeta: jsonBytes(webPageMetadata{SiteName: page.SiteName, Summary: page.Summary}), ErrorCode: text(code),
	})
}

func (s *Server) getExtractions(c *gin.Context) (any, error) {
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	var exists bool
	if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collections WHERE user_id=$1 AND id=$2 AND purge_requested_at IS NULL)`, uid, id).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, notFound
	}
	rows, err := store.New(s.Pool).ListCurrentExtractions(ctx, store.ListCurrentExtractionsParams{UserID: idPG(uid), CollectionID: idPG(id)})
	if err != nil {
		return nil, err
	}
	result := contract.ExtractionList{Items: make([]contract.Extraction, 0, len(rows))}
	for _, row := range rows {
		disabled := row.SourceKind == "url" && !s.Config.URLExtractEnabled || row.SourceKind == "image" && !s.Config.ImageAnalysisEnabled
		if disabled && (row.Status == "queued" || row.Status == "running") {
			row.Status = "skipped"
			row.ErrorCode = pgtype.Text{String: "integration_not_configured", Valid: true}
		}
		item, err := extractionView(row)
		if err != nil {
			return nil, err
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func (s *Server) refreshURLExtraction(c *gin.Context) (any, error) {
	if !s.Config.URLExtractEnabled {
		return nil, problem(503, "integration_not_configured", "网页信息获取暂未开启。")
	}
	ctx, uid, id := c.Request.Context(), current(c).User.ID, c.Param("id")
	return s.idempotentWithReplay(c, nil, 202, func(tx pgx.Tx) (any, error) {
		row, err := s.enqueueURLExtraction(ctx, tx, uid, id, true)
		if err != nil {
			return nil, err
		}
		view, err := extractionView(row)
		return idempotentCurrentResponse{body: view}, err
	}, func(tx pgx.Tx, _ json.RawMessage) (any, error) {
		row, err := store.New(tx).GetCurrentURLExtraction(ctx, urlExtractionParams(uid, id))
		if err != nil {
			return nil, err
		}
		return extractionView(row)
	})
}

func extractionView(row store.Extraction) (contract.Extraction, error) {
	ptr := func(t pgtype.Text) *string {
		if !t.Valid {
			return nil
		}
		return &t.String
	}
	item := contract.Extraction{
		Id: uuid.UUID(row.ID.Bytes), ContentVersion: int(row.ContentVersion), UpdatedAt: row.UpdatedAt.Time,
		SourceKind: contract.ExtractionSourceKind(row.SourceKind), SourceId: row.SourceID, Status: contract.ExtractionStatus(row.Status),
		SourceTitle: ptr(row.SourceTitle), Text: ptr(row.Text), ErrorCode: ptr(row.ErrorCode),
	}
	if row.SourceKind == "url" {
		var metadata webPageMetadata
		if err := json.Unmarshal(row.EvidenceMeta, &metadata); err != nil {
			return item, fmt.Errorf("decode web page metadata: %w", err)
		}
		if metadata.SiteName != "" {
			item.SiteName = &metadata.SiteName
		}
		if metadata.Summary != "" {
			item.Summary = &metadata.Summary
		}
	} else if row.SourceKind == "image" {
		var metadata imageEvidence
		if err := json.Unmarshal(row.EvidenceMeta, &metadata); err != nil {
			return item, fmt.Errorf("decode image analysis metadata: %w", err)
		}
		if metadata.Description != "" {
			item.ImageDescription = &metadata.Description
		}
		if metadata.Truncated {
			item.Truncated = &metadata.Truncated
		}
		if emptyImageTruncation(row, metadata) || quotaBlockedImageRecovery(row) {
			available := true
			item.ImageRetryAvailable = &available
		}
	}
	return item, nil
}
