ALTER TABLE sessions
 ADD COLUMN kind text NOT NULL DEFAULT 'web' CHECK(kind IN ('web','extension')),
 ALTER COLUMN csrf_digest DROP NOT NULL,
 ADD CONSTRAINT sessions_csrf_by_kind CHECK ((kind='web') = (csrf_digest IS NOT NULL));

CREATE TABLE extension_grants (
 challenge bytea PRIMARY KEY CHECK(octet_length(challenge)=32),
 user_id uuid NOT NULL REFERENCES users(id),
 web_session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 browser text NOT NULL CHECK(browser IN ('chrome','edge')),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
CREATE INDEX extension_grants_expiration ON extension_grants(expires_at);
CREATE INDEX extension_grants_web_session ON extension_grants(web_session_id);
