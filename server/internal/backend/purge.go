package backend

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"spark/server/internal/contract"
	"spark/server/internal/store"
)

const purgeQueue = "collection_purge"

type purgeArgs struct {
	UserID       string `json:"user_id"`
	CollectionID string `json:"collection_id"`
}

func (purgeArgs) Kind() string { return "spark_purge_collection" }

func deletionParams(uid, cid string) store.GetCollectionDeletionParams {
	return store.GetCollectionDeletionParams{UserID: idPG(uid), CollectionID: idPG(cid)}
}

func queuePurge(ctx context.Context, tx pgx.Tx, queue *river.Client[pgx.Tx], uid, cid string) error {
	_, err := queue.InsertTx(ctx, tx, purgeArgs{UserID: uid, CollectionID: cid}, &river.InsertOpts{
		Queue: purgeQueue, MaxAttempts: 8,
		UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{
			rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRunning,
			rivertype.JobStateRetryable, rivertype.JobStateScheduled,
		}},
	})
	return err
}

func registerPurge(ctx context.Context, tx pgx.Tx, queue *river.Client[pgx.Tx], uid, cid string, version int64) (store.DeletionLedger, error) {
	params := deletionParams(uid, cid)
	row, err := store.New(tx).RequestCollectionPurge(ctx, store.RequestCollectionPurgeParams{
		ID: idPG(uuid.NewString()), UserID: params.UserID, CollectionID: params.CollectionID, BaseResourceVersion: version,
	})
	if err != nil {
		return row, err
	}
	return row, queuePurge(ctx, tx, queue, uid, cid)
}

func (s *Server) purgeCollection(c *gin.Context) (any, error) {
	req, err := bind[contract.ResourceCondition](s, c)
	if err != nil {
		return nil, err
	}
	ctx, uid, cid := c.Request.Context(), current(c).User.ID, uuid.MustParse(c.Param("id")).String()
	params := deletionParams(uid, cid)
	return s.idempotentWithReplay(c, req, 202, func(tx pgx.Tx) (any, error) {
		existing, err := store.New(tx).GetCollectionDeletion(ctx, params)
		if err == nil {
			return idempotentCurrentResponse{body: purgeStatus(existing)}, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if !s.Config.PurgeEnabled {
			return nil, problem(503, "integration_not_configured", "永久删除暂未开启。")
		}
		var trashed bool
		var version int64
		if err := tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,resource_version
			FROM collections WHERE user_id=$1 AND id=$2 FOR UPDATE`, params.UserID, params.CollectionID).Scan(&trashed, &version); err != nil {
			return nil, err
		}
		if !trashed {
			return nil, problem(409, "collection_not_in_trash", "请先将收藏移入回收站。")
		}
		if version != int64(req.BaseResourceVersion) {
			return nil, conflict("resource_conflict", "current_resource_version", version)
		}
		row, err := registerPurge(ctx, tx, s.Organizer.Queue, uid, cid, version)
		if err != nil {
			return nil, err
		}
		return idempotentCurrentResponse{body: purgeStatus(row)}, nil
	}, func(tx pgx.Tx, _ json.RawMessage) (any, error) {
		row, err := store.New(tx).GetCollectionDeletion(ctx, params)
		return purgeStatus(row), err
	})
}

func (s *Server) getPurgeStatus(c *gin.Context) (any, error) {
	row, err := store.New(s.Pool).GetCollectionDeletion(c.Request.Context(), deletionParams(current(c).User.ID, c.Param("id")))
	return purgeStatus(row), err
}

func purgeStatus(row store.DeletionLedger) contract.Accepted {
	status := contract.AcceptedStatus("queued")
	if row.CompletedAt.Valid {
		status = "completed"
	} else if row.ReplicatedAt.Valid {
		status = "running"
	}
	return contract.Accepted{OperationId: uuid.UUID(row.ID.Bytes), Status: status}
}
