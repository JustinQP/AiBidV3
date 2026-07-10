export type RepositoryDriver = 'memory' | 'postgres'
export type ObjectStorageDriver = 'memory' | 's3'

export interface AppConfig {
  host: string
  port: number
  logLevel: string
  corsOrigins: string[]
  repositoryDriver: RepositoryDriver
  databaseUrl: string | null
  databaseSsl: boolean
  migrateOnStart: boolean
  objectStorageDriver: ObjectStorageDriver
  objectStorageTimeoutMs: number
  s3Endpoint: string | null
  s3Region: string
  s3Bucket: string | null
  s3AccessKeyId: string | null
  s3SecretAccessKey: string | null
  s3ForcePathStyle: boolean
  devTenantId: string
  maxUploadBytes: number
  devParserDelayMs: number
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseInteger(value, fallback, name)
  if (parsed === 0) throw new Error(`${name} must be greater than zero`)
  return parsed
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

function parseStrictBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  const normalized = value.toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  throw new Error(`${name} must be a boolean`)
}

function parseS3Endpoint(value: string | undefined): string | null {
  if (value === undefined) return null
  const endpoint = value.trim()
  if (endpoint.length === 0) throw new Error('S3_ENDPOINT must not be empty')
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error('S3_ENDPOINT must not contain credentials')
  }
  return endpoint
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const driver = env.REPOSITORY_DRIVER ?? 'memory'
  if (driver !== 'memory' && driver !== 'postgres') {
    throw new Error('REPOSITORY_DRIVER must be either memory or postgres')
  }

  const objectStorageDriver = env.OBJECT_STORAGE_DRIVER ?? 'memory'
  if (objectStorageDriver !== 'memory' && objectStorageDriver !== 's3') {
    throw new Error('OBJECT_STORAGE_DRIVER must be either memory or s3')
  }
  const s3Region = env.S3_REGION?.trim() || 'us-east-1'
  const s3Bucket = env.S3_BUCKET?.trim() || null
  const s3AccessKeyId = env.S3_ACCESS_KEY ?? null
  const s3SecretAccessKey = env.S3_SECRET_KEY ?? null
  if ((s3AccessKeyId === null) !== (s3SecretAccessKey === null)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be provided together')
  }
  if (s3AccessKeyId !== null && (s3AccessKeyId.length === 0 || s3SecretAccessKey!.length === 0)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must not be empty')
  }
  if (objectStorageDriver === 's3' && s3Bucket === null) {
    throw new Error('S3_BUCKET is required when OBJECT_STORAGE_DRIVER=s3')
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
    objectStorageDriver,
    objectStorageTimeoutMs: parsePositiveInteger(
      env.OBJECT_STORAGE_TIMEOUT_MS,
      10_000,
      'OBJECT_STORAGE_TIMEOUT_MS',
    ),
    s3Endpoint: parseS3Endpoint(env.S3_ENDPOINT),
    s3Region,
    s3Bucket,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3ForcePathStyle: parseStrictBoolean(env.S3_FORCE_PATH_STYLE, false, 'S3_FORCE_PATH_STYLE'),
    devTenantId,
    maxUploadBytes: parseInteger(env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024, 'MAX_UPLOAD_BYTES'),
    devParserDelayMs: parseInteger(env.DEV_PARSER_DELAY_MS, 250, 'DEV_PARSER_DELAY_MS'),
  }
}
