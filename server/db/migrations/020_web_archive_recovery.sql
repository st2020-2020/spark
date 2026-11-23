ALTER TABLE organization_runs
 ADD COLUMN web_archive_decision_version bigint,
 ADD COLUMN web_archive_recovery_of uuid,
 ADD CONSTRAINT organization_web_archive_recovery_valid CHECK (
  (web_archive_decision_version IS NULL OR (web_archive AND web_archive_decision_version >= 1))
  AND (web_archive_recovery_of IS NULL OR (web_archive_decision_version IS NOT NULL AND web_archive_recovery_of <> id))
 ),
 ADD FOREIGN KEY (user_id,web_archive_recovery_of) REFERENCES organization_runs(user_id,id);

CREATE UNIQUE INDEX organization_web_archive_recovery_once
 ON organization_runs(user_id,collection_id,content_version) WHERE web_archive_recovery_of IS NOT NULL;
