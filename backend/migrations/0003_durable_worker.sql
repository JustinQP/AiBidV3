-- Phase C introduces durable publication and fenced worker leases. Existing
-- in-process running work cannot carry a valid lease, so it is safely returned
-- to the queue before the lease invariant is installed.

UPDATE parse_tasks
SET status = 'queued',
    progress = 0,
    error = NULL,
    started_at = NULL,
    finished_at = NULL,
    updated_at = now()
WHERE status = 'running';

UPDATE project_files AS file
SET parse_status = 'queued',
    updated_at = now()
WHERE file.parse_status = 'parsing'
  AND EXISTS (
    SELECT 1
    FROM parse_tasks AS task
    WHERE task.tenant_id = file.tenant_id
      AND task.project_id = file.project_id
      AND task.file_id = file.id
      AND task.status = 'queued'
  );

ALTER TABLE parse_tasks
  ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_token text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN dead_lettered_at timestamptz;

ALTER TABLE parse_tasks
  ADD CONSTRAINT parse_tasks_lease_shape_ck
  CHECK (
    (
      status = 'running'
      AND lease_token IS NOT NULL
      AND btrim(lease_token) <> ''
      AND lease_owner IS NOT NULL
      AND btrim(lease_owner) <> ''
      AND lease_expires_at IS NOT NULL
    )
    OR (
      status <> 'running'
      AND lease_token IS NULL
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  ADD CONSTRAINT parse_tasks_dead_letter_shape_ck
  CHECK (dead_lettered_at IS NULL OR status = 'failed');

DROP INDEX parse_tasks_recovery_status_created_at_idx;

CREATE INDEX parse_tasks_expired_lease_idx
  ON parse_tasks (lease_expires_at, updated_at)
  WHERE status = 'running';

CREATE INDEX parse_tasks_queued_next_attempt_idx
  ON parse_tasks (next_attempt_at, created_at)
  WHERE status = 'queued';

CREATE TABLE task_outbox (
  id varchar(26) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  task_id varchar(26) NOT NULL,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error jsonb,
  CONSTRAINT task_outbox_task_fk
    FOREIGN KEY (tenant_id, task_id)
    REFERENCES parse_tasks (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT task_outbox_lease_shape_ck
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_owner IS NOT NULL
        AND btrim(lease_owner) <> ''
        AND lease_expires_at IS NOT NULL
      )
    ),
  CONSTRAINT task_outbox_error_shape_ck
    CHECK (last_error IS NULL OR jsonb_typeof(last_error) = 'object'),
  CONSTRAINT task_outbox_published_shape_ck
    CHECK (published_at IS NULL OR (lease_owner IS NULL AND lease_expires_at IS NULL))
);

CREATE INDEX task_outbox_pending_available_idx
  ON task_outbox (available_at, created_at, id)
  WHERE published_at IS NULL;

-- Backfill every pre-existing queued task so deployment cannot strand work
-- created by the in-process Phase B implementation.
INSERT INTO task_outbox (
  id, tenant_id, task_id, publish_attempts, available_at, created_at
)
SELECT
  substring(md5('phase-c:' || tenant_id || ':' || id) for 26),
  tenant_id,
  id,
  0,
  task.next_attempt_at,
  created_at
FROM parse_tasks AS task
WHERE task.status = 'queued';
