import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { TaskLease } from '../src/domain/models.js'
import { PostgresBidRepository } from '../src/infrastructure/postgres/postgres-repository.js'

function queryResult() {
  return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] }
}

function recordStatement(statements: string[], statement: string, values: unknown[] = []) {
  statements.push(statement)
  const placeholders = [...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  const expectedValues = placeholders.length === 0 ? 0 : Math.max(...placeholders)
  if (values.length !== expectedValues) {
    throw new Error(
      `SQL binds ${values.length} values but its highest placeholder is $${expectedValues}`,
    )
  }
  return queryResult()
}

function recordingRepository(): { repository: PostgresBidRepository; statements: string[] } {
  const statements: string[] = []
  const client = {
    query: async (statement: string, values?: unknown[]) =>
      recordStatement(statements, statement, values),
    release: () => undefined,
  }
  const pool = {
    connect: async () => client,
    query: async (statement: string, values?: unknown[]) =>
      recordStatement(statements, statement, values),
    end: async () => undefined,
  }
  return {
    repository: new PostgresBidRepository(pool as unknown as Pool),
    statements,
  }
}

function statementContaining(statements: string[], fragment: string): string {
  const statement = statements.find((candidate) => candidate.includes(fragment))
  expect(statement, `Expected a SQL statement containing ${fragment}`).toBeDefined()
  return statement!
}

describe('PostgreSQL lease clock', () => {
  it('anchors task and outbox lease validity to the database clock', async () => {
    const { repository, statements } = recordingRepository()
    const lease: TaskLease = {
      tenantId: 'tenant-clock',
      taskId: '01TASKCLOCK00000000000000',
      workerId: 'worker-clock',
      token: 'lease-token',
      expiresAt: '2000-01-01T00:00:30.000Z',
    }

    await repository.claimTask(
      lease.tenantId,
      lease.taskId,
      lease.workerId,
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:30.000Z',
      3,
    )
    await repository.renewTaskLease(
      lease,
      '2000-01-01T00:00:10.000Z',
      '2000-01-01T00:00:40.000Z',
    )
    await repository.completeTask(lease, [], '2000-01-01T00:00:20.000Z')
    await repository.failTask(
      lease,
      { code: 'TEST', message: 'test' },
      '2000-01-01T00:00:20.000Z',
      true,
    )
    await repository.requeueTask(
      lease,
      { code: 'TEST', message: 'test' },
      '2000-01-01T00:00:20.000Z',
      '2000-01-01T00:01:00.000Z',
    )
    await repository.claimOutboxEvents(
      'relay-clock',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:10.000Z',
      10,
    )
    await repository.markOutboxEventPublished(
      '01EVENTCLOCK0000000000000',
      'relay-clock',
      '2000-01-01T00:00:05.000Z',
    )
    await repository.releaseOutboxEvent(
      '01EVENTCLOCK0000000000000',
      'relay-clock',
      { code: 'QUEUE_DOWN', message: 'retry publication' },
      '2000-01-01T00:00:05.000Z',
      '2000-01-01T00:00:10.000Z',
    )

    const claim = statementContaining(statements, 'UPDATE parse_tasks')
    expect(claim).toContain(
      "lease_expires_at = clock_timestamp() + ($5::timestamptz - $4::timestamptz)",
    )
    expect(claim).toContain(
      "status = 'running' AND lease_expires_at <= clock_timestamp()",
    )
    expect(claim).toContain("status = 'queued' AND next_attempt_at <= clock_timestamp()")
    expect(claim).not.toContain('FROM task_outbox AS pending_retry')

    const renew = statementContaining(statements, 'SET lease_expires_at')
    expect(renew).toContain(
      "SET lease_expires_at = clock_timestamp() + ($6::timestamptz - $5::timestamptz)",
    )
    expect(renew).toContain('AND lease_expires_at > clock_timestamp()')

    const complete = statementContaining(statements, 'SELECT * FROM parse_tasks')
    expect(complete).toContain('AND lease_expires_at > clock_timestamp()')
    for (const fragment of [
      "SET status = 'failed', error = $5::jsonb",
      "SET status = 'queued', progress = 0",
    ]) {
      expect(statementContaining(statements, fragment)).toContain(
        'AND lease_expires_at > clock_timestamp()',
      )
    }

    const outboxClaim = statementContaining(statements, 'WITH candidates AS')
    expect(outboxClaim).toContain('AND available_at <= clock_timestamp()')
    expect(outboxClaim).toContain('lease_expires_at <= clock_timestamp()')
    expect(outboxClaim).toContain(
      "lease_expires_at = clock_timestamp() + ($3::timestamptz - $2::timestamptz)",
    )
    expect(statementContaining(statements, 'SET published_at')).toContain(
      'AND lease_expires_at > clock_timestamp()',
    )
    const release = statementContaining(statements, 'SET available_at')
    expect(release).toContain(
      "SET available_at = clock_timestamp() + ($5::timestamptz - $4::timestamptz)",
    )
    expect(release).toContain('AND lease_expires_at > clock_timestamp()')
  })
})
