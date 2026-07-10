import { Pool } from 'pg'
import { DevelopmentDocumentParser } from '../../application/development-document-parser.js'
import { loadConfig } from '../../config.js'
import type { NewUpload } from '../../domain/models.js'
import { createId } from '../../lib/id.js'
import { PostgresBidRepository } from './postgres-repository.js'

const config = loadConfig()
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test')

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
})
const repository = new PostgresBidRepository(pool)
const tenantId = `smoke-${createId().toLowerCase()}`
const projectId = createId()
const now = new Date().toISOString()

try {
  await repository.createProject({
    id: projectId,
    tenantId,
    name: 'PostgreSQL repository smoke test',
    code: null,
    customerName: null,
    ownerName: null,
    deadline: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  })
  const projects = await repository.listProjects(tenantId)
  if (projects.length !== 1 || projects[0]?.id !== projectId) {
    throw new Error('PostgreSQL repository smoke test could not read its project')
  }
  if (await repository.findProject('another-tenant', projectId)) {
    throw new Error('PostgreSQL repository leaked a project across tenant boundaries')
  }

  const fileId = createId()
  const taskId = createId()
  const content = Buffer.from('development smoke fixture')
  const upload: NewUpload = {
    file: {
      id: fileId,
      tenantId,
      projectId,
      fileName: 'smoke.txt',
      mediaType: 'text/plain',
      sizeBytes: content.length,
      sha256: 'b'.repeat(64),
      content,
      parseStatus: 'queued',
      createdAt: now,
      updatedAt: now,
    },
    task: {
      id: taskId,
      tenantId,
      projectId,
      fileId,
      type: 'development-document-parse',
      status: 'queued',
      progress: 0,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    },
  }
  await repository.createUpload(upload)
  await repository.markTaskRunning(tenantId, taskId, new Date().toISOString())
  const recovered = await repository.recoverPendingTasks()
  if (!recovered.some((task) => task.id === taskId && task.status === 'queued')) {
    throw new Error('PostgreSQL repository did not recover its running task')
  }
  await repository.markTaskRunning(tenantId, taskId, new Date().toISOString())
  const storedFile = await repository.findStoredFile(tenantId, fileId)
  if (!storedFile) throw new Error('PostgreSQL repository could not read its uploaded file')
  const requirements = await new DevelopmentDocumentParser().parse(
    storedFile,
    taskId,
    new Date().toISOString(),
  )
  await repository.completeTask(tenantId, taskId, requirements, new Date().toISOString())
  const persistedRequirements = await repository.listRequirements(tenantId, projectId, {})
  if (persistedRequirements.length !== requirements.length) {
    throw new Error('PostgreSQL repository could not persist parsed requirements')
  }
  const requirement = persistedRequirements[0]
  if (!requirement) throw new Error('PostgreSQL repository did not return a requirement')
  const confirmed = await repository.confirmRequirement(tenantId, projectId, requirement.id, {
    status: 'confirmed',
    note: 'smoke test',
    confirmedAt: new Date().toISOString(),
  })
  if (confirmed?.confirmationStatus !== 'confirmed') {
    throw new Error('PostgreSQL repository could not confirm a requirement')
  }
  if ((await repository.listRequirements('another-tenant', projectId, {})).length !== 0) {
    throw new Error('PostgreSQL repository leaked requirements across tenant boundaries')
  }
} finally {
  await pool.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
  await repository.close()
}
