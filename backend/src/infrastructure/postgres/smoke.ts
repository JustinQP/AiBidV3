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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

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
      attempt: 0,
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
  const relayNow = new Date(Date.parse(now) + 1_000).toISOString()
  const outboxEvents = await repository.claimOutboxEvents(
    'smoke-relay',
    relayNow,
    new Date(Date.parse(relayNow) + 10_000).toISOString(),
    10,
  )
  const uploadEvent = outboxEvents.find((event) => event.taskId === taskId)
  if (!uploadEvent) throw new Error('PostgreSQL repository did not create an upload outbox event')
  if (!await repository.markOutboxEventPublished(uploadEvent.id, 'smoke-relay', relayNow)) {
    throw new Error('PostgreSQL repository could not mark its upload outbox event as published')
  }

  const firstClaimAt = new Date(Date.parse(now) + 2_000).toISOString()
  const firstLeaseExpiry = new Date(Date.parse(firstClaimAt) + 100).toISOString()
  const firstClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-a',
    firstClaimAt,
    firstLeaseExpiry,
    config.taskMaxAttempts,
  )
  if (!firstClaim || firstClaim.task.attempt !== 1) {
    throw new Error('PostgreSQL repository could not claim the queued task with its first lease')
  }
  const blockedClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-b',
    new Date(Date.parse(firstClaimAt) + 50).toISOString(),
    new Date(Date.parse(firstClaimAt) + 5_000).toISOString(),
    config.taskMaxAttempts,
  )
  if (blockedClaim) throw new Error('PostgreSQL repository allowed a live task lease to be stolen')

  await delay(150)
  const forgedLiveTimestamp = new Date(Date.parse(firstClaimAt) + 50).toISOString()
  const expiredFailure = await repository.failTask(
    firstClaim.lease,
    { code: 'CLOCK_SKEW_PROBE', message: 'A stale caller timestamp must not extend a lease' },
    forgedLiveTimestamp,
    true,
  )
  if (expiredFailure) {
    throw new Error('PostgreSQL repository trusted a worker timestamp after the database lease expired')
  }

  const secondClaimAt = new Date().toISOString()
  const secondClaim = await repository.claimTask(
    tenantId,
    taskId,
    'smoke-worker-b',
    secondClaimAt,
    new Date(Date.parse(secondClaimAt) + 30_000).toISOString(),
    config.taskMaxAttempts,
  )
  if (!secondClaim || secondClaim.task.attempt !== 2) {
    throw new Error('PostgreSQL repository did not recover an expired task lease')
  }
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

  const retryRaceTaskId = createId()
  const retryRaceCreatedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO parse_tasks (
      id, tenant_id, project_id, file_id, type, status, progress, error,
      created_at, started_at, finished_at, updated_at
    ) VALUES ($1,$2,$3,$4,'development-document-parse','queued',0,NULL,$5,NULL,NULL,$5)`,
    [retryRaceTaskId, tenantId, projectId, legacyFileId, retryRaceCreatedAt],
  )
  const retryRaceClaimedAt = new Date()
  const retryRaceClaim = await repository.claimTask(
    tenantId,
    retryRaceTaskId,
    'smoke-retry-race-worker-a',
    retryRaceClaimedAt.toISOString(),
    new Date(retryRaceClaimedAt.getTime() + 50).toISOString(),
    3,
  )
  if (!retryRaceClaim) throw new Error('PostgreSQL retry race fixture could not claim its task')
  await delay(75)

  const requeueClient = await pool.connect()
  let requeueTransactionOpen = false
  try {
    await requeueClient.query('BEGIN')
    requeueTransactionOpen = true
    const requeued = await requeueClient.query(
      `UPDATE parse_tasks
      SET status = 'queued', progress = 0,
        error = jsonb_build_object('code', 'OBJECT_STORAGE_UNAVAILABLE', 'message', 'retry later'),
        started_at = NULL, finished_at = NULL, updated_at = clock_timestamp(),
        next_attempt_at = clock_timestamp() + interval '30 seconds',
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE tenant_id = $1 AND id = $2 AND lease_token = $3
      RETURNING id`,
      [tenantId, retryRaceTaskId, retryRaceClaim.lease.token],
    )
    if (requeued.rowCount !== 1) throw new Error('PostgreSQL retry race fixture could not requeue')

    const concurrentClaimedAt = new Date()
    const concurrentClaim = repository.claimTask(
      tenantId,
      retryRaceTaskId,
      'smoke-retry-race-worker-b',
      concurrentClaimedAt.toISOString(),
      new Date(concurrentClaimedAt.getTime() + 30_000).toISOString(),
      3,
    )
    await delay(50)
    await requeueClient.query(
      `INSERT INTO task_outbox (
        id, tenant_id, task_id, publish_attempts, available_at, created_at
      ) VALUES ($1,$2,$3,0,clock_timestamp() + interval '30 seconds',clock_timestamp())`,
      [createId(), tenantId, retryRaceTaskId],
    )
    await requeueClient.query('COMMIT')
    requeueTransactionOpen = false

    if (await concurrentClaim) {
      throw new Error('PostgreSQL claim bypassed retry backoff during a concurrent requeue')
    }
    const retryRaceTask = await repository.findTask(tenantId, retryRaceTaskId)
    if (retryRaceTask?.status !== 'queued' || retryRaceTask.attempt !== 1) {
      throw new Error('PostgreSQL retry race did not preserve the delayed queued task')
    }
  } catch (error) {
    if (requeueTransactionOpen) await requeueClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    requeueClient.release()
  }

  const crashTaskId = createId()
  const crashTaskCreatedAt = new Date().toISOString()
  await pool.query(
    `INSERT INTO parse_tasks (
      id, tenant_id, project_id, file_id, type, status, progress, error,
      created_at, started_at, finished_at, updated_at
    ) VALUES ($1,$2,$3,$4,'development-document-parse','queued',0,NULL,$5,NULL,NULL,$5)`,
    [crashTaskId, tenantId, projectId, legacyFileId, crashTaskCreatedAt],
  )
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimedAt = new Date()
    const crashClaim = await repository.claimTask(
      tenantId,
      crashTaskId,
      `smoke-crash-worker-${attempt}`,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + 50).toISOString(),
      3,
    )
    if (crashClaim?.task.attempt !== attempt) {
      throw new Error(`PostgreSQL repository did not grant crash attempt ${attempt}`)
    }
    await delay(75)
  }
  const exhaustedAt = new Date()
  const exhaustedClaim = await repository.claimTask(
    tenantId,
    crashTaskId,
    'smoke-crash-worker-exhausted',
    exhaustedAt.toISOString(),
    new Date(exhaustedAt.getTime() + 50).toISOString(),
    3,
  )
  const exhaustedTask = await repository.findTask(tenantId, crashTaskId)
  if (
    exhaustedClaim !== null ||
    exhaustedTask?.status !== 'failed' ||
    exhaustedTask.attempt !== 3 ||
    exhaustedTask.error?.code !== 'TASK_ATTEMPTS_EXHAUSTED'
  ) {
    throw new Error('PostgreSQL repository did not dead-letter a repeatedly crashed task')
  }

  const requirements = await new DevelopmentDocumentParser().parse(
    storedFile,
    taskId,
    secondClaimAt,
  )
  const staleCompletion = await repository.completeTask(
    firstClaim.lease,
    requirements,
    new Date(Date.parse(secondClaimAt) + 1_000).toISOString(),
  )
  if (staleCompletion) throw new Error('PostgreSQL repository accepted a stale worker fencing token')
  const completed = await repository.completeTask(
    secondClaim.lease,
    requirements,
    new Date(Date.parse(secondClaimAt) + 2_000).toISOString(),
  )
  if (completed?.status !== 'succeeded') {
    throw new Error('PostgreSQL repository could not complete the task with its current lease')
  }
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
