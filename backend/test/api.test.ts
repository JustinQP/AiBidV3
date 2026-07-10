import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { AppConfig } from '../src/config.js'
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

describe('AiBid API', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp({ config, repository: new InMemoryBidRepository() })
  })

  afterEach(async () => {
    await app.close()
  })

  it('reports health through the standard data envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { status: 'ok', repository: 'memory' } })
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
