ALTER TABLE collections
 ADD COLUMN capture_source text CHECK (capture_source IN ('extension'));

-- Only an exact, successful extension create receipt establishes old provenance.
-- This migration does not schedule organization work.
UPDATE collections c SET capture_source='extension'
FROM idempotency_keys k
WHERE k.user_id=c.user_id AND k.operation='POST /api/v1/extension/collections' AND k.response_status=201
  AND c.id=CASE WHEN k.response_json->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (k.response_json->>'id')::uuid END;

ALTER TABLE organization_runs
 ADD COLUMN web_archive boolean NOT NULL DEFAULT false,
 ADD COLUMN web_archive_status text CHECK (web_archive_status IS NULL OR (web_archive AND web_archive_status IN ('linked','created','no_match')));
