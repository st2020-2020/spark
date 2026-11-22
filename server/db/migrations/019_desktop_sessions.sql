ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check,
 ADD CONSTRAINT sessions_kind_check CHECK (kind IN ('web','extension','desktop'));

ALTER TABLE extension_grants RENAME TO device_grants;
ALTER TABLE device_grants RENAME COLUMN browser TO device;
ALTER TABLE device_grants
 DROP CONSTRAINT extension_grants_browser_check,
 DROP CONSTRAINT extension_grants_pkey,
 ADD COLUMN kind text NOT NULL DEFAULT 'extension',
 ADD PRIMARY KEY (kind,challenge),
 ADD CONSTRAINT device_grants_kind_device CHECK (
  (kind='extension' AND device IN ('chrome','edge')) OR (kind='desktop' AND device='macos')
 );
ALTER TABLE device_grants ALTER COLUMN kind DROP DEFAULT;
ALTER INDEX extension_grants_expiration RENAME TO device_grants_expiration;
ALTER INDEX extension_grants_web_session RENAME TO device_grants_web_session;
