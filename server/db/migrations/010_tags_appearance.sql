ALTER TABLE users
 ADD COLUMN palette text NOT NULL DEFAULT 'mint' CHECK(palette IN ('mint','sea','matcha','sakura')),
 ADD COLUMN theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark'));

CREATE TABLE tags (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 name varchar(24) NOT NULL CHECK(name <> ''),
 normalized_name text COLLATE "C" NOT NULL CHECK(normalized_name <> ''),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,id),
 UNIQUE(user_id,normalized_name)
);
CREATE INDEX tags_account_page ON tags(user_id,created_at DESC,id DESC);

CREATE TABLE collection_tags (
 user_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 tag_id uuid NOT NULL,
 decision text NOT NULL CHECK(decision IN ('manual','confirmed','auto','rejected')),
 run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(collection_id,tag_id),
 FOREIGN KEY(user_id,collection_id) REFERENCES collections(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,tag_id) REFERENCES tags(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,run_id) REFERENCES organization_runs(user_id,id),
 CHECK(decision <> 'auto' OR run_id IS NOT NULL)
);
CREATE INDEX collection_tags_account_tag ON collection_tags(user_id,tag_id,collection_id);
