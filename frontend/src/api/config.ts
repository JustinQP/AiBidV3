export type DataSource = 'mock' | 'api'

const DEFAULT_API_BASE_URL = '/api/v1'
const DEFAULT_HEALTH_URL = '/health'
const DEFAULT_TIMEOUT_MS = 15_000

function parseDataSource(value: string | undefined): DataSource {
  return value === 'api' ? 'api' : 'mock'
}

function parseTimeout(value: string | undefined): number {
  if (!value) return DEFAULT_TIMEOUT_MS

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export const runtimeConfig = Object.freeze({
  dataSource: parseDataSource(import.meta.env.VITE_DATA_SOURCE),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
  apiHealthUrl: import.meta.env.VITE_API_HEALTH_URL?.trim() || DEFAULT_HEALTH_URL,
  apiTimeoutMs: parseTimeout(import.meta.env.VITE_API_TIMEOUT_MS),
  apiTenantId: import.meta.env.VITE_API_TENANT_ID?.trim() || undefined,
})

export const isApiDataSource = runtimeConfig.dataSource === 'api'
