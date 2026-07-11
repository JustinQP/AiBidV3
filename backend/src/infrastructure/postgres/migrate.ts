import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { loadConfig } from '../../config.js'

const MIGRATION_LOCK_ID = 8_142_024

export async function runMigrations(pool: Pool, migrationsDirectory: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const entries = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right))

    for (const name of entries) {
      const alreadyApplied = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1) AS exists',
        [name],
      )
      if (alreadyApplied.rows[0]?.exists) continue
      await applyMigration(client, migrationsDirectory, name)
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined)
    client.release()
  }
}

async function applyMigration(client: PoolClient, directory: string, name: string): Promise<void> {
  const sql = await readFile(path.join(directory, name), 'utf8')
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required to run PostgreSQL migrations')
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  })
  try {
    await runMigrations(pool, path.resolve(process.cwd(), 'migrations'))
  } finally {
    await pool.end()
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url)
if (isDirectExecution) {
  await main()
}

