import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import type { NewUpload } from '../src/domain/models.js'
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
    const upload: NewUpload = {
      file: {
        id: fileId,
        tenantId,
        projectId,
        fileName: 'recovery.txt',
        mediaType: 'text/plain',
        sizeBytes: 8,
        sha256: 'a'.repeat(64),
        content: Buffer.from('recovery'),
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

    const recoverable = await repository.recoverPendingTasks()
    expect(recoverable.map((task) => task.id)).toEqual([taskId])

    app = await buildApp({ config, repository })
    const recovered = await waitForRecoveredTask(repository, tenantId, taskId)
    expect(recovered).toMatchObject({ status: 'succeeded', progress: 100 })
    await expect(repository.listRequirements(tenantId, projectId, {})).resolves.toHaveLength(3)
  })
})

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
