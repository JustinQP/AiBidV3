import path from 'node:path'
import { Pool } from 'pg'
import type { AppConfig } from '../config.js'
import type { BidRepository } from '../domain/repository.js'
import { InMemoryBidRepository } from './memory/in-memory-repository.js'
import { runMigrations } from './postgres/migrate.js'
import { PostgresBidRepository } from './postgres/postgres-repository.js'

export async function createRepository(config: AppConfig): Promise<BidRepository> {
  if (config.repositoryDriver === 'memory') return new InMemoryBidRepository()
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required when REPOSITORY_DRIVER=postgres')

  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  })
  if (config.migrateOnStart) {
    await runMigrations(pool, path.resolve(process.cwd(), 'migrations'))
  }
  return new PostgresBidRepository(pool)
}

