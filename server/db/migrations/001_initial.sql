CREATE TABLE users (
 id uuid PRIMARY KEY, email_normalized text NOT NULL UNIQUE, password_hash text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 role text NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')), ai_enabled boolean NOT NULL DEFAULT false,
 ai_policy_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_challenges (
 id uuid PRIMARY KEY, email_normalized text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('register','password_reset')),
 code_digest bytea NOT NULL, expires_at timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_challenge_lookup ON email_challenges(email_normalized,purpose,created_at DESC);
CREATE TABLE mail_outbox (
 challenge_id uuid PRIMARY KEY REFERENCES email_challenges(id), encrypted_payload bytea,
 expires_at timestamptz NOT NULL, delivered_at timestamptz
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token_digest bytea UNIQUE NOT NULL,
 csrf_digest bytea NOT NULL, expires_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, device_label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_rate_limits (
 key bytea PRIMARY KEY, window_start timestamptz NOT NULL, count int NOT NULL
);
CREATE TABLE invite_batches (
 id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invite_codes (
 id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES invite_batches(id), code_digest bytea NOT NULL UNIQUE,
 expires_at timestamptz, max_uses int NOT NULL DEFAULT 1 CHECK(max_uses=1), used_count int NOT NULL DEFAULT 0,
 disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(used_count BETWEEN 0 AND max_uses)
);
CREATE TABLE invite_redemptions (
 id uuid PRIMARY KEY, invite_id uuid NOT NULL REFERENCES invite_codes(id), user_id uuid NOT NULL UNIQUE REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invite_imports (
 id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES users(id), name text NOT NULL, payload_digest bytea NOT NULL,
 encrypted_rows bytea, validation_result jsonb NOT NULL, state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','committed','expired')),
 expires_at timestamptz NOT NULL, batch_id uuid REFERENCES invite_batches(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_change_counters (user_id uuid PRIMARY KEY REFERENCES users(id), last_seq bigint NOT NULL DEFAULT 0);
CREATE TABLE change_events (
 user_id uuid NOT NULL REFERENCES users(id), seq bigint NOT NULL, resource_type text NOT NULL, resource_id uuid NOT NULL,
 resource_version bigint NOT NULL, action text NOT NULL CHECK(action IN ('upsert','delete')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,seq)
);
CREATE TABLE projects (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), name varchar(100) NOT NULL, description varchar(2000) NOT NULL,
 focus_points jsonb NOT NULL, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','completed')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id)
);
CREATE INDEX projects_user ON projects(user_id,updated_at DESC,id DESC);
CREATE TABLE collections (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), document jsonb NOT NULL, plain_text text NOT NULL, intent text NOT NULL,
 original_url text NOT NULL DEFAULT '', manual_title text NOT NULL DEFAULT '', content_version bigint NOT NULL DEFAULT 1,
 resource_version bigint NOT NULL DEFAULT 1, decision_version bigint NOT NULL DEFAULT 1,
 read_at timestamptz, ai_excluded boolean NOT NULL DEFAULT false, ai_policy_version bigint NOT NULL DEFAULT 1,
 deleted_at timestamptz, purge_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id)
);
CREATE INDEX collections_active ON collections(user_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX collections_trash ON collections(user_id,created_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
CREATE TABLE collection_revisions (
 user_id uuid NOT NULL, collection_id uuid NOT NULL, content_version bigint NOT NULL, document jsonb NOT NULL,
 intent text NOT NULL, original_url text NOT NULL, manual_title text NOT NULL, attachment_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(collection_id,content_version), FOREIGN KEY(user_id,collection_id) REFERENCES collections(user_id,id)
);
CREATE TABLE collection_projects (
 user_id uuid NOT NULL, collection_id uuid NOT NULL, project_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('manual','confirmed','auto','rejected','suggested')),
 reason text, evidence jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,project_id), FOREIGN KEY(user_id,collection_id) REFERENCES collections(user_id,id), FOREIGN KEY(user_id,project_id) REFERENCES projects(user_id,id)
);
CREATE INDEX project_collections ON collection_projects(user_id,project_id,decision);
CREATE TABLE idempotency_keys (
 user_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL, key text NOT NULL, request_digest bytea NOT NULL,
 response_status int NOT NULL, response_json jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,operation,key)
);
CREATE TABLE admin_audit (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, target_type text NOT NULL,
 target_id uuid, safe_metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
