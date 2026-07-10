export type DataSource = 'mock' | 'api'

const DEFAULT_API_BASE_URL = '/api/v1'
const DEFAULT_HEALTH_URL = '/health'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 1_500

function parseDataSource(value: string | undefined): DataSource {
  return value === 'api' ? 'api' : 'mock'
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const runtimeConfig = Object.freeze({
  dataSource: parseDataSource(import.meta.env.VITE_DATA_SOURCE),
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
  apiHealthUrl: import.meta.env.VITE_API_HEALTH_URL?.trim() || DEFAULT_HEALTH_URL,
  apiTimeoutMs: parsePositiveNumber(import.meta.env.VITE_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  apiPollIntervalMs: parsePositiveNumber(import.meta.env.VITE_API_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
  apiTenantId: import.meta.env.VITE_API_TENANT_ID?.trim() || undefined,
})

export const isApiDataSource = runtimeConfig.dataSource === 'api'
