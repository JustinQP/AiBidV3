import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { NewUpload, ParseTaskType, Requirement } from '../src/domain/models.js'
import { sha256Hex } from '../src/domain/source-locator.js'
import { InMemoryBidRepository } from '../src/infrastructure/memory/in-memory-repository.js'
import { PostgresBidRepository } from '../src/infrastructure/postgres/postgres-repository.js'

const tenantId = 'tenant-durable-test'
const projectId = '01PROJECTDURABLE000000000'
const fileId = '01FILEDURABLE000000000000'
const taskId = '01TASKDURABLE000000000000'
const createdAt = '2026-07-10T00:00:00.000Z'

function upload(type: ParseTaskType = 'development-document-parse'): NewUpload {
  return {
    file: {
      id: fileId,
      tenantId,
      projectId,
      fileName: 'fixture.txt',
      mediaType: 'text/plain',
      sizeBytes: 7,
      sha256: 'a'.repeat(64),
      parseStatus: 'queued',
      createdAt,
      updatedAt: createdAt,
      objectReference: {
        key: `tenants/${tenantId}/projects/${projectId}/files/${fileId}/v1/original`,
        versionId: null,
        etag: 'fixture-etag',
      },
    },
    task: {
      id: taskId,
      tenantId,
      projectId,
      fileId,
      type,
      status: 'queued',
      progress: 0,
      attempt: 0,
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
    },
  }
}

async function repositoryWithUpload(
  type: ParseTaskType = 'development-document-parse',
): Promise<InMemoryBidRepository> {
  const repository = new InMemoryBidRepository()
  await repository.createProject({
    id: projectId,
    tenantId,
    name: 'Durable worker test',
    code: null,
    customerName: null,
    ownerName: null,
    deadline: null,
    status: 'draft',
    createdAt,
    updatedAt: createdAt,
  })
  await repository.createUpload(upload(type))
  return repository
}

function requirement(): Requirement {
  return {
    id: '01REQDURABLE0000000000000',
    tenantId,
    projectId,
    fileId,
    taskId,
    code: 'REQ-001',
    title: 'Durable completion',
    description: 'The fenced worker may persist its result.',
    category: 'technical',
    priority: 'mandatory',
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: 'development-fixture',
    confidence: null,
    sourceLocator: {
      kind: 'development-fixture',
      fileId,
      fileName: 'fixture.txt',
      pageNumber: null,
      sectionPath: ['1'],
      paragraphIndex: null,
      quote: 'Durable completion',
    },
    createdAt: '2026-07-10T00:00:02.000Z',
    updatedAt: '2026-07-10T00:00:02.000Z',
  }
}

function realRequirement(change: Partial<Requirement> = {}): Requirement {
  const canonicalText = 'The service must retain audit logs.'
  const quote = 'must retain audit logs'
  const textStart = canonicalText.indexOf(quote)
  return {
    ...requirement(),
    extractionMethod: 'deterministic-rules-v1',
    confidence: 0.875,
    sourceLocator: {
      version: 1,
      kind: 'txt',
      sourceFileId: fileId,
      sourceFileName: 'fixture.txt',
      sourceRevision: 1,
      sourceSha256: 'a'.repeat(64),
      quote,
      quoteSha256: sha256Hex(quote),
      textStart,
      textEnd: textStart + quote.length,
      sectionPath: ['Audit'],
      parserVersion: 'deterministic-rules-v1',
      start: { line: 1, column: textStart },
      end: { line: 1, column: textStart + quote.length },
    },
    ...change,
  }
}

describe('durable repository semantics', () => {
  it('creates an outbox event atomically and fences task completion by lease', async () => {
    const repository = await repositoryWithUpload()
    const events = await repository.claimOutboxEvents(
      'relay-a',
      '2026-07-10T00:00:00.000Z',
      '2026-07-10T00:00:30.000Z',
      10,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tenantId, taskId, publishAttempts: 1 })
    expect(
      await repository.markOutboxEventPublished(
        events[0]!.id,
        'relay-b',
        '2026-07-10T00:00:01.000Z',
      ),
    ).toBe(false)
    expect(
      await repository.markOutboxEventPublished(
        events[0]!.id,
        'relay-a',
        '2026-07-10T00:00:01.000Z',
      ),
    ).toBe(true)

    const claimed = await repository.claimTask(
      tenantId,
      taskId,
      'worker-a',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:11.000Z',
      3,
    )
    expect(claimed?.task).toMatchObject({ status: 'running', attempt: 1 })
    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-b',
        '2026-07-10T00:00:05.000Z',
        '2026-07-10T00:00:15.000Z',
        3,
      ),
    ).toBeNull()
    expect(
      await repository.completeTask(
        { ...claimed!.lease, token: 'stale-token' },
        [requirement()],
        '2026-07-10T00:00:06.000Z',
      ),
    ).toBeNull()

    const renewed = await repository.renewTaskLease(
      claimed!.lease,
      '2026-07-10T00:00:06.000Z',
      '2026-07-10T00:00:20.000Z',
    )
    expect(renewed?.expiresAt).toBe('2026-07-10T00:00:20.000Z')
    expect(
      await repository.completeTask(
        renewed!,
        [requirement()],
        '2026-07-10T00:00:07.000Z',
      ),
    ).toMatchObject({ status: 'succeeded', progress: 100, attempt: 1 })
  })

  it('lets an expired lease be reclaimed and rejects the stale worker', async () => {
    const repository = await repositoryWithUpload()
    const first = await repository.claimTask(
      tenantId,
      taskId,
      'worker-a',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:05.000Z',
      3,
    )
    expect(
      await repository.completeTask(first!.lease, [], '2026-07-10T00:00:06.000Z'),
    ).toBeNull()
    const second = await repository.claimTask(
      tenantId,
      taskId,
      'worker-b',
      '2026-07-10T00:00:06.000Z',
      '2026-07-10T00:00:16.000Z',
      3,
    )
    expect(second?.task.attempt).toBe(2)
    expect(
      await repository.failTask(
        first!.lease,
        { code: 'STALE', message: 'stale worker' },
        '2026-07-10T00:00:07.000Z',
        true,
      ),
    ).toBeNull()
    expect(
      await repository.requeueTask(
        second!.lease,
        { code: 'RETRYABLE', message: 'retry later' },
        '2026-07-10T00:00:08.000Z',
        '2026-07-10T00:01:00.000Z',
      ),
    ).toMatchObject({ status: 'queued', attempt: 2 })

    const initialEvent = await repository.claimOutboxEvents(
      'relay-a',
      '2026-07-10T00:00:09.000Z',
      '2026-07-10T00:00:30.000Z',
      10,
    )
    expect(initialEvent).toHaveLength(1)
    expect(
      await repository.claimOutboxEvents(
        'relay-b',
        '2026-07-10T00:00:31.000Z',
        '2026-07-10T00:00:50.000Z',
        10,
      ),
    ).toHaveLength(1)
    const dueEvents = await repository.claimOutboxEvents(
      'relay-c',
      '2026-07-10T00:01:00.000Z',
      '2026-07-10T00:01:30.000Z',
      10,
    )
    expect(dueEvents.some((event) => event.taskId === taskId && event.publishAttempts === 1)).toBe(true)
  })

  it('does not let a duplicate notification bypass a delayed retry', async () => {
    const repository = await repositoryWithUpload()
    const first = await repository.claimTask(
      tenantId,
      taskId,
      'worker-a',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )
    expect(first).not.toBeNull()
    await repository.requeueTask(
      first!.lease,
      { code: 'OBJECT_STORAGE_UNAVAILABLE', message: 'retry later' },
      '2026-07-10T00:00:02.000Z',
      '2026-07-10T00:01:00.000Z',
    )

    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-duplicate',
        '2026-07-10T00:00:10.000Z',
        '2026-07-10T00:00:40.000Z',
        3,
      ),
    ).toBeNull()
    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-due',
        '2026-07-10T00:01:00.000Z',
        '2026-07-10T00:01:30.000Z',
        3,
      ),
    ).toMatchObject({ task: { status: 'running', attempt: 2 } })
  })

  it('dead-letters a task after crashes consume every allowed attempt', async () => {
    const repository = await repositoryWithUpload()
    const maxAttempts = 3
    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-a',
        '2026-07-10T00:00:01.000Z',
        '2026-07-10T00:00:02.000Z',
        maxAttempts,
      ),
    ).toMatchObject({ task: { attempt: 1 } })
    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-b',
        '2026-07-10T00:00:03.000Z',
        '2026-07-10T00:00:04.000Z',
        maxAttempts,
      ),
    ).toMatchObject({ task: { attempt: 2 } })
    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-c',
        '2026-07-10T00:00:05.000Z',
        '2026-07-10T00:00:06.000Z',
        maxAttempts,
      ),
    ).toMatchObject({ task: { attempt: 3 } })

    expect(
      await repository.claimTask(
        tenantId,
        taskId,
        'worker-d',
        '2026-07-10T00:00:07.000Z',
        '2026-07-10T00:00:08.000Z',
        maxAttempts,
      ),
    ).toBeNull()
    expect(await repository.findTask(tenantId, taskId)).toMatchObject({
      status: 'failed',
      attempt: maxAttempts,
      error: { code: 'TASK_ATTEMPTS_EXHAUSTED' },
    })
  })

  it('releases outbox work and resets attempts on a manual retry', async () => {
    const repository = await repositoryWithUpload()
    const [event] = await repository.claimOutboxEvents(
      'relay-a',
      createdAt,
      '2026-07-10T00:00:10.000Z',
      1,
    )
    expect(
      await repository.releaseOutboxEvent(
        event!.id,
        'relay-a',
        { code: 'QUEUE_DOWN', message: 'Redis unavailable' },
        '2026-07-10T00:00:01.000Z',
        '2026-07-10T00:00:20.000Z',
      ),
    ).toBe(true)
    const [reclaimed] = await repository.claimOutboxEvents(
      'relay-b',
      '2026-07-10T00:00:20.000Z',
      '2026-07-10T00:00:30.000Z',
      1,
    )
    expect(reclaimed?.publishAttempts).toBe(2)
    expect(
      await repository.markOutboxEventPublished(
        reclaimed!.id,
        'relay-b',
        '2026-07-10T00:00:21.000Z',
      ),
    ).toBe(true)

    const claimed = await repository.claimTask(
      tenantId,
      taskId,
      'worker-a',
      '2026-07-10T00:00:21.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )
    await repository.failTask(
      claimed!.lease,
      { code: 'PERMANENT', message: 'manual intervention required' },
      '2026-07-10T00:00:22.000Z',
      true,
    )
    expect(
      await repository.retryTask(tenantId, taskId, '2026-07-10T00:00:23.000Z'),
    ).toMatchObject({ status: 'queued', attempt: 0, error: null })
  })

  it('persists and reads real locator evidence with bounded confidence', async () => {
    const repository = await repositoryWithUpload('document-parse-v1')
    const claimed = await repository.claimTask(
      tenantId,
      taskId,
      'worker-real',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )

    await expect(
      repository.completeTask(
        claimed!.lease,
        [realRequirement()],
        '2026-07-10T00:00:02.000Z',
      ),
    ).resolves.toMatchObject({ status: 'succeeded' })
    await expect(repository.listRequirements(tenantId, projectId, {})).resolves.toMatchObject([
      {
        extractionMethod: 'deterministic-rules-v1',
        confidence: 0.875,
        sourceLocator: {
          kind: 'txt',
          sourceFileId: fileId,
          sourceSha256: 'a'.repeat(64),
        },
      },
    ])
  })

  it.each([
    [
      'file id',
      {
        sourceLocator: {
          ...realRequirement().sourceLocator,
          sourceFileId: '01OTHERFILESOURCE000000000',
        },
      },
    ],
    [
      'file hash',
      {
        sourceLocator: {
          ...realRequirement().sourceLocator,
          sourceSha256: 'b'.repeat(64),
        },
      },
    ],
    [
      'file name',
      {
        sourceLocator: {
          ...realRequirement().sourceLocator,
          sourceFileName: 'other.txt',
        },
      },
    ],
    ['confidence', { confidence: 1.001 }],
  ])('rejects real completion with a mismatched %s', async (_label, change) => {
    const repository = await repositoryWithUpload('document-parse-v1')
    const claimed = await repository.claimTask(
      tenantId,
      taskId,
      'worker-real',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )

    await expect(
      repository.completeTask(
        claimed!.lease,
        [realRequirement(change as Partial<Requirement>)],
        '2026-07-10T00:00:02.000Z',
      ),
    ).rejects.toThrow()
    await expect(repository.findTask(tenantId, taskId)).resolves.toMatchObject({ status: 'running' })
  })

  it('enforces task type, extraction method, locator kind, extension, and media type together', async () => {
    const developmentRepository = await repositoryWithUpload()
    const developmentClaim = await developmentRepository.claimTask(
      tenantId,
      taskId,
      'worker-development',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )
    await expect(
      developmentRepository.completeTask(
        developmentClaim!.lease,
        [realRequirement()],
        '2026-07-10T00:00:02.000Z',
      ),
    ).rejects.toThrow()

    const realRepository = await repositoryWithUpload('document-parse-v1')
    const realClaim = await realRepository.claimTask(
      tenantId,
      taskId,
      'worker-real',
      '2026-07-10T00:00:01.000Z',
      '2026-07-10T00:00:30.000Z',
      3,
    )
    await expect(
      realRepository.completeTask(
        realClaim!.lease,
        [requirement()],
        '2026-07-10T00:00:02.000Z',
      ),
    ).rejects.toThrow()

    const txt = realRequirement().sourceLocator
    const txtLocator = txt as Extract<
      Requirement['sourceLocator'],
      { kind: 'txt' }
    >
    const realBase = Object.fromEntries(
      Object.entries(txtLocator).filter(([key]) => !['kind', 'start', 'end'].includes(key)),
    ) as Omit<typeof txtLocator, 'kind' | 'start' | 'end'>
    await expect(
      realRepository.completeTask(
        realClaim!.lease,
        [
          realRequirement({
            sourceLocator: {
              ...realBase,
              kind: 'pdf',
              regions: [
                { page: 1, bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } },
              ],
            },
          }),
        ],
        '2026-07-10T00:00:02.000Z',
      ),
    ).rejects.toThrow()
  })

  it('rejects malformed persisted locator JSON before returning it', async () => {
    const malformedRow = {
      id: '01REQDURABLE0000000000000',
      tenant_id: tenantId,
      project_id: projectId,
      file_id: fileId,
      task_id: taskId,
      code: 'REQ-001',
      title: 'Malformed evidence',
      description: 'Must not escape validation.',
      category: 'technical',
      priority: 'mandatory',
      confirmation_status: 'pending',
      confirmation_note: null,
      confirmed_at: null,
      extraction_method: 'deterministic-rules-v1',
      confidence: '0.8750',
      source_locator: { kind: 'txt', quote: 'incomplete' },
      source_file_sha256: 'a'.repeat(64),
      source_file_name: 'fixture.txt',
      source_file_media_type: 'text/plain',
      source_task_type: 'document-parse-v1',
      created_at: createdAt,
      updated_at: createdAt,
    }
    const pool = {
      query: async () => ({ rows: [malformedRow], rowCount: 1 }),
      end: async () => undefined,
    } as unknown as Pool
    const repository = new PostgresBidRepository(pool)

    await expect(repository.listRequirements(tenantId, projectId, {})).rejects.toThrow()
  })

  it('rejects persisted real evidence attached to a development task before returning it', async () => {
    const real = realRequirement()
    const inconsistentRow = {
      id: real.id,
      tenant_id: real.tenantId,
      project_id: real.projectId,
      file_id: real.fileId,
      task_id: real.taskId,
      code: real.code,
      title: real.title,
      description: real.description,
      category: real.category,
      priority: real.priority,
      confirmation_status: real.confirmationStatus,
      confirmation_note: real.confirmationNote,
      confirmed_at: real.confirmedAt,
      extraction_method: real.extractionMethod,
      confidence: String(real.confidence),
      source_locator: real.sourceLocator,
      source_file_sha256: 'a'.repeat(64),
      source_file_name: 'fixture.txt',
      source_file_media_type: 'text/plain',
      source_task_type: 'development-document-parse',
      created_at: real.createdAt,
      updated_at: real.updatedAt,
    }
    const pool = {
      query: async () => ({ rows: [inconsistentRow], rowCount: 1 }),
      end: async () => undefined,
    } as unknown as Pool
    const repository = new PostgresBidRepository(pool)

    await expect(repository.listRequirements(tenantId, projectId, {})).rejects.toThrow(
      /real parser evidence is inconsistent/i,
    )
  })

  it('rejects persisted evidence when the joined task type is corrupted', async () => {
    const real = realRequirement()
    const corruptedRow = {
      id: real.id,
      tenant_id: real.tenantId,
      project_id: real.projectId,
      file_id: real.fileId,
      task_id: real.taskId,
      code: real.code,
      title: real.title,
      description: real.description,
      category: real.category,
      priority: real.priority,
      confirmation_status: real.confirmationStatus,
      confirmation_note: real.confirmationNote,
      confirmed_at: real.confirmedAt,
      extraction_method: real.extractionMethod,
      confidence: String(real.confidence),
      source_locator: real.sourceLocator,
      source_file_sha256: 'a'.repeat(64),
      source_file_name: 'fixture.txt',
      source_file_media_type: 'text/plain',
      source_task_type: 'corrupted-task-type',
      created_at: real.createdAt,
      updated_at: real.updatedAt,
    }
    const pool = {
      query: async () => ({ rows: [corruptedRow], rowCount: 1 }),
      end: async () => undefined,
    } as unknown as Pool
    const repository = new PostgresBidRepository(pool)

    await expect(repository.listRequirements(tenantId, projectId, {})).rejects.toThrow(
      /real parser evidence is inconsistent/i,
    )
  })
})
