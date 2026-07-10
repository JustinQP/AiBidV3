/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DATA_SOURCE?: 'mock' | 'api'
  readonly VITE_API_BASE_URL?: string
  readonly VITE_API_HEALTH_URL?: string
  readonly VITE_API_TIMEOUT_MS?: string
  readonly VITE_API_POLL_INTERVAL_MS?: string
  readonly VITE_API_TENANT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
