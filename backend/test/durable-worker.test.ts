import { AppError } from '../src/lib/app-error.js'
import { describe, expect, it } from 'vitest'
import { DurableTaskWorker } from '../src/application/durable-task-worker.js'
import { OutboxRelay } from '../src/application/outbox-relay.js'
import type { FileContentLoader } from '../src/application/file-content-loader.js'
import type { DevelopmentDocumentParser } from '../src/application/development-document-parser.js'
import type {
  ClaimedTask,
  ParseTask,
  Requirement,
  StoredProjectFile,
  TaskError,
  TaskLease,
  TaskOutboxEvent,
} from '../src/domain/models.js'
import type { BidRepository } from '../src/domain/repository.js'
import type {
  TaskQueue,
  TaskQueueDelivery,
  TaskQueuePayload,
} from '../src/domain/task-queue.js'
import { RedisTaskQueue } from '../src/infrastructure/redis/redis-task-queue.js'

const TENANT_ID = 'tenant-test'
const TASK_ID = 'task-test'
const FILE_ID = 'file-test'

function task(overrides: Partial<ParseTask> = {}): ParseTask {
  const now = '2026-07-10T00:00:00.000Z'
  return {
    id: TASK_ID,
    tenantId: TENANT_ID,
    projectId: 'project-test',
    fileId: FILE_ID,
    type: 'development-document-parse',
    status: 'queued',
    progress: 0,
    attempt: 0,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    ...overrides,
  }
}

function file(): StoredProjectFile {
  return {
    id: FILE_ID,
    tenantId: TENANT_ID,
    projectId: 'project-test',
    fileName: 'bid.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 4,
    sha256: 'test',
    parseStatus: 'parsing',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    content: Buffer.from('test'),
  }
}

function delivery(id = '1-0'): TaskQueueDelivery {
  return { deliveryId: id, eventId: `event-${id}`, tenantId: TENANT_ID, taskId: TASK_ID }
}

class FakeQueue implements TaskQueue {
  readonly acknowledged: string[] = []
  readonly published: TaskQueuePayload[] = []
  publishError: Error | null = null

  async connect(): Promise<void> {}
  async publish(payload: TaskQueuePayload): Promise<string> {
    if (this.publishError) throw this.publishError
    this.published.push(payload)
    return `${this.published.length}-0`
  }
  async read(): Promise<TaskQueueDelivery[]> {
    return []
  }
  async reclaim(): Promise<TaskQueueDelivery[]> {
    return []
  }
  async acknowledge(deliveryId: string): Promise<void> {
    this.acknowledged.push(deliveryId)
  }
  async close(): Promise<void> {}
}

class FakeRedisClient {
  readonly commands: string[][] = []
  readonly replies: unknown[] = []
  isOpen = false
  duplicateClient: FakeRedisClient = this

  async connect(): Promise<void> {
    this.isOpen = true
  }
  async close(): Promise<void> {
    this.isOpen = false
  }
  destroy(): void {
    this.isOpen = false
  }
  on(): this {
    return this
  }
  duplicate(): FakeRedisClient {
    return this.duplicateClient
  }
  async sendCommand(command: string[]): Promise<unknown> {
    this.commands.push(command)
    return this.replies.shift() ?? null
  }
}

class FakeWorkerRepository {
  currentTask = task()
  activeToken: string | null = null
  allowClaim = true
  renewSucceeds = true
  completeError: Error | null = null
  completedRequirements: Requirement[] | null = null
  requeued: { error: TaskError; availableAt: string } | null = null
  failed: { error: TaskError; deadLetter: boolean } | null = null
  outboxEvents: TaskOutboxEvent[] = []
  claimedOutboxOwners: string[] = []
  releasedOutbox: { eventId: string; error: TaskError; availableAt: string } | null = null
  publishedOutbox: string[] = []
  private leaseSequence = 0

  async findTask(): Promise<ParseTask | null> {
    return { ...this.currentTask }
  }

  async claimTask(
    _tenantId: string,
    _taskId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    maxAttempts: number,
  ): Promise<ClaimedTask | null> {
    if (!this.allowClaim) return null
    if (this.currentTask.status !== 'queued') return null
    if (this.currentTask.attempt >= maxAttempts) return null
    this.leaseSequence += 1
    this.activeToken = `lease-${this.leaseSequence}`
    this.currentTask = {
      ...this.currentTask,
      status: 'running',
      attempt: this.currentTask.attempt + 1,
      startedAt: now,
      updatedAt: now,
    }
    return {
      task: { ...this.currentTask },
      lease: {
        tenantId: TENANT_ID,
        taskId: TASK_ID,
        workerId,
        token: this.activeToken,
        expiresAt: leaseExpiresAt,
      },
    }
  }

  async renewTaskLease(
    lease: TaskLease,
    _now: string,
    leaseExpiresAt: string,
  ): Promise<TaskLease | null> {
    if (!this.renewSucceeds || lease.token !== this.activeToken) return null
    return { ...lease, expiresAt: leaseExpiresAt }
  }

  async completeTask(
    lease: TaskLease,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null> {
    if (this.completeError) throw this.completeError
    if (lease.token !== this.activeToken) return null
    this.completedRequirements = requirements
    this.activeToken = null
    this.currentTask = {
      ...this.currentTask,
      status: 'succeeded',
      progress: 100,
      finishedAt: now,
      updatedAt: now,
    }
    return { ...this.currentTask }
  }

  async requeueTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    availableAt: string,
  ): Promise<ParseTask | null> {
    if (lease.token !== this.activeToken) return null
    this.requeued = { error, availableAt }
    this.activeToken = null
    this.currentTask = { ...this.currentTask, status: 'queued', error, updatedAt: now }
    return { ...this.currentTask }
  }

  async failTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    deadLetter: boolean,
  ): Promise<ParseTask | null> {
    if (lease.token !== this.activeToken) return null
    this.failed = { error, deadLetter }
    this.activeToken = null
    this.currentTask = {
      ...this.currentTask,
      status: 'failed',
      error,
      finishedAt: now,
      updatedAt: now,
    }
    return { ...this.currentTask }
  }

  async claimOutboxEvents(workerId: string): Promise<TaskOutboxEvent[]> {
    this.claimedOutboxOwners.push(workerId)
    return this.outboxEvents
  }
  async markOutboxEventPublished(eventId: string): Promise<boolean> {
    this.publishedOutbox.push(eventId)
    return true
  }
  async releaseOutboxEvent(
    eventId: string,
    _workerId: string,
    error: TaskError,
    _releasedAt: string,
    availableAt: string,
  ): Promise<boolean> {
    this.releasedOutbox = { eventId, error, availableAt }
    return true
  }
}

function asRepository(repository: FakeWorkerRepository): BidRepository {
  return repository as unknown as BidRepository
}

function loader(load: () => Promise<StoredProjectFile | null>): FileContentLoader {
  return { loadForProcessing: load } as unknown as FileContentLoader
}

function parser(
  parse: () => Promise<Requirement[]> = async () => [],
): DevelopmentDocumentParser {
  return { parse } as DevelopmentDocumentParser
}

function worker(
  repository: FakeWorkerRepository,
  queue: FakeQueue,
  contentLoader = loader(async () => file()),
  documentParser = parser(),
  overrides: Partial<ConstructorParameters<typeof DurableTaskWorker>[4]> = {},
): DurableTaskWorker {
  return new DurableTaskWorker(
    asRepository(repository),
    queue,
    contentLoader,
    documentParser,
    {
      workerId: 'worker-test',
      concurrency: 2,
      leaseMs: 100,
      heartbeatMs: 25,
      maxAttempts: 3,
      retryBackoffMs: 10,
      queueClaimIdleMs: 200,
      ...overrides,
    },
  )
}

describe('DurableTaskWorker', () => {
  it('acks duplicate notifications without duplicating requirements', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const durableWorker = worker(repository, queue)

    await durableWorker.processDelivery(delivery('1-0'))
    await durableWorker.processDelivery(delivery('2-0'))

    expect(repository.currentTask.status).toBe('succeeded')
    expect(repository.currentTask.attempt).toBe(1)
    expect(repository.completedRequirements).toEqual([])
    expect(queue.acknowledged).toEqual(['1-0', '2-0'])
  })

  it('keeps a queued notification pending when the database backoff rejects its claim', async () => {
    const repository = new FakeWorkerRepository()
    repository.allowClaim = false
    const queue = new FakeQueue()

    await worker(repository, queue).processDelivery(delivery())

    expect(repository.currentTask.status).toBe('queued')
    expect(queue.acknowledged).toEqual([])
  })

  it('does not complete or ack after a newer lease fences the worker', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async () => {
        repository.activeToken = 'lease-owned-by-new-worker'
        return []
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.completedRequirements).toBeNull()
    expect(repository.currentTask.status).toBe('running')
    expect(queue.acknowledged).toEqual([])
  })

  it('leaves an ambiguous completion pending instead of changing it to failed', async () => {
    const repository = new FakeWorkerRepository()
    repository.completeError = new Error('connection lost after completion request')
    const queue = new FakeQueue()

    await worker(repository, queue).processDelivery(delivery())

    expect(repository.currentTask.status).toBe('running')
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })

  it('requeues a transient storage failure with backoff before max attempts', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      loader(async () => {
        throw new AppError(
          503,
          'OBJECT_STORAGE_UNAVAILABLE',
          'Stored file is temporarily unavailable',
          'Service Unavailable',
        )
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.requeued?.error.code).toBe('OBJECT_STORAGE_UNAVAILABLE')
    expect(repository.currentTask.status).toBe('queued')
    expect(queue.acknowledged).toEqual(['1-0'])
  })

  it('requeues a transient database read failure instead of dead-lettering it', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      loader(async () => {
        throw new AppError(
          503,
          'DATABASE_UNAVAILABLE',
          'Stored file metadata is temporarily unavailable',
          'Service Unavailable',
        )
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.requeued?.error.code).toBe('DATABASE_UNAVAILABLE')
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual(['1-0'])
  })

  it('permanently fails an integrity error without retrying', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      loader(async () => {
        throw new AppError(
          503,
          'STORED_FILE_INTEGRITY_FAILED',
          'Stored file digest did not match',
          'Service Unavailable',
        )
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.requeued).toBeNull()
    expect(repository.failed).toEqual({
      error: {
        code: 'STORED_FILE_INTEGRITY_FAILED',
        message: 'Stored file digest did not match',
      },
      deadLetter: true,
    })
    expect(queue.acknowledged).toEqual(['1-0'])
  })

  it('does not mutate or ack after heartbeat renewal loses the lease', async () => {
    const repository = new FakeWorkerRepository()
    repository.renewSucceeds = false
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return []
      }),
      { leaseMs: 30, heartbeatMs: 5 },
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })
})

describe('OutboxRelay', () => {
  it('releases a claimed outbox event with backoff when publish fails', async () => {
    const repository = new FakeWorkerRepository()
    repository.outboxEvents = [{
      id: 'event-1',
      tenantId: TENANT_ID,
      taskId: TASK_ID,
      publishAttempts: 1,
      createdAt: '2026-07-10T00:00:00.000Z',
    }]
    const queue = new FakeQueue()
    queue.publishError = new Error('Redis unavailable')
    const relay = new OutboxRelay(
      asRepository(repository),
      queue,
      {
        relayId: 'relay-test',
        pollIntervalMs: 10,
        leaseMs: 100,
        batchSize: 10,
        retryBackoffMs: 25,
      },
    )

    expect(await relay.runOnce(new Date('2026-07-10T00:00:00.000Z'))).toBe(1)
    expect(repository.publishedOutbox).toEqual([])
    expect(repository.releasedOutbox?.eventId).toBe('event-1')
    expect(repository.releasedOutbox?.error).toEqual({
      code: 'TASK_QUEUE_PUBLISH_FAILED',
      message: 'Task queue publish is temporarily unavailable',
    })
  })

  it('uses a process-unique outbox lease owner even when worker IDs are reused', async () => {
    const repository = new FakeWorkerRepository()
    const queue = new FakeQueue()
    const options = {
      relayId: 'worker-reused:relay',
      pollIntervalMs: 10,
      leaseMs: 100,
      batchSize: 10,
      retryBackoffMs: 25,
    }

    await new OutboxRelay(asRepository(repository), queue, options).runOnce()
    await new OutboxRelay(asRepository(repository), queue, options).runOnce()

    expect(repository.claimedOutboxOwners).toHaveLength(2)
    expect(new Set(repository.claimedOutboxOwners).size).toBe(2)
  })
})

describe('RedisTaskQueue', () => {
  it('uses the consumer-group stream commands and parses their raw replies', async () => {
    const commands = new FakeRedisClient()
    const reads = new FakeRedisClient()
    commands.duplicateClient = reads
    commands.replies.push('OK', '1-0', [
      '0-0',
      [['3-0', ['eventId', 'event-3', 'tenantId', TENANT_ID, 'taskId', TASK_ID]]],
      [],
    ], 1, 1)
    reads.replies.push([
      ['aibid:parse-tasks', [
        ['2-0', ['eventId', 'event-2', 'tenantId', TENANT_ID, 'taskId', TASK_ID]],
      ]],
    ])
    const queue = new RedisTaskQueue({
      url: 'redis://not-logged.invalid:6379',
      streamKey: 'aibid:parse-tasks',
      consumerGroup: 'aibid-parser',
      client: commands as never,
    })

    await queue.connect()
    expect(await queue.publish({ eventId: 'event-1', tenantId: TENANT_ID, taskId: TASK_ID }))
      .toBe('1-0')
    expect(await queue.read('worker-1', { count: 1, blockMs: 100 })).toEqual([
      { deliveryId: '2-0', eventId: 'event-2', tenantId: TENANT_ID, taskId: TASK_ID },
    ])
    expect(await queue.reclaim('worker-1', 1_000, 1)).toEqual([
      { deliveryId: '3-0', eventId: 'event-3', tenantId: TENANT_ID, taskId: TASK_ID },
    ])
    await queue.acknowledge('3-0')

    expect(commands.commands.map(([command]) => command)).toEqual([
      'XGROUP',
      'XADD',
      'XAUTOCLAIM',
      'XACK',
      'XDEL',
    ])
    expect(reads.commands[0]?.[0]).toBe('XREADGROUP')
    await queue.close()
  })

  it('advances the XAUTOCLAIM cursor so later pending ranges cannot starve', async () => {
    const commands = new FakeRedisClient()
    const reads = new FakeRedisClient()
    commands.duplicateClient = reads
    commands.replies.push(
      'OK',
      ['5-0', [], []],
      [
        '0-0',
        [['6-0', ['eventId', 'event-6', 'tenantId', TENANT_ID, 'taskId', TASK_ID]]],
        [],
      ],
    )
    const queue = new RedisTaskQueue({
      url: 'redis://not-logged.invalid:6379',
      streamKey: 'aibid:parse-tasks',
      consumerGroup: 'aibid-parser',
      client: commands as never,
    })

    await queue.connect()
    expect(await queue.reclaim('worker-1', 1_000, 1)).toEqual([])
    expect(await queue.reclaim('worker-1', 1_000, 1)).toEqual([
      { deliveryId: '6-0', eventId: 'event-6', tenantId: TENANT_ID, taskId: TASK_ID },
    ])
    expect(
      commands.commands
        .filter(([command]) => command === 'XAUTOCLAIM')
        .map((command) => command[5]),
    ).toEqual(['0-0', '5-0'])
    await queue.close()
  })
})
