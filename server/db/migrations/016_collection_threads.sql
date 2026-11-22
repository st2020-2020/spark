ALTER TABLE collections
 ADD COLUMN thread_id uuid NOT NULL DEFAULT gen_random_uuid(),
 ADD COLUMN source_collection_id uuid,
 ADD CONSTRAINT collections_follow_up_source
  FOREIGN KEY (user_id,source_collection_id) REFERENCES collections(user_id,id) ON DELETE SET NULL (source_collection_id);

CREATE INDEX collections_thread_order ON collections(user_id,thread_id,created_at,id)
 WHERE purge_requested_at IS NULL;
CREATE INDEX collections_follow_up_source_idx ON collections(user_id,source_collection_id)
 WHERE source_collection_id IS NOT NULL;

-- Keep list counts independent of thread length, including for long-lived threads.
CREATE TABLE collection_thread_counts (
 user_id uuid NOT NULL REFERENCES users(id),
 thread_id uuid NOT NULL,
 member_count bigint NOT NULL,
 active_count bigint NOT NULL,
 PRIMARY KEY (user_id,thread_id),
 CHECK (active_count BETWEEN 0 AND member_count)
);

INSERT INTO collection_thread_counts(user_id,thread_id,member_count,active_count)
SELECT user_id,thread_id,count(*),count(*) FILTER (WHERE deleted_at IS NULL)
FROM collections GROUP BY user_id,thread_id;

CREATE FUNCTION maintain_collection_thread_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  INSERT INTO collection_thread_counts(user_id,thread_id,member_count,active_count)
  VALUES (NEW.user_id,NEW.thread_id,1,(NEW.deleted_at IS NULL)::int)
  ON CONFLICT (user_id,thread_id) DO UPDATE
  SET member_count=collection_thread_counts.member_count+1,
      active_count=collection_thread_counts.active_count+EXCLUDED.active_count;
 ELSIF TG_OP = 'DELETE' THEN
  UPDATE collection_thread_counts
  SET member_count=member_count-1, active_count=active_count-(OLD.deleted_at IS NULL)::int
  WHERE (user_id,thread_id)=(OLD.user_id,OLD.thread_id);
  DELETE FROM collection_thread_counts WHERE (user_id,thread_id)=(OLD.user_id,OLD.thread_id) AND member_count=0;
 ELSIF (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL) THEN
  UPDATE collection_thread_counts SET active_count=active_count+(NEW.deleted_at IS NULL)::int-(OLD.deleted_at IS NULL)::int
  WHERE (user_id,thread_id)=(NEW.user_id,NEW.thread_id);
 END IF;
 RETURN NULL;
END;
$$;

CREATE TRIGGER collection_thread_counts_changed AFTER INSERT OR UPDATE OF deleted_at OR DELETE ON collections
 FOR EACH ROW EXECUTE FUNCTION maintain_collection_thread_counts();
