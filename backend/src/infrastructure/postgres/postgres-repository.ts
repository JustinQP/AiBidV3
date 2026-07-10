import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type {
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
  TaskStatus,
} from '../../domain/models.js'
import type { BidRepository } from '../../domain/repository.js'
import { isOriginalObjectKeyWithinBoundary } from '../../domain/object-storage.js'

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
  error: TaskError | null
  created_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  updated_at: Date | string
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
    error: row.error,
    createdAt: timestamp(row.created_at),
    startedAt: nullableTimestamp(row.started_at),
    finishedAt: nullableTimestamp(row.finished_at),
    updatedAt: timestamp(row.updated_at),
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

  async recoverPendingTasks(): Promise<ParseTask[]> {
    return this.withTransaction(async (client) => {
      const now = new Date().toISOString()
      await client.query(
        `UPDATE parse_tasks
        SET status = 'queued', progress = 0, error = NULL, started_at = NULL,
          finished_at = NULL, updated_at = $1
        WHERE status = 'running'`,
        [now],
      )
      await client.query(
        `UPDATE project_files AS file
        SET parse_status = 'queued', updated_at = $1
        WHERE file.parse_status <> 'queued'
          AND EXISTS (
            SELECT 1 FROM parse_tasks AS task
            WHERE task.tenant_id = file.tenant_id
              AND task.project_id = file.project_id
              AND task.file_id = file.id
              AND task.status = 'queued'
          )`,
        [now],
      )
      const pending = await client.query<TaskRow>(
        `SELECT * FROM parse_tasks WHERE status = 'queued' ORDER BY created_at`,
      )
      return pending.rows.map(mapTask)
    })
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
          id, tenant_id, project_id, file_id, type, status, progress, error,
          created_at, started_at, finished_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING *`,
        [
          upload.task.id,
          upload.task.tenantId,
          upload.task.projectId,
          upload.task.fileId,
          upload.task.type,
          upload.task.status,
          upload.task.progress,
          upload.task.error,
          upload.task.createdAt,
          upload.task.startedAt,
          upload.task.finishedAt,
          upload.task.updatedAt,
        ],
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
        throw new Error('Stored object key did not match its tenant, project, and file boundary')
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

  async markTaskRunning(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const taskResult = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'running', progress = 20, started_at = $3, updated_at = $3
        WHERE tenant_id = $1 AND id = $2 AND status = 'queued'
        RETURNING *`,
        [tenantId, taskId, now],
      )
      const task = taskResult.rows[0]
      if (!task) return null
      await client.query(
        `UPDATE project_files SET parse_status = 'parsing', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [tenantId, task.file_id, now],
      )
      return mapTask(task)
    })
  }

  async completeTask(
    tenantId: string,
    taskId: string,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const locked = await client.query<TaskRow>(
        `SELECT * FROM parse_tasks
        WHERE tenant_id = $1 AND id = $2 AND status = 'running'
        FOR UPDATE`,
        [tenantId, taskId],
      )
      const task = locked.rows[0]
      if (!task) return null

      for (const requirement of requirements) {
        if (
          requirement.tenantId !== tenantId ||
          requirement.taskId !== taskId ||
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
        SET status = 'succeeded', progress = 100, finished_at = $3, updated_at = $3
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
        [tenantId, taskId, now],
      )
      await client.query(
        `UPDATE project_files SET parse_status = 'parsed', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [tenantId, task.file_id, now],
      )
      return mapTask(completed.rows[0]!)
    })
  }

  async failTask(
    tenantId: string,
    taskId: string,
    error: { code: string; message: string },
    now: string,
  ): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const failed = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'failed', error = $3::jsonb, finished_at = $4, updated_at = $4
        WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')
        RETURNING *`,
        [tenantId, taskId, JSON.stringify(error), now],
      )
      const task = failed.rows[0]
      if (!task) return null
      await client.query(
        `UPDATE project_files SET parse_status = 'failed', updated_at = $3
        WHERE tenant_id = $1 AND id = $2`,
        [tenantId, task.file_id, now],
      )
      return mapTask(task)
    })
  }

  async retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    return this.withTransaction(async (client) => {
      const retried = await client.query<TaskRow>(
        `UPDATE parse_tasks
        SET status = 'queued', progress = 0, error = NULL, started_at = NULL,
          finished_at = NULL, updated_at = $3
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
      return mapTask(task)
    })
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
