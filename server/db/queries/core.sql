-- name: GetUserByEmail :one
SELECT * FROM users WHERE email_normalized = $1;
-- name: LockUserChanges :one
SELECT last_seq FROM user_change_counters WHERE user_id = $1 FOR UPDATE;
-- name: RecordChange :exec
WITH counter AS (UPDATE user_change_counters SET last_seq=last_seq+1 WHERE user_id=$1 RETURNING last_seq)
INSERT INTO change_events(user_id,seq,resource_type,resource_id,resource_version,action)
SELECT $1,last_seq,$2,$3,$4,$5 FROM counter;
-- name: GetSession :one
SELECT s.id, s.user_id,s.csrf_digest,s.expires_at,u.email_normalized,u.role,u.status,u.ai_enabled,u.ai_policy_version,u.palette,u.theme,COALESCE(u.ai_consent_version,'') AS ai_consent_version
FROM sessions s JOIN users u ON u.id=s.user_id
WHERE s.token_digest=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active';
