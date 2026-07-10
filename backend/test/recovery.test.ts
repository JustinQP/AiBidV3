import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
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
  devTenantId: 'tenant-default',
  maxUploadBytes: 1024 * 1024,
  devParserDelayMs: 1,
}

describe('single-instance task recovery', () => {
  let app: FastifyInstance | undefined

  afterEach(async () => {
    await app?.close()
  })

  it('returns queued memory tasks and re-enqueues them when the app starts', async () => {
    const repository = new InMemoryBidRepository()
    const objectStorage = new InMemoryObjectStorage()
    const tenantId = 'tenant-recovery'
    const projectId = createId()
    const fileId = createId()
    const taskId = createId()
    const now = new Date().toISOString()
    await repository.createProject({
      id: projectId,
      tenantId,
      name: '恢复测试项目',
      code: null,
      customerName: null,
      ownerName: null,
      deadline: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    const content = Buffer.from('recovery')
    const file: ProjectFile = {
      id: fileId,
      tenantId,
      projectId,
      fileName: 'recovery.txt',
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
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    }
    await new UploadIngestionService(repository, objectStorage).ingest({ file, task, content })

    const recoverable = await repository.recoverPendingTasks()
    expect(recoverable.map((task) => task.id)).toEqual([taskId])

    app = await buildApp({ config, repository, objectStorage })
    const recovered = await waitForRecoveredTask(repository, tenantId, taskId)
    expect(recovered).toMatchObject({ status: 'succeeded', progress: 100 })
    await expect(repository.listRequirements(tenantId, projectId, {})).resolves.toHaveLength(3)
  })

  it('fails a recovered task when stored bytes do not match the recorded digest', async () => {
    const repository = new InMemoryBidRepository()
    const objectStorage = new CorruptingObjectStorage()
    const tenantId = 'tenant-integrity'
    const projectId = createId()
    const fileId = createId()
    const taskId = createId()
    const now = new Date().toISOString()
    const content = Buffer.from('integrity')
    await repository.createProject({
      id: projectId,
      tenantId,
      name: '完整性校验测试',
      code: null,
      customerName: null,
      ownerName: null,
      deadline: null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    })
    await new UploadIngestionService(repository, objectStorage).ingest({
      file: {
        id: fileId,
        tenantId,
        projectId,
        fileName: 'integrity.txt',
        mediaType: 'text/plain',
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
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
      content,
    })

    app = await buildApp({ config, repository, objectStorage })
    const recovered = await waitForRecoveredTask(repository, tenantId, taskId)

    expect(recovered).toMatchObject({
      status: 'failed',
      error: {
        code: 'STORED_FILE_INTEGRITY_FAILED',
        message: 'Stored file content did not match its recorded digest',
      },
    })
    await expect(repository.listRequirements(tenantId, projectId, {})).resolves.toEqual([])
  })
})

class CorruptingObjectStorage extends InMemoryObjectStorage {
  override async getObject(reference: ObjectReference): Promise<Buffer> {
    const content = await super.getObject(reference)
    content[0] = content[0] === 0 ? 1 : 0
    return content
  }
}

async function waitForRecoveredTask(
  repository: InMemoryBidRepository,
  tenantId: string,
  taskId: string,
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const task = await repository.findTask(tenantId, taskId)
    if (task?.status === 'succeeded' || task?.status === 'failed') return task
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Recovered task did not finish in time')
}
