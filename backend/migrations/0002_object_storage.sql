-- Phase B moves new file bodies to S3-compatible object storage while keeping
-- legacy bytea rows readable. The content column is intentionally retained for
-- rollback/backfill; a later verified migration may remove it.

ALTER TABLE project_files
  ADD COLUMN object_key text,
  ADD COLUMN object_version_id text,
  ADD COLUMN object_etag text,
  ADD COLUMN object_stored_at timestamptz;

ALTER TABLE project_files
  ALTER COLUMN content DROP NOT NULL;

ALTER TABLE project_files
  ADD CONSTRAINT project_files_storage_source_ck
  CHECK (
    (
      object_key IS NULL
      AND object_version_id IS NULL
      AND object_etag IS NULL
      AND object_stored_at IS NULL
      AND content IS NOT NULL
    )
    OR (
      object_key IS NOT NULL
      AND btrim(object_key) <> ''
      AND object_stored_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX project_files_object_key_uidx
  ON project_files (object_key)
  WHERE object_key IS NOT NULL;

