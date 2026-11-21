CREATE TABLE collection_image_notes (
 user_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 attachment_id uuid NOT NULL,
 source_extraction_id uuid,
 text varchar(2000) NOT NULL,
 state text NOT NULL CHECK (state IN ('generated','edited','removed')),
 version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
 PRIMARY KEY (user_id,attachment_id),
 FOREIGN KEY (user_id,collection_id,attachment_id) REFERENCES attachments(user_id,collection_id,id) ON DELETE CASCADE,
 FOREIGN KEY (user_id,source_extraction_id) REFERENCES extractions(user_id,id) ON DELETE SET NULL (source_extraction_id),
 CHECK ((text='')=(state='removed'))
);
CREATE INDEX collection_image_notes_collection ON collection_image_notes (user_id,collection_id);

-- Materialize descriptions the owner could already read. The migration does
-- not enqueue work or reinterpret the original collection document.
INSERT INTO collection_image_notes(user_id,collection_id,attachment_id,source_extraction_id,text,state)
SELECT DISTINCT ON (e.user_id,e.attachment_id) e.user_id,e.collection_id,e.attachment_id,e.id,
 left(btrim(e.evidence_meta->>'description', E' \t\r\n'),2000),'generated'
FROM current_image_extractions e
JOIN attachments a ON (a.user_id,a.collection_id,a.id)=(e.user_id,e.collection_id,e.attachment_id)
WHERE e.extractor_version IN ('deepseek-flash-image-v1','deepseek-flash-image-recovery-v1','deepseek-flash-image-recovery-v2')
 AND e.status IN ('succeeded','partial') AND a.removed_at IS NULL
 AND btrim(e.evidence_meta->>'description', E' \t\r\n')<>''
ORDER BY e.user_id,e.attachment_id,e.updated_at DESC,e.id;

CREATE CONSTRAINT TRIGGER organization_image_note_changed AFTER INSERT OR UPDATE ON collection_image_notes
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark_notify_organization();

ALTER TABLE organization_runs
 ADD COLUMN image_extraction_ids text[] NOT NULL DEFAULT '{}',
 ADD COLUMN image_archive_status text CHECK (image_archive_status IN ('linked','created'));

CREATE FUNCTION spark_project_topic(name text) RETURNS text
 LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE
 RETURN lower(btrim(regexp_replace(normalize(name, NFKC), '[[:space:]]+', ' ', 'g')));

CREATE INDEX projects_user_topic ON projects (user_id,spark_project_topic(name));

CREATE OR REPLACE VIEW organization_current_image_runs AS
SELECT r.user_id,r.id AS run_id
FROM organization_runs r JOIN users u ON u.id=r.user_id
JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
WHERE r.image_user_policy_version=u.image_policy_version
 AND r.user_policy_version=u.ai_policy_version AND r.collection_policy_version=c.ai_policy_version
 AND r.content_version=c.content_version
 AND u.status='active' AND u.ai_enabled AND u.ai_consent_version IN ('spark-ai-image-material-v1','spark-ai-image-notes-v1')
 AND u.image_consent_version='deepseek-images-v1' AND NOT c.ai_excluded
 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL;
