ALTER TABLE users ADD COLUMN ai_consent_at timestamptz, ADD COLUMN ai_consent_version text;
CREATE TABLE organization_runs (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, collection_id uuid NOT NULL,
 content_version bigint NOT NULL, user_policy_version bigint NOT NULL, collection_policy_version bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','partial','failed','skipped','blocked','superseded')),
 prompt_version text NOT NULL DEFAULT 'text-v1', matching_policy_version text NOT NULL DEFAULT 'suggestion-v1',
 stages jsonb NOT NULL DEFAULT '[]', project_snapshot jsonb NOT NULL DEFAULT '[]', result jsonb,
 error_code text, attempts int NOT NULL DEFAULT 0, applied_at timestamptz, started_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,id), FOREIGN KEY(user_id,collection_id) REFERENCES collections(user_id,id)
);
CREATE UNIQUE INDEX organization_active_input ON organization_runs(collection_id,content_version,user_policy_version,collection_policy_version,prompt_version,matching_policy_version) WHERE status IN ('queued','running');
CREATE INDEX organization_collection_history ON organization_runs(user_id,collection_id,created_at DESC,id DESC);
CREATE TABLE organization_current (
 user_id uuid NOT NULL, collection_id uuid NOT NULL, run_id uuid NOT NULL, content_version bigint NOT NULL,
 generated_title text NOT NULL, summary text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id), FOREIGN KEY(user_id,collection_id) REFERENCES collections(user_id,id),
 FOREIGN KEY(user_id,run_id) REFERENCES organization_runs(user_id,id)
);
ALTER TABLE collection_projects ADD COLUMN project_version bigint, ADD COLUMN run_id uuid;
ALTER TABLE collection_projects ADD FOREIGN KEY(user_id,run_id) REFERENCES organization_runs(user_id,id);
CREATE TABLE ai_budget_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version bigint NOT NULL DEFAULT 1,
 platform_daily_units bigint NOT NULL DEFAULT 0 CHECK(platform_daily_units BETWEEN 0 AND 1000000000000),
 user_daily_units bigint NOT NULL DEFAULT 0 CHECK(user_daily_units BETWEEN 0 AND 1000000000000),
 worker_concurrency int NOT NULL DEFAULT 2 CHECK(worker_concurrency BETWEEN 1 AND 8)
);
INSERT INTO ai_budget_config(singleton) VALUES(true);
CREATE TABLE daily_budgets (
 scope text NOT NULL CHECK(scope IN ('platform','user')), owner_key text NOT NULL, budget_day date NOT NULL,
 reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0), settled_units bigint NOT NULL DEFAULT 0 CHECK(settled_units>=0),
 PRIMARY KEY(scope,owner_key,budget_day)
);
CREATE TABLE usage_reservations (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, run_id uuid NOT NULL, attempt_no int NOT NULL, budget_day date NOT NULL,
 route text NOT NULL, config_version text NOT NULL, model text NOT NULL, reserved_units bigint NOT NULL CHECK(reserved_units>=0),
 actual_units bigint, input_tokens bigint, output_tokens bigint,
 state text NOT NULL CHECK(state IN ('reserved','settled','released','uncertain')), error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,attempt_no), FOREIGN KEY(user_id,run_id) REFERENCES organization_runs(user_id,id)
);
CREATE INDEX usage_user_day ON usage_reservations(user_id,budget_day);
CREATE TABLE ai_route_failures (
 config_version text NOT NULL, route text NOT NULL, error_code text NOT NULL,
 disabled_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(config_version,route)
);
