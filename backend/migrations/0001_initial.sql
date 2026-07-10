-- Phase 1 tenant isolation is enforced by tenant-scoped repository queries and
-- composite foreign keys. SECURITY GATE: PostgreSQL RLS is intentionally not
-- enabled in this development slice. RLS policies and production identity
-- propagation MUST be implemented and verified before any production rollout.

CREATE TABLE projects (
  id varchar(26) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  code text,
  customer_name text,
  owner_name text,
  deadline timestamptz,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE INDEX projects_tenant_created_at_idx
  ON projects (tenant_id, created_at DESC);

CREATE TABLE project_files (
  id varchar(26) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  project_id varchar(26) NOT NULL,
  file_name text NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  content bytea NOT NULL,
  parse_status text NOT NULL CHECK (parse_status IN ('queued', 'parsing', 'parsed', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, id),
  CONSTRAINT project_files_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX project_files_tenant_project_created_at_idx
  ON project_files (tenant_id, project_id, created_at DESC);

CREATE TABLE parse_tasks (
  id varchar(26) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  project_id varchar(26) NOT NULL,
  file_id varchar(26) NOT NULL,
  type text NOT NULL CHECK (type IN ('development-document-parse')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  progress smallint NOT NULL CHECK (progress BETWEEN 0 AND 100),
  error jsonb,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id, file_id, id),
  CONSTRAINT parse_tasks_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT parse_tasks_file_lineage_fk
    FOREIGN KEY (tenant_id, project_id, file_id)
    REFERENCES project_files (tenant_id, project_id, id)
    ON DELETE CASCADE,
  CONSTRAINT parse_tasks_error_shape_ck
    CHECK (error IS NULL OR jsonb_typeof(error) = 'object')
);

CREATE INDEX parse_tasks_tenant_status_created_at_idx
  ON parse_tasks (tenant_id, status, created_at DESC);

CREATE INDEX parse_tasks_tenant_project_created_at_idx
  ON parse_tasks (tenant_id, project_id, created_at DESC);

CREATE INDEX parse_tasks_tenant_file_idx
  ON parse_tasks (tenant_id, file_id);

CREATE INDEX parse_tasks_recovery_status_created_at_idx
  ON parse_tasks (status, created_at)
  WHERE status IN ('queued', 'running');

CREATE TABLE requirements (
  id varchar(26) PRIMARY KEY,
  tenant_id varchar(64) NOT NULL,
  project_id varchar(26) NOT NULL,
  file_id varchar(26) NOT NULL,
  task_id varchar(26) NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('technical', 'commercial', 'compliance')),
  priority text NOT NULL CHECK (priority IN ('mandatory', 'important', 'normal')),
  confirmation_status text NOT NULL CHECK (confirmation_status IN ('pending', 'confirmed', 'rejected')),
  confirmation_note text,
  confirmed_at timestamptz,
  extraction_method text NOT NULL CHECK (extraction_method IN ('development-fixture')),
  source_locator jsonb NOT NULL CHECK (jsonb_typeof(source_locator) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, task_id, code),
  CONSTRAINT requirements_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT requirements_file_fk
    FOREIGN KEY (tenant_id, file_id)
    REFERENCES project_files (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT requirements_task_lineage_fk
    FOREIGN KEY (tenant_id, project_id, file_id, task_id)
    REFERENCES parse_tasks (tenant_id, project_id, file_id, id)
    ON DELETE CASCADE
);

CREATE INDEX requirements_tenant_project_status_priority_idx
  ON requirements (tenant_id, project_id, confirmation_status, priority, code);

CREATE INDEX requirements_tenant_project_code_idx
  ON requirements (tenant_id, project_id, code);

CREATE INDEX requirements_tenant_project_status_code_idx
  ON requirements (tenant_id, project_id, confirmation_status, code);

CREATE INDEX requirements_tenant_project_priority_code_idx
  ON requirements (tenant_id, project_id, priority, code);

CREATE INDEX requirements_tenant_file_idx
  ON requirements (tenant_id, file_id);

CREATE INDEX requirements_tenant_project_file_task_idx
  ON requirements (tenant_id, project_id, file_id, task_id);
