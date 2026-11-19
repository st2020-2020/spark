ALTER TABLE deletion_ledger
 ADD COLUMN object_cursor integer NOT NULL DEFAULT 0 CHECK (object_cursor BETWEEN 0 AND jsonb_array_length(object_keys));

CREATE INDEX deletion_ledger_pending ON deletion_ledger(requested_at, id)
 WHERE completed_at IS NULL;

-- Financial records outlive the content and model inputs they accounted for.
ALTER TABLE usage_reservations
 DROP CONSTRAINT usage_reservations_user_id_run_id_fkey,
 ADD FOREIGN KEY (user_id) REFERENCES users(id),
 ADD FOREIGN KEY (user_id, run_id) REFERENCES organization_runs(user_id, id)
  ON DELETE SET NULL (run_id),
 ALTER COLUMN run_id DROP NOT NULL;
