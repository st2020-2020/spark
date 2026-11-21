-- The recovery uses its own extraction and ledger. The existing per-attachment,
-- per-extractor uniqueness admits one initial job and one explicit recovery.
CREATE VIEW current_image_extractions AS
SELECT e.* FROM extractions e
WHERE e.source_kind='image'
 AND NOT (e.extractor_version='deepseek-flash-image-v1' AND EXISTS (
  SELECT 1 FROM extractions recovery
  WHERE (recovery.user_id,recovery.collection_id,recovery.attachment_id)=(e.user_id,e.collection_id,e.attachment_id)
   AND recovery.source_kind='image' AND recovery.extractor_version='deepseek-flash-image-recovery-v1'
   AND recovery.image_user_policy_version IS NOT NULL
 ));

CREATE OR REPLACE VIEW organization_image_materials AS
SELECT e.user_id,e.collection_id,e.id AS extraction_id,e.attachment_id,
 e.content_version,e.image_user_policy_version,e.status,
 btrim(COALESCE(e.text,''), E' \t\r\n') AS recognized_text,
 btrim(COALESCE(e.evidence_meta->>'description',''), E' \t\r\n') AS description,
 a.position,u.role
FROM current_image_extractions e JOIN users u ON u.id=e.user_id
JOIN collections c ON (c.user_id,c.id)=(e.user_id,e.collection_id)
JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(e.user_id,e.collection_id,e.attachment_id)
WHERE e.extractor_version IN ('deepseek-flash-image-v1','deepseek-flash-image-recovery-v1')
 AND e.source_id=a.id::text AND e.content_version<=c.content_version
 AND e.image_user_policy_version=u.image_policy_version
 AND e.image_collection_policy_version=c.ai_policy_version
 AND u.status='active' AND u.image_consent_version='deepseek-images-v1'
 AND NOT c.ai_excluded AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND a.removed_at IS NULL
 AND (e.status IN ('queued','running') OR (e.status IN ('succeeded','partial')
  AND (btrim(COALESCE(e.text,''), E' \t\r\n')<>'' OR btrim(COALESCE(e.evidence_meta->>'description',''), E' \t\r\n')<>'')));

CREATE CONSTRAINT TRIGGER organization_image_recovery_queued AFTER INSERT ON extractions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.source_kind='image' AND NEW.extractor_version='deepseek-flash-image-recovery-v1')
EXECUTE FUNCTION spark_notify_organization();
