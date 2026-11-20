ALTER TABLE mail_outbox
 ADD COLUMN delivery_state text NOT NULL DEFAULT 'development',
 ADD CONSTRAINT mail_outbox_delivery_state
  CHECK (delivery_state IN ('development','queued','accepted','failed','uncertain','cancelled')),
 ADD CONSTRAINT mail_outbox_terminal_payload
  CHECK (delivery_state IN ('development','queued') OR encrypted_payload IS NULL);
