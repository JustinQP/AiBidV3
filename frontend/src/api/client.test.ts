import { describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from './client'
import type { ProcessingTask, ProjectRecord, RequirementRecord } from './contracts'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const project: ProjectRecord = {
  id: 'project-1',
  name: '智慧园区项目',
  code: 'BID-001',
  customerName: '采购人',
  ownerName: null,
  deadline: '2026-07-22T09:30:00+08:00',
  status: 'active',
  createdAt: '2026-07-10T08:00:00Z',
  updatedAt: '2026-07-10T08:00:00Z',
}

describe('API client', () => {
  it('unwraps data envelopes and includes the development tenant context', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: [project] }))
    const client = createApiClient({ baseUrl: 'http://api.test/api/v1/', tenantId: 'tenant-a', fetch: fetchMock })

    await expect(client.projects.list()).resolves.toEqual([project])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/projects',
      expect.objectContaining({
        headers: expect.any(Headers),
        signal: expect.any(AbortSignal),
      }),
    )
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('x-tenant-id')).toBe('tenant-a')
  })

  it('uploads multipart files without overriding the browser content type boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: { file: {}, task: {} } }))
    const client = createApiClient({ baseUrl: '/api/v1', fetch: fetchMock })
    const file = new File(['bid'], '招标 文件.pdf', { type: 'application/pdf' })

    await client.files.upload('project/1', file)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/projects/project%2F1/files')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBeInstanceOf(FormData)
    expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
    expect((init?.body as FormData).get('file')).toBe(file)
  })

  it('uses the project-scoped task and requirement list routes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ data: [] }))
    const client = createApiClient({ baseUrl: '/api/v1', fetch: fetchMock })

    await client.tasks.list('project/1')
    await client.requirements.list('project/1', { confirmationStatus: 'pending', priority: 'mandatory' })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/projects/project%2F1/tasks')
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/v1/projects/project%2F1/requirements?confirmationStatus=pending&priority=mandatory',
    )
  })

  it('sends typed requirement confirmation patches as JSON', async () => {
    const updated = { id: 'REQ-1', confirmationStatus: 'confirmed' } as RequirementRecord
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: updated }))
    const client = createApiClient({ baseUrl: '/api/v1', fetch: fetchMock })

    await expect(client.requirements.confirm('project/1', 'REQ/1', { status: 'confirmed', note: '人工复核通过' })).resolves.toEqual(updated)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/projects/project%2F1/requirements/REQ%2F1/confirmation')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe('{"status":"confirmed","note":"人工复核通过"}')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
  })

  it('retries a failed task through the task resource', async () => {
    const retried = { id: 'task-1', status: 'queued', progress: 0 } as ProcessingTask
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: retried }, { status: 202 }))
    const client = createApiClient({ baseUrl: '/api/v1', fetch: fetchMock })

    await expect(client.tasks.retry('task/1')).resolves.toEqual(retried)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/tasks/task%2F1/retry')
    expect(init?.method).toBe('POST')
  })

  it('exposes RFC 7807 details through ApiError', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: 'https://aibid.example/problems/not-found',
      title: 'Project not found',
      status: 404,
      detail: 'No project exists with id missing.',
      code: 'PROJECT_NOT_FOUND',
    }, { status: 404, statusText: 'Not Found' }))
    const client = createApiClient({ baseUrl: '/api/v1', fetch: fetchMock })

    const error = await client.projects.get('missing').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, message: 'No project exists with id missing.' })
    expect((error as ApiError).problem.code).toBe('PROJECT_NOT_FOUND')
  })

  it('uses the unprefixed health endpoint', async () => {
    const health = { status: 'ok', repository: 'memory', timestamp: '2026-07-10T18:30:00.000Z' }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ data: health }))
    const client = createApiClient({ baseUrl: '/api/v1', healthUrl: '/health', fetch: fetchMock })

    await expect(client.health()).resolves.toEqual(health)
    expect(fetchMock).toHaveBeenCalledWith('/health', expect.any(Object))
  })
})
