-- name: ListDueCollectionsForPurge :many
SELECT user_id, id, resource_version FROM collections
WHERE deleted_at IS NOT NULL AND purge_requested_at IS NULL AND purge_after <= now()
ORDER BY purge_after, id LIMIT $1;

-- name: RequestCollectionPurge :one
-- Use the account change lock and include the cleanup job in the caller's transaction.
-- Marking the collection hides it before any external object deletion.
WITH marked AS (
 UPDATE collections c
 SET purge_requested_at = now(), updated_at = now(), resource_version = c.resource_version + 1
 WHERE c.user_id = sqlc.arg(user_id) AND c.id = sqlc.arg(collection_id)
   AND c.resource_version = sqlc.arg(base_resource_version)
   AND c.deleted_at IS NOT NULL AND c.purge_requested_at IS NULL
 RETURNING c.user_id, c.id, c.purge_requested_at, c.resource_version
), counter AS (
 UPDATE user_change_counters ctr SET last_seq = last_seq + 1 FROM marked c
 WHERE ctr.user_id = c.user_id RETURNING ctr.user_id, ctr.last_seq
), event AS (
 INSERT INTO change_events (user_id, seq, resource_type, resource_id, resource_version, action)
 SELECT c.user_id, ctr.last_seq, 'collection', c.id, c.resource_version, 'delete'
 FROM marked c JOIN counter ctr ON ctr.user_id = c.user_id
)
INSERT INTO deletion_ledger (id, user_id, collection_id, object_keys, requested_at)
SELECT sqlc.arg(id), c.user_id, c.id, COALESCE((
 SELECT jsonb_agg(keys.object_key ORDER BY keys.object_key)
 FROM (
   SELECT a.object_key FROM attachments a WHERE (a.user_id, a.collection_id) = (c.user_id, c.id)
   UNION
   SELECT u.staging_key FROM attachments a JOIN uploads u ON (u.user_id, u.id) = (a.user_id, a.upload_id)
   WHERE (a.user_id, a.collection_id) = (c.user_id, c.id)
 ) keys
), '[]'::jsonb), c.purge_requested_at FROM marked c
RETURNING *;

-- name: GetCollectionDeletion :one
SELECT * FROM deletion_ledger WHERE user_id = $1 AND collection_id = $2;

-- name: MarkDeletionReplicated :execrows
UPDATE deletion_ledger SET replicated_at = COALESCE(replicated_at, now())
WHERE user_id = $1 AND id = $2;

-- name: MarkDeletionCompleted :execrows
-- Call only after successful object deletion. Keep the tombstone for old create retries.
UPDATE deletion_ledger d SET completed_at = COALESCE(d.completed_at, now())
WHERE d.user_id = $1 AND d.id = $2 AND d.replicated_at IS NOT NULL
  AND d.object_cursor = jsonb_array_length(d.object_keys)
  AND NOT EXISTS (
    SELECT 1 FROM collections c WHERE (c.user_id, c.id) = (d.user_id, d.collection_id)
  );
