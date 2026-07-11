import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { UploadIngestionService } from '../src/application/upload-ingestion-service.js'
import type { AppConfig } from '../src/config.js'
import type { ParseTask, ProjectFile } from '../src/domain/models.js'
import type { ObjectReference } from '../src/domain/object-storage.js'
import { InMemoryObjectStorage } from '../src/infrastructure/memory/in-memory-object-storage.js'
import { InMemoryBidRepository } from '../src/infrastructure/memory/in-memory-repository.js'
import { createId } from '../src/lib/id.js'

const config: AppConfig = {
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  corsOrigins: ['http://localhost:4173'],
  repositoryDriver: 'memory',
  databaseUrl: null,
  databaseSsl: false,
  migrateOnStart: false,
  objectStorageDriver: 'memory',
  objectStorageTimeoutMs: 1000,
  s3Endpoint: null,
  s3Region: 'us-east-1',
  s3Bucket: null,
  s3AccessKeyId: null,
  s3SecretAccessKey: null,
  s3ForcePathStyle: true,
  redisUrl: null,
  redisStreamKey: 'aibid:parse-tasks',
  redisConsumerGroup: 'aibid-parser',
  redisClaimIdleMs: 60_000,
  workerId: null,
  workerConcurrency: 2,
  taskLeaseMs: 30_000,
  taskHeartbeatMs: 10_000,
  taskMaxAttempts: 3,
  taskRetryBackoffMs: 1_000,
  outboxPollIntervalMs: 250,
  outboxLeaseMs: 10_000,
  outboxBatchSize: 20,
  devTenantId: 'tenant-default',
  maxUploadBytes: 1024 * 1024,
  devParserDelayMs: 1,
}

describe('task execution boundaries', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
  })

  it('leaves PostgreSQL-mode tasks queued for the independent worker', async () => {
    const repository = new InMemoryBidRepository()
    const objectStorage = new InMemoryObjectStorage()
    const tenantId = 'tenant-worker-boundary'
    const projectId = createId()
    const fileId = createId()
    const taskId = createId()
    const now = new Date().toISOString()
    await repository.createProject({
      id: projectId,
      tenantId,
      name: '独立 Worker 边界测试',
      code: null,
      customerName: null,
      ownerName: null,
      deadline: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    const content = Buffer.from('durable worker boundary')
    const file: ProjectFile = {
      id: fileId,
      tenantId,
      projectId,
      fileName: 'boundary.txt',
      mediaType: 'text/plain',
      sizeBytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      parseStatus: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    const task: ParseTask = {
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
    }
    await new UploadIngestionService(repository, objectStorage).ingest({ file, task, content })

    app = await buildApp({
      config: {
        ...config,
        repositoryDriver: 'postgres',
        databaseUrl: 'postgresql://injected-repository',
        objectStorageDriver: 's3',
        s3Bucket: 'injected-storage',
      },
      repository,
      objectStorage,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(repository.findTask(tenantId, taskId)).resolves.toMatchObject({
      status: 'queued',
      attempt: 0,
    })
  })

  it('keeps the zero-dependency memory mode interactive and fails corrupted content safely', async () => {
    const repository = new InMemoryBidRepository()
    const objectStorage = new CorruptingObjectStorage()
    const tenantId = 'tenant-memory-integrity'
    const projectId = createId()
    const now = new Date().toISOString()
    await repository.createProject({
      id: projectId,
      tenantId,
      name: '内存模式完整性测试',
      code: null,
      customerName: null,
      ownerName: null,
      deadline: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    app = await buildApp({ config, repository, objectStorage })

    const boundary = 'aibid-memory-integrity-boundary'
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/files`,
      headers: {
        'x-tenant-id': tenantId,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file"; filename="integrity.txt"\r\n' +
          'Content-Type: text/plain\r\n\r\n' +
          'integrity bytes\r\n' +
          `--${boundary}--\r\n`,
      ),
    })
    expect(response.statusCode).toBe(202)
    const taskId = response.json<{ data: { task: { id: string } } }>().data.task.id
    const failed = await waitForTerminalTask(repository, tenantId, taskId)

    expect(failed).toMatchObject({
      status: 'failed',
      attempt: 1,
      error: {
        code: 'STORED_FILE_INTEGRITY_FAILED',
        message: 'Stored file content did not match its recorded digest',
      },
    })
  })
})

class CorruptingObjectStorage extends InMemoryObjectStorage {
  override async getObject(reference: ObjectReference): Promise<Buffer> {
    const content = await super.getObject(reference)
    content[0] = content[0] === 0 ? 1 : 0
    return content
  }
}

async function waitForTerminalTask(
  repository: InMemoryBidRepository,
  tenantId: string,
  taskId: string,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await repository.findTask(tenantId, taskId)
    if (task?.status === 'succeeded' || task?.status === 'failed') return task
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Task did not reach a terminal state')
}
