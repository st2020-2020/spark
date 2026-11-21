ALTER TABLE organization_runs
 ADD COLUMN image_waiting boolean NOT NULL DEFAULT false,
 ADD COLUMN image_user_policy_version bigint;

-- An extraction belongs to the first binding of an immutable attachment.
-- Keep it reusable through unrelated edits, but only while that binding and
-- both image policy versions still match.
CREATE VIEW organization_image_materials AS
SELECT e.user_id,e.collection_id,e.id AS extraction_id,e.attachment_id,
 e.content_version,e.image_user_policy_version,e.status,
 btrim(COALESCE(e.text,''), E' \t\r\n') AS recognized_text,
 btrim(COALESCE(e.evidence_meta->>'description',''), E' \t\r\n') AS description,
 a.position,u.role
FROM extractions e JOIN users u ON u.id=e.user_id
JOIN collections c ON (c.user_id,c.id)=(e.user_id,e.collection_id)
JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(e.user_id,e.collection_id,e.attachment_id)
WHERE e.source_kind='image' AND e.extractor_version='deepseek-flash-image-v1'
 AND e.source_id=a.id::text AND e.content_version<=c.content_version
 AND e.image_user_policy_version=u.image_policy_version
 AND e.image_collection_policy_version=c.ai_policy_version
 AND u.status='active' AND u.image_consent_version='deepseek-images-v1'
 AND NOT c.ai_excluded AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL AND a.removed_at IS NULL
 AND (e.status IN ('queued','running') OR (e.status IN ('succeeded','partial')
  AND (btrim(COALESCE(e.text,''), E' \t\r\n')<>'' OR btrim(COALESCE(e.evidence_meta->>'description',''), E' \t\r\n')<>'')));

CREATE VIEW organization_current_image_runs AS
SELECT r.user_id,r.id AS run_id
FROM organization_runs r JOIN users u ON u.id=r.user_id
JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
WHERE r.image_user_policy_version=u.image_policy_version
 AND r.user_policy_version=u.ai_policy_version AND r.collection_policy_version=c.ai_policy_version
 AND r.content_version=c.content_version
 AND u.status='active' AND u.ai_enabled AND u.ai_consent_version='spark-ai-image-material-v1'
 AND u.image_consent_version='deepseek-images-v1' AND NOT c.ai_excluded
 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL;

CREATE OR REPLACE VIEW organization_pending_suggestions AS
SELECT cp.user_id, cp.collection_id, cp.project_id
FROM collection_projects cp
JOIN collections c ON (c.user_id,c.id)=(cp.user_id,cp.collection_id)
JOIN projects p ON (p.user_id,p.id)=(cp.user_id,cp.project_id)
JOIN organization_runs r ON (r.user_id,r.id)=(cp.user_id,cp.run_id)
WHERE cp.decision='suggested' AND c.deleted_at IS NULL
 AND r.collection_id=c.id AND r.content_version=c.content_version
 AND p.state='active' AND p.version=cp.project_version
 AND (r.image_user_policy_version IS NULL OR EXISTS (SELECT 1 FROM organization_current_image_runs ir
  WHERE (ir.user_id,ir.run_id)=(r.user_id,r.id)));

CREATE CONSTRAINT TRIGGER organization_image_result_changed AFTER UPDATE ON extractions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.source_kind='image' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION spark_notify_organization();

CREATE CONSTRAINT TRIGGER organization_image_wait_changed AFTER UPDATE ON organization_runs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.image_waiting IS DISTINCT FROM NEW.image_waiting)
EXECUTE FUNCTION spark_notify_organization();

CREATE FUNCTION spark_notify_organization_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('spark_organization_events', jsonb_build_object(
    'schema', TG_TABLE_SCHEMA, 'user_id', NEW.id, 'resync', true)::text);
  RETURN NULL;
END;
$$;
CREATE TRIGGER organization_user_policy_changed AFTER UPDATE ON users FOR EACH ROW
WHEN (OLD.ai_policy_version IS DISTINCT FROM NEW.ai_policy_version
   OR OLD.image_policy_version IS DISTINCT FROM NEW.image_policy_version)
EXECUTE FUNCTION spark_notify_organization_policy();

DROP TRIGGER organization_collection_changed ON collections;
CREATE CONSTRAINT TRIGGER organization_collection_changed AFTER UPDATE ON collections
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.content_version IS DISTINCT FROM NEW.content_version OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
   OR OLD.ai_policy_version IS DISTINCT FROM NEW.ai_policy_version)
EXECUTE FUNCTION spark_notify_organization();
