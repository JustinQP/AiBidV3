import { describe, expect, it } from 'vitest'
import type { NewUpload, Requirement } from '../src/domain/models.js'
import { InMemoryBidRepository } from '../src/infrastructure/memory/in-memory-repository.js'

const tenantId = 'tenant-durable-test'
const projectId = '01PROJECTDURABLE000000000'
const fileId = '01FILEDURABLE000000000000'
const taskId = '01TASKDURABLE000000000000'
const createdAt = '2026-07-10T00:00:00.000Z'

function upload(): NewUpload {
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
      type: 'development-document-parse',
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

async function repositoryWithUpload(): Promise<InMemoryBidRepository> {
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
  await repository.createUpload(upload())
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
})
