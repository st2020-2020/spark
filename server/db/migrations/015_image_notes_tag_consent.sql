CREATE OR REPLACE VIEW organization_current_image_runs AS
SELECT r.user_id,r.id AS run_id
FROM organization_runs r JOIN users u ON u.id=r.user_id
JOIN collections c ON (c.user_id,c.id)=(r.user_id,r.collection_id)
WHERE r.image_user_policy_version=u.image_policy_version
 AND r.user_policy_version=u.ai_policy_version AND r.collection_policy_version=c.ai_policy_version
 AND r.content_version=c.content_version
 AND u.status='active' AND u.ai_enabled AND u.ai_consent_version IN ('spark-ai-image-material-v1','spark-ai-image-notes-v1','spark-ai-image-notes-v2')
 AND u.image_consent_version='deepseek-images-v1' AND NOT c.ai_excluded
 AND c.deleted_at IS NULL AND c.purge_requested_at IS NULL;
