-- name: EnsureCurrentExtraction :execrows
-- A duplicate delivery cannot reset an existing result. Collection writes
-- and extraction writes serialize on the collection row.
WITH target AS (
 SELECT c.id, c.user_id, c.content_version FROM collections c
 WHERE c.user_id = sqlc.arg(user_id) AND c.id = sqlc.arg(collection_id)
   AND c.content_version = sqlc.arg(content_version) AND c.deleted_at IS NULL
   AND (
     (sqlc.arg(source_kind)::text = 'url' AND c.original_url = sqlc.arg(source_id)::text)
     OR (sqlc.arg(source_kind)::text = 'image' AND EXISTS (
       SELECT 1 FROM attachments a
       WHERE (a.user_id, a.collection_id) = (c.user_id, c.id) AND a.id = sqlc.narg(attachment_id)
         AND a.removed_at IS NULL
     ))
   )
 FOR UPDATE
)
INSERT INTO extractions (id, user_id, collection_id, content_version, source_kind, source_id, attachment_id, extractor_version)
SELECT sqlc.arg(id), user_id, id, content_version, sqlc.arg(source_kind), sqlc.arg(source_id),
       sqlc.narg(attachment_id), sqlc.arg(extractor_version)
FROM target
ON CONFLICT (user_id, collection_id, content_version, source_kind,
             extraction_identity_digest(source_id), extraction_identity_digest(extractor_version)) DO NOTHING;

-- name: UpdateCurrentExtraction :one
-- Write back only to the version and attempt observed by the worker.
WITH target AS (
 SELECT c.id, c.user_id FROM collections c
 WHERE c.user_id = sqlc.arg(user_id) AND c.id = sqlc.arg(collection_id)
   AND c.content_version = sqlc.arg(content_version) AND c.deleted_at IS NULL
 FOR UPDATE
)
UPDATE extractions e
SET status = sqlc.arg(status), text = sqlc.narg(text), source_title = sqlc.narg(source_title),
    evidence_meta = sqlc.arg(evidence_meta), error_code = sqlc.narg(error_code),
    updated_at = GREATEST(clock_timestamp(), e.updated_at + interval '1 microsecond')
FROM target c
WHERE (e.user_id, e.collection_id) = (c.user_id, c.id) AND e.id = sqlc.arg(id)
  AND e.content_version = sqlc.arg(content_version) AND e.updated_at = sqlc.arg(expected_updated_at)
RETURNING e.*;

-- name: ListCurrentExtractions :many
SELECT sqlc.embed(e), EXISTS(SELECT 1 FROM legacy_image_provider_failures f WHERE (f.user_id,f.id)=(e.user_id,e.id)) AS legacy_image_retry
FROM extractions e JOIN collections c
 ON (c.user_id, c.id) = (e.user_id, e.collection_id)
WHERE e.user_id = $1 AND e.collection_id = $2 AND c.deleted_at IS NULL
 AND ((e.source_kind='url' AND e.content_version=c.content_version AND e.source_id=c.original_url)
 OR (e.source_kind='image' AND (e.image_user_policy_version IS NOT NULL OR e.content_version=c.content_version)
  AND EXISTS (SELECT 1 FROM current_image_extractions i WHERE i.user_id=e.user_id AND i.id=e.id)
  AND EXISTS (SELECT 1 FROM attachments a
   WHERE (a.user_id,a.collection_id,a.id)=(e.user_id,e.collection_id,e.attachment_id) AND a.removed_at IS NULL)))
ORDER BY e.source_kind, e.source_id, e.created_at DESC, e.id;

-- name: GetCurrentURLExtraction :one
SELECT e.* FROM extractions e JOIN collections c
 ON (c.user_id, c.id, c.content_version, c.original_url) = (e.user_id, e.collection_id, e.content_version, e.source_id)
JOIN users u ON u.id = e.user_id
WHERE e.user_id = $1 AND e.collection_id = $2 AND e.source_kind = 'url' AND e.extractor_version = $3
  AND c.deleted_at IS NULL AND u.status = 'active';

-- name: ListAttachmentImageExtractions :many
SELECT e.* FROM extractions e
WHERE e.user_id=$1 AND e.collection_id=$2 AND e.attachment_id=$3
 AND e.source_kind='image' AND e.extractor_version=ANY(sqlc.arg(versions)::text[]) AND e.image_user_policy_version IS NOT NULL;

-- name: CanRecoverLegacyImageProviderFailure :one
SELECT EXISTS(SELECT 1 FROM legacy_image_provider_failures WHERE user_id=$1 AND id=$2);

-- name: InsertImageRecovery :one
INSERT INTO extractions (id,user_id,collection_id,content_version,source_kind,source_id,attachment_id,extractor_version,
                         image_user_policy_version,image_collection_policy_version)
SELECT sqlc.arg(id),e.user_id,e.collection_id,e.content_version,'image',e.source_id,e.attachment_id,sqlc.arg(recovery_version),
       u.image_policy_version,c.ai_policy_version
FROM extractions e JOIN collections c ON (e.user_id,e.collection_id)=(c.user_id,c.id)
 JOIN users u ON u.id=e.user_id
WHERE e.user_id=sqlc.arg(user_id) AND e.id=sqlc.arg(base_id)
RETURNING *;

-- name: RequeueUnsentImageRecovery :one
-- A quota rejection precedes dispatch. Do not reset any job with a ledger,
-- even when a prior attempt released its reservation or remained uncertain.
UPDATE extractions e
SET status='queued',error_code=NULL,image_user_policy_version=u.image_policy_version,
    image_collection_policy_version=c.ai_policy_version,updated_at=clock_timestamp()
FROM collections c JOIN users u ON u.id=c.user_id
WHERE (c.user_id,c.id)=(e.user_id,e.collection_id) AND e.user_id=sqlc.arg(user_id) AND e.id=sqlc.arg(id)
 AND e.status='blocked' AND e.error_code='quota_exceeded'
 AND NOT EXISTS(SELECT 1 FROM usage_reservations r WHERE r.image_extraction_id=e.id)
RETURNING e.*;
