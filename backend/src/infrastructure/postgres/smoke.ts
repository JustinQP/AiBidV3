import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { DevelopmentDocumentParser } from '../../application/development-document-parser.js'
import { FileContentLoader } from '../../application/file-content-loader.js'
import { loadConfig } from '../../config.js'
import type { NewUpload } from '../../domain/models.js'
import { originalObjectKey, type ObjectReference } from '../../domain/object-storage.js'
import { createObjectStorage } from '../object-storage-factory.js'
import { createId } from '../../lib/id.js'
import { PostgresBidRepository } from './postgres-repository.js'

const config = loadConfig()
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test')

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
})
const repository = new PostgresBidRepository(pool)
const objectStorage = createObjectStorage(config)
const tenantId = `smoke-${createId().toLowerCase()}`
const projectId = createId()
const now = new Date().toISOString()
let uploadedObject: ObjectReference | null = null

try {
  await objectStorage.ping()
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
  const file = {
    id: fileId,
    tenantId,
    projectId,
    fileName: 'smoke.txt',
    mediaType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'queued' as const,
    createdAt: now,
    updatedAt: now,
  }
  uploadedObject = await objectStorage.putObject({
    key: originalObjectKey(file),
    body: content,
    contentType: file.mediaType,
    sha256: file.sha256,
  })
  if (config.s3Endpoint && config.s3Bucket && config.s3ForcePathStyle) {
    const baseUrl = config.s3Endpoint.endsWith('/') ? config.s3Endpoint : `${config.s3Endpoint}/`
    const anonymousUrl = new URL(`${config.s3Bucket}/${uploadedObject.key}`, baseUrl)
    const anonymousResponse = await fetch(anonymousUrl)
    if (anonymousResponse.status !== 401 && anonymousResponse.status !== 403) {
      throw new Error(
        `S3 smoke test expected the object to reject anonymous reads, received ${anonymousResponse.status}`,
      )
    }
  }
  const upload: NewUpload = {
    file: {
      ...file,
      objectReference: uploadedObject,
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
  const storedMetadata = await pool.query<{
    content: Buffer | null
    object_key: string | null
  }>(
    'SELECT content, object_key FROM project_files WHERE tenant_id = $1 AND id = $2',
    [tenantId, fileId],
  )
  if (storedMetadata.rows[0]?.content !== null || storedMetadata.rows[0]?.object_key !== uploadedObject.key) {
    throw new Error('PostgreSQL repository did not persist an object-backed file without bytea content')
  }
  await repository.markTaskRunning(tenantId, taskId, new Date().toISOString())
  const recovered = await repository.recoverPendingTasks()
  if (!recovered.some((task) => task.id === taskId && task.status === 'queued')) {
    throw new Error('PostgreSQL repository did not recover its running task')
  }
  await repository.markTaskRunning(tenantId, taskId, new Date().toISOString())
  const fileContentLoader = new FileContentLoader(repository, objectStorage)
  const storedFile = await fileContentLoader.loadForProcessing(tenantId, fileId)
  if (!storedFile) throw new Error('PostgreSQL repository could not read its uploaded file')
  if (!storedFile.content.equals(content)) {
    throw new Error('PostgreSQL repository and S3 did not round-trip the uploaded bytes')
  }
  if (await fileContentLoader.loadForProcessing('another-tenant', fileId)) {
    throw new Error('PostgreSQL repository leaked an object-backed file across tenant boundaries')
  }

  const legacyFileId = createId()
  const legacyContent = Buffer.from('legacy bytea smoke fixture')
  await pool.query(
    `INSERT INTO project_files (
      id, tenant_id, project_id, file_name, media_type, size_bytes, sha256, content,
      parse_status, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      legacyFileId,
      tenantId,
      projectId,
      'legacy.txt',
      'text/plain',
      legacyContent.length,
      createHash('sha256').update(legacyContent).digest('hex'),
      legacyContent,
      'queued',
      now,
      now,
    ],
  )
  const legacyStoredFile = await fileContentLoader.loadForProcessing(tenantId, legacyFileId)
  if (!legacyStoredFile?.content.equals(legacyContent)) {
    throw new Error('PostgreSQL repository could not read a migration-era bytea file')
  }
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
  if (uploadedObject) await objectStorage.deleteObject(uploadedObject).catch(() => undefined)
  await objectStorage.close().catch(() => undefined)
  await repository.close()
}
