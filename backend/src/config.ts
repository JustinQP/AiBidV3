export type RepositoryDriver = 'memory' | 'postgres'

export interface AppConfig {
  host: string
  port: number
  logLevel: string
  corsOrigins: string[]
  repositoryDriver: RepositoryDriver
  databaseUrl: string | null
  databaseSsl: boolean
  migrateOnStart: boolean
  devTenantId: string
  maxUploadBytes: number
  devParserDelayMs: number
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = env.REPOSITORY_DRIVER ?? 'memory'
  if (driver !== 'memory' && driver !== 'postgres') {
    throw new Error('REPOSITORY_DRIVER must be either memory or postgres')
  }

  const devTenantId = env.DEV_TENANT_ID ?? 'tenant-demo'
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(devTenantId)) {
    throw new Error('DEV_TENANT_ID must contain only letters, digits, underscores, or hyphens')
  }

  return {
    host: env.HOST ?? '0.0.0.0',
    port: parseInteger(env.PORT, 3000, 'PORT'),
    logLevel: env.LOG_LEVEL ?? 'info',
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:4173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    repositoryDriver: driver,
    databaseUrl: env.DATABASE_URL ?? null,
    databaseSsl: parseBoolean(env.DATABASE_SSL, false),
    migrateOnStart: parseBoolean(env.MIGRATE_ON_START, false),
    devTenantId,
    maxUploadBytes: parseInteger(env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
    devParserDelayMs: parseInteger(env.DEV_PARSER_DELAY_MS, 250, 'DEV_PARSER_DELAY_MS'),
  }
}
