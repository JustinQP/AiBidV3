import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type {
  ClaimedTask,
  ConfirmationStatus,
  DevelopmentSourceLocator,
  FileParseStatus,
  NewProject,
  NewUpload,
  ParseTask,
  Project,
  ProjectFile,
  ProjectStatus,
  Requirement,
  RequirementCategory,
  RequirementConfirmation,
  RequirementFilters,
  RequirementPriority,
  StoredProjectFileRecord,
  TaskError,
  TaskLease,
  TaskOutboxEvent,
  TaskStatus,
} from '../../domain/models.js'
import type { BidRepository } from '../../domain/repository.js'
import { isOriginalObjectKeyWithinBoundary } from '../../domain/object-storage.js'
import { AppError } from '../../lib/app-error.js'
import { createId } from '../../lib/id.js'

interface ProjectRow extends QueryResultRow {
  id: string
  tenant_id: string
  name: string
  code: string | null
  customer_name: string | null
  owner_name: string | null
  deadline: Date | string | null
  status: ProjectStatus
  created_at: Date | string
  updated_at: Date | string
}

interface FileRow extends QueryResultRow {
  id: string
  tenant_id: string
  project_id: string
  file_name: string
  media_type: string
  size_bytes: string | number
  sha256: string
  content?: Buffer | null
  object_key: string | null
  object_version_id: string | null
  object_etag: string | null
  object_stored_at: Date | string | null
  parse_status: FileParseStatus
  created_at: Date | string
  updated_at: Date | string
}

interface TaskRow extends QueryResultRow {
  id: string
  tenant_id: string
  project_id: string
  file_id: string
  type: 'development-document-parse'
  status: TaskStatus
  progress: number
  attempt: number
  next_attempt_at: Date | string
  error: TaskError | null
  created_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  updated_at: Date | string
  lease_token: string | null
  lease_owner: string | null
  lease_expires_at: Date | string | null
  dead_lettered_at: Date | string | null
}

interface OutboxRow extends QueryResultRow {
  id: string
  tenant_id: string
  task_id: string
  publish_attempts: number
  created_at: Date | string
}

interface RequirementRow extends QueryResultRow {
  id: string
  tenant_id: string
  project_id: string
  file_id: string
  task_id: string
  code: string
  title: string
  description: string
  category: RequirementCategory
  priority: RequirementPriority
  confirmation_status: ConfirmationStatus
  confirmation_note: string | null
  confirmed_at: Date | string | null
  extraction_method: 'development-fixture'
  source_locator: DevelopmentSourceLocator
  created_at: Date | string
  updated_at: Date | string
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value)
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    code: row.code,
    customerName: row.customer_name,
    ownerName: row.owner_name,
    deadline: nullableTimestamp(row.deadline),
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function mapFile(row: FileRow): ProjectFile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    parseStatus: row.parse_status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function mapTask(row: TaskRow): ParseTask {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    fileId: row.file_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    attempt: row.attempt,
    error: row.error,
    createdAt: timestamp(row.created_at),
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    updatedAt: timestamp(row.updated_at),
  }
}

function mapOutboxEvent(row: OutboxRow): TaskOutboxEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    taskId: row.task_id,
    publishAttempts: row.publish_attempts,
    createdAt: timestamp(row.created_at),
  }
}

function mapRequirement(row: RequirementRow): Requirement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    fileId: row.file_id,
    taskId: row.task_id,
    code: row.code,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    confirmationStatus: row.confirmation_status,
    confirmationNote: row.confirmation_note,
    confirmedAt: nullableTimestamp(row.confirmed_at),
    extractionMethod: row.extraction_method,
    sourceLocator: row.source_locator,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  }
}

export class PostgresBidRepository implements BidRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async createProject(project: NewProject): Promise<Project> {
    const result = await this.pool.query<ProjectRow>(
      `INSERT INTO projects (
        id, tenant_id, name, code, customer_name, owner_name, deadline, status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        project.id,
        project.tenantId,
        project.name,
        project.code,
        project.customerName,
        project.ownerName,
        project.deadline,
        project.status,
        project.createdAt,
        project.updatedAt,
      ],
    )
    return mapProject(result.rows[0]!)
  }

  async listProjects(tenantId: string): Promise<Project[]> {
    const result = await this.pool.query<ProjectRow>(
      'SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    )
    return result.rows.map(mapProject)
  }

  async findProject(tenantId: string, projectId: string): Promise<Project | null> {
    const result = await this.pool.query<ProjectRow>(
      'SELECT * FROM projects WHERE tenant_id = $1 AND id = $2',
      [tenantId, projectId],
    )
    return result.rows[0] ? mapProject(result.rows[0]) : null
  }

  async createUpload(upload: NewUpload): Promise<{ file: ProjectFile; task: ParseTask }> {
    if (
      upload.task.tenantId !== upload.file.tenantId ||
      upload.task.projectId !== upload.file.projectId ||
      upload.task.fileId !== upload.file.id ||
      upload.file.parseStatus !== 'queued' ||
      upload.task.status !== 'queued' ||
      upload.task.progress !== 0 ||
      upload.task.attempt !== 0 ||
      upload.task.error !== null ||
      upload.task.startedAt !== null ||
      upload.task.finishedAt !== null
    ) {
      throw new Error('Cannot create an upload outside its initial task boundary')
    }
    return this.withTransaction(async (client) => {
      const fileResult = await client.query<FileRow>(
        `INSERT INTO project_files (
          id, tenant_id, project_id, file_name, media_type, size_bytes, sha256, content,
          object_key, object_version_id, object_etag, object_stored_at,
          parse_status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *`,
        [
          upload.file.id,
          upload.file.tenantId,
          upload.file.projectId,
          upload.file.fileName,
          upload.file.mediaType,
          upload.file.sizeBytes,
          upload.file.sha256,
          upload.file.objectReference.key,
          upload.file.objectReference.versionId,
          upload.file.objectReference.etag,
          upload.file.createdAt,
          upload.file.parseStatus,
          upload.file.createdAt,
          upload.file.updatedAt,
        ],
      )
      const taskResult = await client.query<TaskRow>(
        `INSERT INTO parse_tasks (
          id, tenant_id, project_id, file_id, type, status, progress, attempt, error,
          created_at, started_at, finished_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING *`,
        [
          upload.task.id,
          upload.task.tenantId,
          upload.task.projectId,
          upload.task.fileId,
          upload.task.type,
          upload.task.status,
          upload.task.progress,
          upload.task.attempt,
          upload.task.error,
          upload.task.createdAt,
          upload.task.startedAt,
          upload.task.finishedAt,
          upload.task.updatedAt,
        ],
      )
      await client.query(
        `INSERT INTO task_outbox (
          id, tenant_id, task_id, publish_attempts, available_at, created_at
        ) VALUES ($1,$2,$3,0,clock_timestamp(),$4)`,
        [createId(), upload.task.tenantId, upload.task.id, upload.task.createdAt],
      )
      return { file: mapFile(fileResult.rows[0]!), task: mapTask(taskResult.rows[0]!) }
    })
  }

  async listProjectFiles(tenantId: string, projectId: string): Promise<ProjectFile[]> {
    const result = await this.pool.query<FileRow>(
      `SELECT id, tenant_id, project_id, file_name, media_type, size_bytes, sha256,
        parse_status, created_at, updated_at
      FROM project_files
      WHERE tenant_id = $1 AND project_id = $2
      ORDER BY created_at DESC`,
      [tenantId, projectId],
    )
    return result.rows.map(mapFile)
  }

  async findStoredFile(tenantId: string, fileId: string): Promise<StoredProjectFileRecord | null> {
    const result = await this.pool.query<FileRow>(
      'SELECT * FROM project_files WHERE tenant_id = $1 AND id = $2',
      [tenantId, fileId],
    )
    const row = result.rows[0]
    if (!row) return null
    const file = mapFile(row)
    if (row.object_key) {
      if (!isOriginalObjectKeyWithinBoundary(row.object_key, file)) {
        throw new AppError(
          500,
          'STORED_FILE_INTEGRITY_FAILED',
          'Stored object key did not match its tenant, project, and file boundary',
          'Internal Server Error',
        )
      }
      return {
        ...file,
        source: {
          kind: 'object',
          reference: {
            key: row.object_key,
            versionId: row.object_version_id,
            etag: row.object_etag,
          },
        },
      }
    }
    if (row.content) {
      return {
        ...file,
        source: { kind: 'legacy-inline', content: Buffer.from(row.content) },
      }
    }
    return null
  }

  async listProjectTasks(tenantId: string, projectId: string): Promise<ParseTask[]> {
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM parse_tasks WHERE tenant_id = $1 AND project_id = $2 ORDER BY created_at DESC',
      [tenantId, projectId],
    )
    return result.rows.map(mapTask)
  }

  async findTask(tenantId: string, taskId: string): Promise<ParseTask | null> {
    const result = await this.pool.query<TaskRow>(
      'SELECT * FROM parse_tasks WHERE tenant_id = $1 AND id = $2',
      [tenantId, taskId],
    )
    return result.rows[0] ? mapTask(result.rows[0]) : null
  }

  async claimTask(
    tenantId: string,
    taskId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    maxAttempts: number,
  ): Promise<ClaimedTask | null> {
    const token = randomUUID()
    return this.withTransaction(async (client) => {
      const taskResult = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'running', progress = 20, attempt = attempt + 1,
          error = NULL, started_at = $4, finished_at = NULL, updated_at = $4,
          lease_owner = $3, lease_token = $6,
          lease_expires_at = clock_timestamp() + ($5::timestamptz - $4::timestamptz),
          dead_lettered_at = NULL
        WHERE tenant_id = $1
          AND id = $2
          AND dead_lettered_at IS NULL
          AND attempt < $7::integer
          AND $7::integer > 0
          AND $5::timestamptz > $4::timestamptz
          AND (
            (status = 'queued' AND next_attempt_at <= clock_timestamp())
            OR (status = 'running' AND lease_expires_at <= clock_timestamp())
          )
        RETURNING *`,
        [tenantId, taskId, workerId, now, leaseExpiresAt, token, maxAttempts],
      )
      const task = taskResult.rows[0]
      if (!task) {
        const exhaustedResult = await client.query<TaskRow>(
          `UPDATE parse_tasks
          SET status = 'failed',
            error = jsonb_build_object(
              'code', 'TASK_ATTEMPTS_EXHAUSTED',
              'message', 'Task attempts were exhausted before a worker could complete it'
            ),
            finished_at = $3, updated_at = $3, dead_lettered_at = $3,
            lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE tenant_id = $1
            AND id = $2
            AND dead_lettered_at IS NULL
            AND attempt >= $4::integer
            AND $4::integer > 0
            AND (
              (status = 'queued' AND next_attempt_at <= clock_timestamp())
              OR (status = 'running' AND lease_expires_at <= clock_timestamp())
            )
          RETURNING *`,
          [tenantId, taskId, now, maxAttempts],
        )
        const exhausted = exhaustedResult.rows[0]
        if (exhausted) {
          await client.query(
            `UPDATE project_files SET parse_status = 'failed', updated_at = $3
            WHERE tenant_id = $1 AND id = $2`,
            [tenantId, exhausted.file_id, now],
          )
        }
        return null
      }
      await client.query(
        `UPDATE project_files SET parse_status = 'parsing', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [tenantId, task.file_id, now],
      )
      return {
        task: mapTask(task),
        lease: { tenantId, taskId, workerId, token, expiresAt: timestamp(task.lease_expires_at!) },
      }
    })
  }

  async renewTaskLease(
    lease: TaskLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TaskLease | null> {
    const renewed = await this.pool.query<TaskRow>(
      `UPDATE parse_tasks
      SET lease_expires_at = clock_timestamp() + ($6::timestamptz - $5::timestamptz),
        updated_at = $5
      WHERE tenant_id = $1
        AND id = $2
        AND status = 'running'
        AND lease_owner = $3
        AND lease_token = $4
        AND lease_expires_at > clock_timestamp()
        AND $6::timestamptz > $5::timestamptz
      RETURNING *`,
      [lease.tenantId, lease.taskId, lease.workerId, lease.token, now, leaseExpiresAt],
    )
    const task = renewed.rows[0]
    return task
      ? {
          ...lease,
          expiresAt: timestamp(task.lease_expires_at!),
        }
      : null
  }

  async completeTask(
    lease: TaskLease,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const locked = await client.query<TaskRow>(
        `SELECT * FROM parse_tasks
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'running'
          AND lease_owner = $3
          AND lease_token = $4
          AND lease_expires_at > clock_timestamp()
        FOR UPDATE`,
        [lease.tenantId, lease.taskId, lease.workerId, lease.token],
      )
      const task = locked.rows[0]
      if (!task) return null

      for (const requirement of requirements) {
        if (
          requirement.tenantId !== lease.tenantId ||
          requirement.taskId !== lease.taskId ||
          requirement.projectId !== task.project_id ||
          requirement.fileId !== task.file_id
        ) {
          throw new Error('Cannot persist a requirement outside its task boundary')
        }
        await client.query(
          `INSERT INTO requirements (
            id, tenant_id, project_id, file_id, task_id, code, title, description,
            category, priority, confirmation_status, confirmation_note, confirmed_at,
            extraction_method, source_locator, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            requirement.id,
            requirement.tenantId,
            requirement.projectId,
            requirement.fileId,
            requirement.taskId,
            requirement.code,
            requirement.title,
            requirement.description,
            requirement.category,
            requirement.priority,
            requirement.confirmationStatus,
            requirement.confirmationNote,
            requirement.confirmedAt,
            requirement.extractionMethod,
            JSON.stringify(requirement.sourceLocator),
            requirement.createdAt,
            requirement.updatedAt,
          ],
        )
      }

      const completed = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'succeeded', progress = 100, error = NULL,
          finished_at = $5, updated_at = $5,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'running'
          AND lease_owner = $3
          AND lease_token = $4
          AND lease_expires_at > clock_timestamp()
        RETURNING *`,
        [lease.tenantId, lease.taskId, lease.workerId, lease.token, now],
      )
      await client.query(
        `UPDATE project_files SET parse_status = 'parsed', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [lease.tenantId, task.file_id, now],
      )
      return mapTask(completed.rows[0]!)
    })
  }

  async failTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    deadLetter: boolean,
  ): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const failed = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'failed', error = $5::jsonb, finished_at = $6, updated_at = $6,
          dead_lettered_at = CASE WHEN $7::boolean THEN $6::timestamptz ELSE NULL END,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'running'
          AND lease_owner = $3
          AND lease_token = $4
          AND lease_expires_at > clock_timestamp()
        RETURNING *`,
        [
          lease.tenantId,
          lease.taskId,
          lease.workerId,
          lease.token,
          JSON.stringify(error),
          now,
          deadLetter,
        ],
      )
      const task = failed.rows[0]
      if (!task) return null
      await client.query(
        `UPDATE project_files SET parse_status = 'failed', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [lease.tenantId, task.file_id, now],
      )
      return mapTask(task)
    })
  }

  async requeueTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    availableAt: string,
  ): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const requeued = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'queued', progress = 0, error = $5::jsonb,
          started_at = NULL, finished_at = NULL, updated_at = $6,
          next_attempt_at = clock_timestamp() + ($7::timestamptz - $6::timestamptz),
          dead_lettered_at = NULL,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1
          AND id = $2
          AND status = 'running'
          AND lease_owner = $3
          AND lease_token = $4
          AND lease_expires_at > clock_timestamp()
        RETURNING *`,
        [
          lease.tenantId,
          lease.taskId,
          lease.workerId,
          lease.token,
          JSON.stringify(error),
          now,
          availableAt,
        ],
      )
      const task = requeued.rows[0]
      if (!task) return null
      await client.query(
        `UPDATE project_files SET parse_status = 'queued', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [lease.tenantId, task.file_id, now],
      )
      await client.query(
        `INSERT INTO task_outbox (
          id, tenant_id, task_id, publish_attempts, available_at, created_at
        ) VALUES (
          $1,$2,$3,0,
          clock_timestamp() + ($4::timestamptz - $5::timestamptz),
          $5
        )`,
        [createId(), lease.tenantId, lease.taskId, availableAt, now],
      )
      return mapTask(task)
    })
  }

  async retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const retried = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'queued', progress = 0, error = NULL, started_at = NULL,
          finished_at = NULL, updated_at = $3, attempt = 0,
          next_attempt_at = clock_timestamp(),
          dead_lettered_at = NULL,
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'failed'
        RETURNING *`,
        [tenantId, taskId, now],
      )
      const task = retried.rows[0]
      if (!task) return null
      await client.query(
        `UPDATE project_files SET parse_status = 'queued', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [tenantId, task.file_id, now],
      )
      await client.query(
        `INSERT INTO task_outbox (
          id, tenant_id, task_id, publish_attempts, available_at, created_at
        ) VALUES ($1,$2,$3,0,clock_timestamp(),$4)`,
        [createId(), tenantId, taskId, now],
      )
      return mapTask(task)
    })
  }

  async claimOutboxEvents(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<TaskOutboxEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return []
    const result = await this.pool.query<OutboxRow>(
      `WITH candidates AS (
        SELECT id
        FROM task_outbox
        WHERE published_at IS NULL
          AND available_at <= clock_timestamp()
          AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      )
      UPDATE task_outbox AS event
      SET lease_owner = $1,
        lease_expires_at = clock_timestamp() + ($3::timestamptz - $2::timestamptz),
        publish_attempts = event.publish_attempts + 1,
        last_error = NULL
      FROM candidates
      WHERE event.id = candidates.id
        AND $3::timestamptz > $2::timestamptz
      RETURNING event.*`,
      [workerId, now, leaseExpiresAt, limit],
    )
    return result.rows.map(mapOutboxEvent)
  }

  async markOutboxEventPublished(
    eventId: string,
    workerId: string,
    publishedAt: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_outbox
      SET published_at = $3, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE id = $1
        AND lease_owner = $2
        AND published_at IS NULL
        AND lease_expires_at > clock_timestamp()`,
      [eventId, workerId, publishedAt],
    )
    return result.rowCount === 1
  }

  async releaseOutboxEvent(
    eventId: string,
    workerId: string,
    error: TaskError,
    releasedAt: string,
    availableAt: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE task_outbox
      SET available_at = clock_timestamp() + ($5::timestamptz - $4::timestamptz),
        lease_owner = NULL, lease_expires_at = NULL,
        last_error = $3::jsonb
      WHERE id = $1
        AND lease_owner = $2
        AND published_at IS NULL
        AND lease_expires_at > clock_timestamp()`,
      [eventId, workerId, JSON.stringify(error), releasedAt, availableAt],
    )
    return result.rowCount === 1
  }

  async listRequirements(
    tenantId: string,
    projectId: string,
    filters: RequirementFilters,
  ): Promise<Requirement[]> {
    const clauses = ['tenant_id = $1', 'project_id = $2']
    const values: unknown[] = [tenantId, projectId]
    if (filters.confirmationStatus !== undefined) {
      values.push(filters.confirmationStatus)
      clauses.push(`confirmation_status = $${values.length}`)
    }
    if (filters.priority !== undefined) {
      values.push(filters.priority)
      clauses.push(`priority = $${values.length}`)
    }
    const result = await this.pool.query<RequirementRow>(
      `SELECT * FROM requirements WHERE ${clauses.join(' AND ')} ORDER BY code`,
      values,
    )
    return result.rows.map(mapRequirement)
  }

  async confirmRequirement(
    tenantId: string,
    projectId: string,
    requirementId: string,
    confirmation: RequirementConfirmation,
  ): Promise<Requirement | null> {
    const result = await this.pool.query<RequirementRow>(
      `UPDATE requirements
      SET confirmation_status = $4, confirmation_note = $5, confirmed_at = $6, updated_at = $6
      WHERE tenant_id = $1 AND project_id = $2 AND id = $3
      RETURNING *`,
      [
        tenantId,
        projectId,
        requirementId,
        confirmation.status,
        confirmation.note,
        confirmation.confirmedAt,
      ],
    )
    return result.rows[0] ? mapRequirement(result.rows[0]) : null
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let transactionStarted = false
    try {
      await client.query('BEGIN')
      transactionStarted = true
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
