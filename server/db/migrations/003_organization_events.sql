CREATE VIEW organization_pending_suggestions AS
SELECT cp.user_id, cp.collection_id, cp.project_id
FROM collection_projects cp
JOIN collections c ON (c.user_id, c.id) = (cp.user_id, cp.collection_id)
JOIN projects p ON (p.user_id, p.id) = (cp.user_id, cp.project_id)
JOIN organization_runs r ON (r.user_id, r.id) = (cp.user_id, cp.run_id)
WHERE cp.decision = 'suggested' AND c.deleted_at IS NULL
  AND r.collection_id = c.id AND r.content_version = c.content_version
  AND p.state = 'active' AND p.version = cp.project_version;

-- Deferred so a run and its suggestion are observed together at commit.
CREATE FUNCTION spark_notify_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_id uuid;
  target_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    owner_id := OLD.user_id;
    target_id := OLD.collection_id;
  ELSE
    owner_id := NEW.user_id;
    IF TG_TABLE_NAME = 'collections' THEN
      target_id := NEW.id;
    ELSE
      target_id := NEW.collection_id;
    END IF;
  END IF;

  PERFORM pg_notify('spark_organization_events', jsonb_build_object(
    'schema', TG_TABLE_SCHEMA, 'user_id', c.user_id, 'collection_id', c.id,
    'status', CASE WHEN c.deleted_at IS NOT NULL THEN 'skipped' ELSE COALESCE((
      SELECT r.status FROM organization_runs r
      WHERE (r.user_id, r.collection_id, r.content_version) = (c.user_id, c.id, c.content_version)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1
    ), 'skipped') END,
    'has_suggestion', EXISTS (
      SELECT 1 FROM organization_pending_suggestions p
      WHERE (p.user_id, p.collection_id) = (c.user_id, c.id)
    )
  )::text)
  FROM collections c WHERE (c.user_id, c.id) = (owner_id, target_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER organization_run_inserted AFTER INSERT ON organization_runs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark_notify_organization();
CREATE CONSTRAINT TRIGGER organization_run_status_changed AFTER UPDATE ON organization_runs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION spark_notify_organization();

CREATE CONSTRAINT TRIGGER organization_collection_changed AFTER UPDATE ON collections
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.content_version IS DISTINCT FROM NEW.content_version OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION spark_notify_organization();

CREATE CONSTRAINT TRIGGER organization_suggestion_inserted AFTER INSERT ON collection_projects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.decision = 'suggested')
EXECUTE FUNCTION spark_notify_organization();
CREATE CONSTRAINT TRIGGER organization_suggestion_updated AFTER UPDATE ON collection_projects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.decision = 'suggested' OR NEW.decision = 'suggested')
EXECUTE FUNCTION spark_notify_organization();
CREATE CONSTRAINT TRIGGER organization_suggestion_removed AFTER DELETE ON collection_projects
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.decision = 'suggested')
EXECUTE FUNCTION spark_notify_organization();

-- Project edits may invalidate many suggestions. A single resync per account
-- bounds notifications independently of the number of affected collections.
CREATE FUNCTION spark_notify_project_resync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM collection_projects cp
             WHERE cp.user_id = NEW.user_id AND cp.project_id = NEW.id AND cp.decision = 'suggested') THEN
    PERFORM pg_notify('spark_organization_events', jsonb_build_object(
      'schema', TG_TABLE_SCHEMA, 'user_id', NEW.user_id, 'resync', true)::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER organization_project_changed AFTER UPDATE ON projects FOR EACH ROW
WHEN (OLD.version IS DISTINCT FROM NEW.version OR OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION spark_notify_project_resync();

CREATE FUNCTION spark_notify_session_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    PERFORM pg_notify('spark_organization_events', jsonb_build_object(
      'schema', TG_TABLE_SCHEMA, 'user_id', OLD.id, 'close_user', true)::text);
  ELSE
    PERFORM pg_notify('spark_organization_events', jsonb_build_object(
      'schema', TG_TABLE_SCHEMA, 'user_id', OLD.user_id, 'close_session', OLD.id)::text);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER organization_session_changed AFTER UPDATE ON sessions FOR EACH ROW
WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
EXECUTE FUNCTION spark_notify_session_closed();
CREATE TRIGGER organization_session_deleted AFTER DELETE ON sessions FOR EACH ROW
EXECUTE FUNCTION spark_notify_session_closed();
CREATE TRIGGER organization_user_disabled AFTER UPDATE ON users FOR EACH ROW
WHEN (OLD.status = 'active' AND NEW.status <> 'active')
EXECUTE FUNCTION spark_notify_session_closed();
