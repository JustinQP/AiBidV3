import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { DevelopmentDocumentParser } from '../../application/development-document-parser.js'
import { DurableTaskWorker } from '../../application/durable-task-worker.js'
import { FileContentLoader } from '../../application/file-content-loader.js'
import { OutboxRelay } from '../../application/outbox-relay.js'
import { loadConfig } from '../../config.js'
import type { NewUpload } from '../../domain/models.js'
import { originalObjectKey, type ObjectReference } from '../../domain/object-storage.js'
import type { TaskQueueDelivery } from '../../domain/task-queue.js'
import { createId } from '../../lib/id.js'
import { createObjectStorage } from '../object-storage-factory.js'
import { RedisTaskQueue } from '../redis/redis-task-queue.js'
import { createRepository } from '../repository-factory.js'

const config = loadConfig()
if (config.repositoryDriver !== 'postgres') {
  throw new Error('Worker smoke test requires REPOSITORY_DRIVER=postgres')
}
if (config.objectStorageDriver !== 's3') {
  throw new Error('Worker smoke test requires OBJECT_STORAGE_DRIVER=s3')
}
if (config.redisUrl === null) throw new Error('Worker smoke test requires REDIS_URL')
if (config.databaseUrl === null) throw new Error('Worker smoke test requires DATABASE_URL')

const smokeId = createId().toLowerCase()
const tenantId = `worker-smoke-${smokeId}`
const projectId = createId()
const fileId = createId()
const taskId = createId()
const workerId = `worker-smoke:${smokeId}`
const now = new Date().toISOString()
const content = Buffer.from('durable worker integration smoke fixture')
const file = {
  id: fileId,
  tenantId,
  projectId,
  fileName: 'worker-smoke.txt',
  mediaType: 'text/plain',
  sizeBytes: content.length,
  sha256: createHash('sha256').update(content).digest('hex'),
  parseStatus: 'queued' as const,
  createdAt: now,
  updatedAt: now,
}

const repository = await createRepository(config)
const cleanupPool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
})
const objectStorage = createObjectStorage(config)
const queue = new RedisTaskQueue({
  url: config.redisUrl,
  streamKey: `${config.redisStreamKey}:smoke:${smokeId}`,
  consumerGroup: `${config.redisConsumerGroup}:smoke`,
})
let uploadedObject: ObjectReference | null = null

async function readOne(consumerId = workerId): Promise<TaskQueueDelivery> {
  const deliveries = await queue.read(consumerId, { count: 1, blockMs: 2_000 })
  const first = deliveries[0]
  if (!first) throw new Error('Worker smoke test did not receive a Redis task notification')
  return first
}

try {
  await Promise.all([repository.ping(), objectStorage.ping(), queue.connect()])
  await repository.createProject({
    id: projectId,
    tenantId,
    name: 'Durable worker smoke project',
    code: null,
    customerName: null,
    ownerName: null,
    deadline: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  })

  uploadedObject = await objectStorage.putObject({
    key: originalObjectKey(file),
    body: content,
    contentType: file.mediaType,
    sha256: file.sha256,
  })
  const upload: NewUpload = {
    file: { ...file, objectReference: uploadedObject },
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

  const relay = new OutboxRelay(repository, queue, {
    relayId: `${workerId}:relay`,
    pollIntervalMs: 10,
    leaseMs: config.outboxLeaseMs,
    batchSize: config.outboxBatchSize,
    retryBackoffMs: config.taskRetryBackoffMs,
  })
  if (await relay.runOnce() < 1) {
    throw new Error('Worker smoke test did not claim the transactional upload outbox event')
  }

  const durableWorker = new DurableTaskWorker(
    repository,
    queue,
    new FileContentLoader(repository, objectStorage),
    new DevelopmentDocumentParser(),
    {
      workerId,
      concurrency: 1,
      leaseMs: config.taskLeaseMs,
      heartbeatMs: config.taskHeartbeatMs,
      maxAttempts: config.taskMaxAttempts,
      retryBackoffMs: config.taskRetryBackoffMs,
      queueClaimIdleMs: config.redisClaimIdleMs,
    },
  )

  const abandonedDelivery = await readOne(`${workerId}:abandoned`)
  const reclaimedDeliveries = await queue.reclaim(workerId, 0, 1)
  const firstDelivery = reclaimedDeliveries[0]
  if (firstDelivery?.deliveryId !== abandonedDelivery.deliveryId) {
    throw new Error('Worker smoke test did not recover the abandoned Redis pending message')
  }
  await durableWorker.processDelivery(firstDelivery)
  const completed = await repository.findTask(tenantId, taskId)
  const requirements = await repository.listRequirements(tenantId, projectId, {})
  if (completed?.status !== 'succeeded' || completed.attempt !== 1 || requirements.length !== 3) {
    throw new Error('Worker smoke test did not durably complete the task with fenced effects')
  }

  await queue.publish({
    eventId: firstDelivery.eventId,
    tenantId,
    taskId,
  })
  await durableWorker.processDelivery(await readOne())
  const afterDuplicate = await repository.findTask(tenantId, taskId)
  const requirementsAfterDuplicate = await repository.listRequirements(tenantId, projectId, {})
  if (afterDuplicate?.attempt !== 1 || requirementsAfterDuplicate.length !== requirements.length) {
    throw new Error('Worker smoke test duplicated work after a duplicate Redis notification')
  }

  process.stdout.write(`${JSON.stringify({ status: 'ok', taskId, requirements: requirements.length })}\n`)
} finally {
  await cleanupPool.query('DELETE FROM projects WHERE tenant_id = $1', [tenantId]).catch(() => undefined)
  if (uploadedObject) await Promise.allSettled([objectStorage.deleteObject(uploadedObject)])
  await Promise.allSettled([
    queue.close(),
    objectStorage.close(),
    repository.close(),
    cleanupPool.end(),
  ])
}
