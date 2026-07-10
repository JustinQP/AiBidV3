import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
import type { NewUpload, ParseTask, ProjectFile } from '../src/domain/models.js'
import type { ObjectReference, ObjectStorage, PutObjectInput } from '../src/domain/object-storage.js'
import { InMemoryBidRepository } from '../src/infrastructure/memory/in-memory-repository.js'

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

interface ProjectDto {
  id: string
  name: string
}

interface TaskDto {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  progress: number
}

interface RequirementDto {
  id: string
  confirmationStatus: 'pending' | 'confirmed' | 'rejected'
  extractionMethod: 'development-fixture'
  sourceLocator: {
    kind: 'development-fixture'
    pageNumber: null
    sectionPath: string[]
  }
}

class TestObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>()
  failPing = false
  failPut = false

  async putObject(input: PutObjectInput): Promise<ObjectReference> {
    if (this.failPut) throw new Error('simulated object storage outage')
    this.objects.set(input.key, Buffer.from(input.body))
    return { key: input.key, versionId: null, etag: input.sha256 }
  }

  async getObject(reference: ObjectReference): Promise<Buffer> {
    const content = this.objects.get(reference.key)
    if (!content) throw new Error('object not found')
    return Buffer.from(content)
  }

  async deleteObject(reference: ObjectReference): Promise<void> {
    this.objects.delete(reference.key)
  }

  async ping(): Promise<void> {
    if (this.failPing) throw new Error('simulated object storage outage')
  }

  async close(): Promise<void> {}
}

class UploadFailingRepository extends InMemoryBidRepository {
  override async createUpload(): Promise<{ file: ProjectFile; task: ParseTask }> {
    throw new Error('simulated database failure')
  }
}

class CommitAcknowledgementLostRepository extends InMemoryBidRepository {
  override async createUpload(upload: NewUpload): Promise<{ file: ProjectFile; task: ParseTask }> {
    await super.createUpload(upload)
    throw new Error('simulated lost commit acknowledgement')
  }
}

class PersistenceCheckFailingRepository extends UploadFailingRepository {
  override async findStoredFile(): Promise<never> {
    throw new Error('simulated database outage during persistence check')
  }
}

describe('AiBid API', () => {
  let app: FastifyInstance
  let objectStorage: TestObjectStorage

  beforeEach(async () => {
    objectStorage = new TestObjectStorage()
    app = await buildApp({
      config,
      repository: new InMemoryBidRepository(),
      objectStorage,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('reports health through the standard data envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { status: 'ok', repository: 'memory' } })
  })

  it('reports object storage outages as a stable RFC 7807 service error', async () => {
    objectStorage.failPing = true

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(response.headers['content-type']).toContain('application/problem+json')
    expect(response.json()).toMatchObject({
      type: 'https://aibid.dev/problems/object-storage-unavailable',
      title: 'Service Unavailable',
      status: 503,
      code: 'OBJECT_STORAGE_UNAVAILABLE',
      detail: 'Object storage is temporarily unavailable',
      requestId: expect.any(String),
    })
  })

  it('allows browser preflight for requirement confirmation requests', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/projects/project-1/requirements/requirement-1/confirmation',
      headers: {
        origin: 'http://localhost:4173',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,x-tenant-id',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4173')
    expect(response.headers['access-control-allow-methods']).toContain('PATCH')
    expect(response.headers['access-control-allow-headers']).toContain('x-tenant-id')
  })

  it('isolates project reads by tenant and returns RFC 7807 errors', async () => {
    const project = await createProject(app, 'tenant-a', '医院信息化项目')

    const visible = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
      headers: { 'x-tenant-id': 'tenant-a' },
    })
    expect(visible.statusCode).toBe(200)
    expect(visible.json<{ data: ProjectDto }>().data).toMatchObject({ id: project.id })
    expect(visible.body).not.toContain('tenantId')

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}`,
      headers: { 'x-tenant-id': 'tenant-b' },
    })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.headers['content-type']).toContain('application/problem+json')
    expect(hidden.json()).toMatchObject({
      type: 'https://aibid.dev/problems/project-not-found',
      status: 404,
      code: 'PROJECT_NOT_FOUND',
      requestId: expect.any(String),
    })
  })

  it('runs the upload-to-confirmation development workflow with traceable fixtures', async () => {
    const tenantId = 'tenant-workflow'
    const project = await createProject(app, tenantId, '政务云服务投标')
    const boundary = 'aibid-test-boundary'
    const multipart = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="tender.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n' +
        'development fixture bytes\r\n' +
        `--${boundary}--\r\n`,
    )

    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/files`,
      headers: {
        'x-tenant-id': tenantId,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipart,
    })
    expect(uploaded.statusCode).toBe(202)
    const uploadData = uploaded.json<{ data: { file: { id: string }; task: TaskDto } }>().data
    expect(uploadData.task.status).toBe('queued')
    expect([...objectStorage.objects.keys()]).toEqual([
      `tenants/${tenantId}/projects/${project.id}/files/${uploadData.file.id}/v1/original`,
    ])

    const task = await waitForTask(app, tenantId, uploadData.task.id)
    expect(task).toMatchObject({ status: 'succeeded', progress: 100 })

    const requirementsResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/requirements?confirmationStatus=pending`,
      headers: { 'x-tenant-id': tenantId },
    })
    expect(requirementsResponse.statusCode).toBe(200)
    const requirements = requirementsResponse.json<{ data: RequirementDto[] }>().data
    expect(requirements).toHaveLength(3)
    expect(requirements[0]).toMatchObject({
      confirmationStatus: 'pending',
      extractionMethod: 'development-fixture',
      sourceLocator: {
        kind: 'development-fixture',
        pageNumber: null,
        sectionPath: ['开发演示数据（非原文解析）'],
      },
    })

    const confirmed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/requirements/${requirements[0]!.id}/confirmation`,
      headers: { 'x-tenant-id': tenantId },
      payload: { status: 'confirmed', note: '业务人员已确认' },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json<{ data: RequirementDto }>().data.confirmationStatus).toBe('confirmed')

    const otherTenantTask = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${uploadData.task.id}`,
      headers: { 'x-tenant-id': 'tenant-other' },
    })
    expect(otherTenantTask.statusCode).toBe(404)
  })

  it('does not create file or task records when object storage rejects an upload', async () => {
    const tenantId = 'tenant-storage-down'
    const project = await createProject(app, tenantId, '对象存储故障测试')
    objectStorage.failPut = true

    const uploaded = await uploadFile(app, tenantId, project.id, 'failure.txt', 'not persisted')

    expect(uploaded.statusCode).toBe(503)
    expect(uploaded.json()).toMatchObject({
      status: 503,
      code: 'OBJECT_STORAGE_UNAVAILABLE',
      requestId: expect.any(String),
    })
    const files = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/files`,
      headers: { 'x-tenant-id': tenantId },
    })
    const tasks = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/tasks`,
      headers: { 'x-tenant-id': tenantId },
    })
    expect(files.json()).toEqual({ data: [] })
    expect(tasks.json()).toEqual({ data: [] })
    expect(objectStorage.objects.size).toBe(0)
  })

  it('deletes the uploaded object when database persistence fails', async () => {
    await app.close()
    objectStorage = new TestObjectStorage()
    app = await buildApp({
      config,
      repository: new UploadFailingRepository(),
      objectStorage,
    })
    const tenantId = 'tenant-compensation'
    const project = await createProject(app, tenantId, '补偿删除测试')

    const uploaded = await uploadFile(app, tenantId, project.id, 'failure.txt', 'orphan candidate')

    expect(uploaded.statusCode).toBe(500)
    expect(objectStorage.objects.size).toBe(0)
  })

  it('recovers a committed upload when the database acknowledgement is lost', async () => {
    await app.close()
    objectStorage = new TestObjectStorage()
    app = await buildApp({
      config,
      repository: new CommitAcknowledgementLostRepository(),
      objectStorage,
    })
    const tenantId = 'tenant-lost-acknowledgement'
    const project = await createProject(app, tenantId, '提交确认丢失测试')

    const uploaded = await uploadFile(app, tenantId, project.id, 'committed.txt', 'committed bytes')

    expect(uploaded.statusCode).toBe(202)
    expect(objectStorage.objects.size).toBe(1)
    const taskId = uploaded.json<{ data: { task: TaskDto } }>().data.task.id
    await expect(waitForTask(app, tenantId, taskId)).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('preserves the object when the database commit outcome cannot be checked', async () => {
    await app.close()
    objectStorage = new TestObjectStorage()
    app = await buildApp({
      config,
      repository: new PersistenceCheckFailingRepository(),
      objectStorage,
    })
    const tenantId = 'tenant-ambiguous-commit'
    const project = await createProject(app, tenantId, '提交状态未知测试')

    const uploaded = await uploadFile(app, tenantId, project.id, 'uncertain.txt', 'uncertain bytes')

    expect(uploaded.statusCode).toBe(500)
    expect(objectStorage.objects.size).toBe(1)
  })
})

async function createProject(app: FastifyInstance, tenantId: string, name: string): Promise<ProjectDto> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { 'x-tenant-id': tenantId },
    payload: { name },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: ProjectDto }>().data
}

async function waitForTask(app: FastifyInstance, tenantId: string, taskId: string): Promise<TaskDto> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}`,
      headers: { 'x-tenant-id': tenantId },
    })
    const task = response.json<{ data: TaskDto }>().data
    if (task.status === 'succeeded' || task.status === 'failed') return task
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('Task did not finish in time')
}

async function uploadFile(
  app: FastifyInstance,
  tenantId: string,
  projectId: string,
  fileName: string,
  content: string,
) {
  const boundary = 'aibid-object-storage-test-boundary'
  const multipart = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      'Content-Type: text/plain\r\n\r\n' +
      `${content}\r\n` +
      `--${boundary}--\r\n`,
  )
  return app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/files`,
    headers: {
      'x-tenant-id': tenantId,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipart,
  })
}
