import { runtimeConfig } from './config'
import type {
  ApiEnvelope,
  ApiProblem,
  CreateProjectInput,
  HealthStatus,
  ProcessingTask,
  ProjectFileRecord,
  ProjectRecord,
  RequirementListQuery,
  RequirementRecord,
  ConfirmRequirementInput,
  UploadProjectFileResult,
} from './contracts'

type QueryValue = string | number | boolean | null | undefined

export interface ApiClientOptions {
  baseUrl?: string
  healthUrl?: string
  timeoutMs?: number
  tenantId?: string
  fetch?: typeof fetch
}

export interface UploadFileOptions {
  signal?: AbortSignal
}

export class ApiError extends Error {
  readonly status: number
  readonly problem: ApiProblem

  constructor(problem: ApiProblem) {
    super(problem.detail || problem.title)
    this.name = 'ApiError'
    this.status = problem.status
    this.problem = problem
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function withQuery(path: string, query?: object): string {
  if (!query) return path

  const search = new URLSearchParams()
  Object.entries(query as Record<string, QueryValue>).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  })
  const encoded = search.toString()
  return encoded ? `${path}?${encoded}` : path
}

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  return typeof value === 'object' && value !== null && 'data' in value
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('json')) return response.json()

  const text = await response.text()
  return text.length > 0 ? text : undefined
}

function toProblem(response: Response, body: unknown): ApiProblem {
  if (typeof body === 'object' && body !== null) {
    const candidate = body as Partial<ApiProblem>
    return {
      type: candidate.type,
      title: candidate.title || response.statusText || 'Request failed',
      status: candidate.status || response.status,
      detail: candidate.detail,
      instance: candidate.instance,
      code: candidate.code,
      requestId: candidate.requestId,
    }
  }

  return {
    title: response.statusText || 'Request failed',
    status: response.status,
    detail: typeof body === 'string' ? body : undefined,
  }
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? runtimeConfig.apiBaseUrl
  const healthUrl = options.healthUrl ?? runtimeConfig.apiHealthUrl
  const timeoutMs = options.timeoutMs ?? runtimeConfig.apiTimeoutMs
  const tenantId = options.tenantId ?? runtimeConfig.apiTenantId
  const fetchImplementation = options.fetch ?? globalThis.fetch

  async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController()
    const externalSignal = init.signal
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason)

    if (externalSignal?.aborted) abortFromExternalSignal()
    else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })

    const timeoutId = globalThis.setTimeout(() => controller.abort('Request timed out'), timeoutMs)

    try {
      const response = await fetchImplementation(url, { ...init, signal: controller.signal })
      const body = await parseResponseBody(response)

      if (!response.ok) throw new ApiError(toProblem(response, body))
      return (isEnvelope<T>(body) ? body.data : body) as T
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (controller.signal.aborted) {
        throw new ApiError({ title: 'Request aborted', status: 0, detail: String(controller.signal.reason ?? '') })
      }
      throw new ApiError({
        title: 'Network request failed',
        status: 0,
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      globalThis.clearTimeout(timeoutId)
      externalSignal?.removeEventListener('abort', abortFromExternalSignal)
    }
  }

  function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (tenantId) headers.set('x-tenant-id', tenantId)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    return request<T>(joinUrl(baseUrl, path), { ...init, headers })
  }

  return {
    health: (signal?: AbortSignal) => request<HealthStatus>(healthUrl, {
      headers: { Accept: 'application/json' },
      signal,
    }),
    projects: {
      list: (signal?: AbortSignal) => jsonRequest<ProjectRecord[]>(
        '/projects',
        { signal },
      ),
      get: (projectId: string, signal?: AbortSignal) => jsonRequest<ProjectRecord>(
        `/projects/${encodeURIComponent(projectId)}`,
        { signal },
      ),
      create: (input: CreateProjectInput, signal?: AbortSignal) => jsonRequest<ProjectRecord>(
        '/projects',
        { method: 'POST', body: JSON.stringify(input), signal },
      ),
    },
    files: {
      list: (projectId: string, signal?: AbortSignal) => jsonRequest<ProjectFileRecord[]>(
        `/projects/${encodeURIComponent(projectId)}/files`,
        { signal },
      ),
      upload: (projectId: string, file: File, uploadOptions: UploadFileOptions = {}) => {
        const form = new FormData()
        form.set('file', file)

        const headers = new Headers({ Accept: 'application/json' })
        if (tenantId) headers.set('x-tenant-id', tenantId)

        return request<UploadProjectFileResult>(
          joinUrl(baseUrl, `/projects/${encodeURIComponent(projectId)}/files`),
          { method: 'POST', headers, body: form, signal: uploadOptions.signal },
        )
      },
    },
    tasks: {
      list: (projectId: string, signal?: AbortSignal) => jsonRequest<ProcessingTask[]>(
        `/projects/${encodeURIComponent(projectId)}/tasks`,
        { signal },
      ),
      get: (taskId: string, signal?: AbortSignal) => jsonRequest<ProcessingTask>(
        `/tasks/${encodeURIComponent(taskId)}`,
        { signal },
      ),
      retry: (taskId: string, signal?: AbortSignal) => jsonRequest<ProcessingTask>(
        `/tasks/${encodeURIComponent(taskId)}/retry`,
        { method: 'POST', signal },
      ),
    },
    requirements: {
      list: (projectId: string, query?: RequirementListQuery, signal?: AbortSignal) => jsonRequest<RequirementRecord[]>(
        withQuery(`/projects/${encodeURIComponent(projectId)}/requirements`, query),
        { signal },
      ),
      confirm: (projectId: string, requirementId: string, input: ConfirmRequirementInput, signal?: AbortSignal) => jsonRequest<RequirementRecord>(
        `/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(requirementId)}/confirmation`,
        { method: 'PATCH', body: JSON.stringify(input), signal },
      ),
    },
  }
}

export type ApiClient = ReturnType<typeof createApiClient>

export const apiClient = createApiClient()
