ALTER TABLE collections ADD COLUMN last_opened_at timestamptz;
ALTER TABLE users ADD COLUMN resurface_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE resurface_days (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 local_date date NOT NULL,
 PRIMARY KEY (user_id, local_date)
);

CREATE TABLE resurface_items (
 user_id uuid NOT NULL,
 local_date date NOT NULL,
 collection_id uuid NOT NULL,
 position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
 reason text NOT NULL CHECK (reason IN ('unclassified','inactive_project','anniversary')),
 hidden boolean NOT NULL DEFAULT false,
 PRIMARY KEY (user_id, local_date, collection_id),
 UNIQUE (user_id, local_date, position),
 FOREIGN KEY (user_id, local_date) REFERENCES resurface_days(user_id, local_date) ON DELETE CASCADE,
 FOREIGN KEY (user_id, collection_id) REFERENCES collections(user_id, id) ON DELETE CASCADE
);
