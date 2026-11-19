ALTER TABLE collections ADD COLUMN purge_requested_at timestamptz,
 ADD CONSTRAINT collections_purge_requires_trash CHECK (purge_requested_at IS NULL OR deleted_at IS NOT NULL);

CREATE INDEX collections_purge_due ON collections(purge_after, id)
 WHERE deleted_at IS NOT NULL AND purge_requested_at IS NULL;

CREATE TABLE uploads (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 staging_key text NOT NULL UNIQUE CHECK (staging_key <> ''),
 final_key text UNIQUE CHECK (final_key <> '' AND final_key <> staging_key),
 provider_version text,
 filename varchar(200) NOT NULL CHECK (filename <> ''),
 declared_size bigint NOT NULL CHECK (declared_size BETWEEN 1 AND 5242880),
 actual_size bigint CHECK (actual_size = declared_size),
 mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/gif','image/webp')),
 sha256 bytea CHECK (octet_length(sha256) = 32),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verifying','ready','attached','rejected','expired')),
 error_code text,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, id),
 CHECK (status NOT IN ('ready','attached') OR (final_key IS NOT NULL AND actual_size IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX uploads_user_status_expiry ON uploads(user_id, status, expires_at, id);
CREATE INDEX uploads_cleanup ON uploads(expires_at, id) WHERE status <> 'attached';

CREATE TABLE attachments (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 upload_id uuid NOT NULL UNIQUE,
 object_key text NOT NULL UNIQUE CHECK (object_key <> ''),
 provider_version text,
 filename varchar(200) NOT NULL CHECK (filename <> ''),
 mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/gif','image/webp')),
 size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
 sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
 position int NOT NULL CHECK (position BETWEEN 0 AND 8),
 removed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, id),
 UNIQUE (user_id, collection_id, id),
 FOREIGN KEY (user_id, collection_id) REFERENCES collections(user_id, id),
 FOREIGN KEY (user_id, upload_id) REFERENCES uploads(user_id, id)
);
-- A statement can reorder several active attachments at once. Removed
-- attachments keep their original positions without reserving those slots.
ALTER TABLE attachments ADD COLUMN active_position int
 GENERATED ALWAYS AS (CASE WHEN removed_at IS NULL THEN position END) STORED;
ALTER TABLE attachments ADD CONSTRAINT attachments_active_position
 UNIQUE (collection_id, active_position) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE extractions (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 content_version bigint NOT NULL CHECK (content_version >= 1),
 source_kind text NOT NULL CHECK (source_kind IN ('url','image')),
 source_id text NOT NULL CHECK (source_id <> ''),
 attachment_id uuid,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed','skipped','blocked')),
 text text,
 source_title text,
 evidence_meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence_meta) = 'object'),
 error_code text,
 extractor_version text NOT NULL CHECK (extractor_version <> ''),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, id),
 UNIQUE (user_id, collection_id, content_version, source_kind, source_id, extractor_version),
 FOREIGN KEY (user_id, collection_id) REFERENCES collections(user_id, id),
 FOREIGN KEY (user_id, collection_id, attachment_id) REFERENCES attachments(user_id, collection_id, id),
 CHECK ((source_kind = 'image' AND attachment_id IS NOT NULL AND source_id = attachment_id::text)
     OR (source_kind = 'url' AND attachment_id IS NULL))
);
CREATE INDEX extractions_attachment ON extractions(user_id, collection_id, attachment_id) WHERE attachment_id IS NOT NULL;

-- The same-user collection key is the durable tombstone. The ledger must
-- survive even when the source collection is physically removed.
CREATE TABLE deletion_ledger (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 collection_id uuid NOT NULL,
 object_keys jsonb NOT NULL CHECK (jsonb_typeof(object_keys) = 'array'),
 requested_at timestamptz NOT NULL DEFAULT now(),
 replicated_at timestamptz,
 completed_at timestamptz,
 UNIQUE (user_id, id),
 UNIQUE (user_id, collection_id),
 CHECK (replicated_at IS NULL OR replicated_at >= requested_at),
 CHECK (completed_at IS NULL OR (replicated_at IS NOT NULL AND completed_at >= replicated_at))
);
