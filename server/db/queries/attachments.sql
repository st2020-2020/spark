-- name: CreateUpload :one
INSERT INTO uploads (id, user_id, staging_key, filename, declared_size, mime_type, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetUpload :one
SELECT * FROM uploads WHERE user_id = $1 AND id = $2;

-- name: BeginUploadVerification :one
-- A retry reuses the already reserved final key even if another worker won.
UPDATE uploads
SET status = 'verifying', final_key = COALESCE(final_key, sqlc.arg(final_key)::text),
    updated_at = CASE WHEN status = 'pending' THEN now() ELSE updated_at END
WHERE user_id = $1 AND id = $2 AND status IN ('pending','verifying') AND expires_at > now()
RETURNING *;

-- name: FinishUploadVerification :one
-- A delayed worker cannot overwrite a terminal result or revive an expired upload.
UPDATE uploads
SET status = 'ready', actual_size = sqlc.arg(actual_size)::bigint, sha256 = sqlc.arg(sha256),
    provider_version = sqlc.narg(provider_version), updated_at = now()
WHERE user_id = $1 AND id = $2 AND status = 'verifying' AND expires_at > now()
  AND final_key = sqlc.arg(final_key)::text AND declared_size = sqlc.arg(actual_size)::bigint
RETURNING *;

-- name: RejectUpload :execrows
UPDATE uploads
SET status = 'rejected', error_code = $3, updated_at = now()
WHERE user_id = $1 AND id = $2 AND status = 'verifying' AND expires_at > now();

-- name: ListExpiredUploads :many
SELECT user_id, id FROM uploads
WHERE status <> 'attached' AND expires_at <= now()
ORDER BY expires_at, id LIMIT $1;

-- name: ExpireUpload :one
-- Keep cleanup keys available for retries. An attachment and expiry compete for the same row.
UPDATE uploads SET status = 'expired',
    updated_at = CASE WHEN status = 'expired' THEN updated_at ELSE now() END
WHERE user_id = $1 AND id = $2 AND status <> 'attached' AND expires_at <= now()
RETURNING *;

-- name: MarkUploadStagingCleaned :exec
UPDATE uploads SET staging_cleaned_at = clock_timestamp()
WHERE user_id = $1 AND id = $2 AND staging_cleaned_at IS NULL;

-- name: DeleteExpiredUpload :execrows
DELETE FROM uploads WHERE user_id = $1 AND id = $2 AND status = 'expired';

-- name: AttachUpload :one
-- Call in the collection write transaction, after taking the account change lock.
WITH target AS (
 SELECT c.user_id, c.id FROM collections c
 WHERE c.user_id = sqlc.arg(user_id) AND c.id = sqlc.arg(collection_id) AND c.deleted_at IS NULL
 FOR UPDATE
), consumed AS (
 UPDATE uploads u SET status = 'attached', updated_at = now()
 FROM target c
 WHERE u.user_id = c.user_id AND u.id = sqlc.arg(upload_id) AND u.status = 'ready' AND u.expires_at > now()
 RETURNING u.*
)
INSERT INTO attachments (id, user_id, collection_id, upload_id, object_key, provider_version, filename, mime_type, size_bytes, sha256, position)
SELECT sqlc.arg(id), u.user_id, sqlc.arg(collection_id), u.id, u.final_key, u.provider_version,
       u.filename, u.mime_type, u.actual_size, u.sha256, sqlc.arg(position)
FROM consumed u
RETURNING *;

-- name: GetAttachmentForDownload :one
SELECT a.* FROM attachments a JOIN collections c ON (c.user_id, c.id) = (a.user_id, a.collection_id)
WHERE a.user_id = $1 AND a.id = $2 AND a.removed_at IS NULL AND c.purge_requested_at IS NULL;

-- name: ListCurrentAttachments :many
SELECT a.* FROM attachments a JOIN collections c ON (c.user_id, c.id) = (a.user_id, a.collection_id)
WHERE a.user_id = $1 AND a.collection_id = $2 AND a.removed_at IS NULL AND c.purge_requested_at IS NULL
ORDER BY a.position;

-- name: SetCollectionAttachmentOrder :one
-- The caller holds the account change lock and checks the collection content version.
-- An empty list removes all active attachments. Invalid IDs leave every row untouched.
WITH active AS (
 SELECT a.id FROM attachments a
 WHERE a.user_id = sqlc.arg(user_id) AND a.collection_id = sqlc.arg(collection_id) AND a.removed_at IS NULL
), target AS (
 SELECT c.user_id, c.id FROM collections c
 WHERE c.user_id = sqlc.arg(user_id) AND c.id = sqlc.arg(collection_id) AND c.deleted_at IS NULL
   AND cardinality(sqlc.arg(attachment_ids)::uuid[]) <= 9
   AND cardinality(sqlc.arg(attachment_ids)::uuid[]) =
       (SELECT count(*) FROM active WHERE id = ANY(sqlc.arg(attachment_ids)::uuid[]))
 FOR UPDATE
), reordered AS (
 UPDATE attachments a
 SET position = COALESCE(array_position(sqlc.arg(attachment_ids)::uuid[], a.id) - 1, a.position),
     removed_at = CASE WHEN a.id = ANY(sqlc.arg(attachment_ids)::uuid[]) THEN NULL ELSE now() END
 FROM target c
 WHERE (a.user_id, a.collection_id) = (c.user_id, c.id) AND a.removed_at IS NULL
   AND (a.position + 1 IS DISTINCT FROM array_position(sqlc.arg(attachment_ids)::uuid[], a.id))
 RETURNING a.id
)
SELECT (SELECT count(*) FROM reordered) AS changed FROM target;
