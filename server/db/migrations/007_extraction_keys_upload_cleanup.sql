-- UTF-8 is explicit, and the database encoding of text is fixed for the
-- database lifetime. Index the digest while retaining and comparing the URL.
CREATE FUNCTION extraction_identity_digest(value text) RETURNS bytea
 LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
 RETURN pg_catalog.sha256(pg_catalog.convert_to(value, 'UTF8'));

CREATE UNIQUE INDEX extractions_bounded_source_identity
 ON extractions(user_id, collection_id, content_version, source_kind,
                extraction_identity_digest(source_id), extraction_identity_digest(extractor_version));
ALTER TABLE extractions DROP CONSTRAINT extractions_user_id_collection_id_content_version_source_ki_key;

ALTER TABLE uploads ADD COLUMN staging_cleaned_at timestamptz;
DROP INDEX uploads_cleanup;
CREATE INDEX uploads_cleanup ON uploads(expires_at, id)
 WHERE status <> 'attached' OR staging_cleaned_at IS NULL;
