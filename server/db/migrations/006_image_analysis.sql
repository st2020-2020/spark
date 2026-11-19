ALTER TABLE users
 ADD COLUMN image_consent_version text,
 ADD COLUMN image_consented_at timestamptz,
 ADD COLUMN image_policy_version bigint NOT NULL DEFAULT 1 CHECK (image_policy_version >= 1),
 ADD CONSTRAINT users_image_consent_pair CHECK ((image_consent_version IS NULL) = (image_consented_at IS NULL));

ALTER TABLE extractions
 ADD COLUMN image_user_policy_version bigint,
 ADD COLUMN image_collection_policy_version bigint,
 ADD CONSTRAINT extractions_image_policy CHECK (
  (image_user_policy_version IS NULL AND image_collection_policy_version IS NULL)
  OR (source_kind='image' AND image_user_policy_version IS NOT NULL AND image_collection_policy_version IS NOT NULL)
 );

-- Existing image extraction rows may be keyed by content version. New jobs
-- are keyed by immutable, confirmed attachments across all content versions.
CREATE UNIQUE INDEX extractions_image_job ON extractions(user_id, attachment_id, extractor_version)
 WHERE image_user_policy_version IS NOT NULL;

ALTER TABLE usage_reservations
 ADD COLUMN image_extraction_id uuid,
 ADD FOREIGN KEY (user_id, image_extraction_id) REFERENCES extractions(user_id, id)
  ON DELETE SET NULL (image_extraction_id),
 ADD CONSTRAINT usage_reservations_one_source CHECK (run_id IS NULL OR image_extraction_id IS NULL);
CREATE UNIQUE INDEX usage_reservations_image_once ON usage_reservations(image_extraction_id)
 WHERE image_extraction_id IS NOT NULL;
