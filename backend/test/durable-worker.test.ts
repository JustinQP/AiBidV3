import { AppError } from '../src/lib/app-error.js'
import { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import { DurableTaskWorker } from '../src/application/durable-task-worker.js'
import { OutboxRelay } from '../src/application/outbox-relay.js'
import { UploadProcessingService } from '../src/application/upload-processing-service.js'
import type { DocumentParser } from '../src/application/document-parser.js'
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
import { ParserError, type ParserFailureCode } from '../src/infrastructure/parser/parser-types.js'
import { IsolatedDocumentParser } from '../src/infrastructure/parser/isolated-document-parser.js'
import { RedisTaskQueue } from '../src/infrastructure/redis/redis-task-queue.js'

const TENANT_ID = 'tenant-test'
const TASK_ID = 'task-test'
const FILE_ID = 'file-test'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

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
  readonly pendingDeliveries: TaskQueueDelivery[] = []
  publishError: Error | null = null

  async connect(): Promise<void> {}
  async publish(payload: TaskQueuePayload): Promise<string> {
    if (this.publishError) throw this.publishError
    this.published.push(payload)
    return `${this.published.length}-0`
  }
  async read(): Promise<TaskQueueDelivery[]> {
    return this.pendingDeliveries.splice(0)
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
  renewCount = 0
  observeRenewal: ((count: number) => void) | null = null
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
    this.renewCount += 1
    this.observeRenewal?.(this.renewCount)
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
  parse: DocumentParser['parse'] = async () => [],
): DocumentParser {
  return { parse }
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

  it('passes the complete claimed task and an owned signal to the parser', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    let parsedTask: ParseTask | null = null
    const parserState: { signal?: AbortSignal } = {}
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async (_file, claimedTask, _now, signal) => {
        parsedTask = claimedTask
        parserState.signal = signal
        return []
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(parsedTask).toMatchObject({
      id: TASK_ID,
      type: 'document-parse-v1',
      status: 'running',
      attempt: 1,
    })
    expect(parserState.signal).toBeInstanceOf(AbortSignal)
    expect(parserState.signal?.aborted).toBe(false)
    expect(queue.acknowledged).toEqual(['1-0'])
  })

  it.each<[ParserFailureCode, string]>([
    ['INVALID_PDF', 'PDF structure is malformed'],
    ['DOCUMENT_PARSE_TIMEOUT', 'Document parsing exceeded its deadline'],
    ['DOCUMENT_RESOURCE_LIMIT_EXCEEDED', 'Parser exceeded its heap limit'],
    ['OCR_REQUIRED', 'PDF has no extractable text layer'],
  ])('persists permanent parser error %s with its stable code', async (code, message) => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async () => {
        throw new ParserError(code, message)
      }),
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.requeued).toBeNull()
    expect(repository.failed).toEqual({
      error: { code, message },
      deadLetter: true,
    })
    expect(queue.acknowledged).toEqual(['1-0'])
  })

  it('renews the lease while asynchronous parsing remains in flight', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const twoRenewalsObserved = deferred()
    repository.observeRenewal = (count) => {
      if (count >= 2) twoRenewalsObserved.resolve()
    }
    const queue = new FakeQueue()
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async () => {
        await twoRenewalsObserved.promise
        return []
      }),
      { leaseMs: 250, heartbeatMs: 10 },
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.renewCount).toBeGreaterThanOrEqual(2)
    expect(repository.currentTask.status).toBe('succeeded')
    expect(queue.acknowledged).toEqual(['1-0'])
  }, 1_000)

  it('renews the lease while an isolated parser worker is CPU-bound', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    const fixtureUrl = new URL('./fixtures/parser-worker-fixture.mjs', import.meta.url)
    const cpuPhase = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    let renewalsWhileCpuBound = 0
    repository.observeRenewal = () => {
      if (Atomics.load(cpuPhase, 0) === 1) renewalsWhileCpuBound += 1
    }
    const isolatedParser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => new Worker(fixtureUrl, {
        ...options,
        workerData: {
          ...options.workerData as object,
          fixtureCpuPhase: cpuPhase.buffer,
        },
      }),
    })
    const cpuBoundFile = {
      ...file(),
      fileName: 'fixture-cpu.txt',
      mediaType: 'text/plain',
    }
    const durableWorker = worker(
      repository,
      queue,
      loader(async () => cpuBoundFile),
      isolatedParser,
      { leaseMs: 250, heartbeatMs: 10 },
    )

    await durableWorker.processDelivery(delivery())

    expect(repository.renewCount).toBeGreaterThanOrEqual(2)
    expect(renewalsWhileCpuBound).toBeGreaterThanOrEqual(2)
    expect(repository.currentTask.status).toBe('succeeded')
    expect(repository.completedRequirements).toHaveLength(1)
    expect(repository.completedRequirements?.[0]?.title).toBe('CPU-bound fixture requirement')
    expect(queue.acknowledged).toEqual(['1-0'])
  }, 3_000)

  it('terminates an isolated CPU-bound parser after lease loss without mutation or ack', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ id: 'fixture-hang', type: 'document-parse-v1' })
    repository.renewSucceeds = false
    const queue = new FakeQueue()
    const childExited = deferred()
    const fixtureUrl = new URL('./fixtures/parser-worker-fixture.mjs', import.meta.url)
    const isolatedParser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        const child = new Worker(fixtureUrl, options)
        child.once('exit', () => childExited.resolve())
        return child
      },
    })
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      isolatedParser,
      { leaseMs: 30, heartbeatMs: 5 },
    )

    await durableWorker.processDelivery(delivery())
    await childExited.promise

    expect(repository.renewCount).toBeGreaterThanOrEqual(1)
    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.requeued).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  }, 3_000)

  it('terminates an isolated CPU-bound parser on shutdown without mutation or ack', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ id: 'fixture-hang', type: 'document-parse-v1' })
    const queue = new FakeQueue()
    const shutdown = new AbortController()
    const childOnline = deferred()
    const childExited = deferred()
    const fixtureUrl = new URL('./fixtures/parser-worker-fixture.mjs', import.meta.url)
    const isolatedParser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        const child = new Worker(fixtureUrl, options)
        child.once('online', () => childOnline.resolve())
        child.once('exit', () => childExited.resolve())
        return child
      },
    })
    const durableWorker = worker(repository, queue, undefined, isolatedParser)

    const processing = durableWorker.processDelivery(delivery(), shutdown.signal)
    await childOnline.promise
    shutdown.abort()
    await processing
    await childExited.promise

    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.requeued).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  }, 3_000)

  it('aborts the parser and does not mutate or ack after heartbeat renewal loses the lease', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    repository.renewSucceeds = false
    const queue = new FakeQueue()
    const parseStarted = deferred()
    const parserState: { signal?: AbortSignal } = {}
    let parserCleanupFinished = false
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async (_file, _task, _now, signal) => {
        parserState.signal = signal
        parseStarted.resolve()
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
        parserCleanupFinished = true
        signal.throwIfAborted()
        return []
      }),
      { leaseMs: 30, heartbeatMs: 5 },
    )

    const processing = durableWorker.processDelivery(delivery())
    await parseStarted.promise
    await processing

    expect(parserState.signal?.aborted).toBe(true)
    expect(parserCleanupFinished).toBe(true)
    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.requeued).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })

  it('waits for parser cancellation on shutdown and performs no task mutation or ack', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    const shutdown = new AbortController()
    const parseStarted = deferred()
    const abortObserved = deferred()
    const allowParserCleanup = deferred()
    let parserCleanupFinished = false
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async (_file, _task, _now, signal) => {
        parseStarted.resolve()
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        abortObserved.resolve()
        await allowParserCleanup.promise
        parserCleanupFinished = true
        signal.throwIfAborted()
        return []
      }),
    )

    const processing = durableWorker.processDelivery(delivery(), shutdown.signal)
    await parseStarted.promise
    shutdown.abort()
    const cancellationReachedParser = await Promise.race([
      abortObserved.promise.then(() => true),
      processing.then(() => false),
    ])
    expect(cancellationReachedParser).toBe(true)
    let processingSettled = false
    void processing.then(() => {
      processingSettled = true
    })
    await Promise.resolve()

    expect(processingSettled).toBe(false)
    allowParserCleanup.resolve()
    await processing
    expect(parserCleanupFinished).toBe(true)
    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.requeued).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })

  it('propagates the run shutdown signal into scheduled deliveries', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    queue.pendingDeliveries.push(delivery())
    const shutdown = new AbortController()
    const parserState: { signal?: AbortSignal } = {}
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async (_file, _task, _now, signal) => {
        parserState.signal = signal
        shutdown.abort()
        return []
      }),
    )

    await durableWorker.run(shutdown.signal)

    expect(parserState.signal?.aborted).toBe(true)
    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })

  it('blocks completion when shutdown aborts after parsing but before completion', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const queue = new FakeQueue()
    const shutdown = new AbortController()
    const durableWorker = worker(
      repository,
      queue,
      undefined,
      parser(async () => {
        shutdown.abort()
        return []
      }),
    )

    await durableWorker.processDelivery(delivery(), shutdown.signal)

    expect(repository.currentTask.status).toBe('running')
    expect(repository.completedRequirements).toBeNull()
    expect(repository.requeued).toBeNull()
    expect(repository.failed).toBeNull()
    expect(queue.acknowledged).toEqual([])
  })
})

describe('UploadProcessingService', () => {
  it('refuses to parse a real task in the development-only processor', async () => {
    const repository = new FakeWorkerRepository()
    repository.currentTask = task({ type: 'document-parse-v1' })
    const loadForProcessing = vi.fn(async () => file())
    const parse = vi.fn(async () => [])
    const processor = new UploadProcessingService(
      asRepository(repository),
      loader(loadForProcessing),
      { parse } as DevelopmentDocumentParser,
      0,
      'development-worker',
      100,
      3,
    )

    processor.enqueue(TENANT_ID, TASK_ID)
    await processor.waitForIdle()

    expect(loadForProcessing).not.toHaveBeenCalled()
    expect(parse).not.toHaveBeenCalled()
    expect(repository.completedRequirements).toBeNull()
    expect(repository.failed).toMatchObject({
      error: { code: 'DEVELOPMENT_PARSER_FAILED' },
      deadLetter: true,
    })
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
  it('parses RESP3 object replies returned by node-redis 6 for XREADGROUP', async () => {
    const commands = new FakeRedisClient()
    const reads = new FakeRedisClient()
    commands.duplicateClient = reads
    commands.replies.push('OK')
    reads.replies.push({
      'aibid:parse-tasks': [
        ['2-0', ['eventId', 'event-2', 'tenantId', TENANT_ID, 'taskId', TASK_ID]],
      ],
    })
    const queue = new RedisTaskQueue({
      url: 'redis://not-logged.invalid:6379',
      streamKey: 'aibid:parse-tasks',
      consumerGroup: 'aibid-parser',
      client: commands as never,
    })

    await queue.connect()
    expect(await queue.read('worker-1', { count: 1, blockMs: 100 })).toEqual([
      { deliveryId: '2-0', eventId: 'event-2', tenantId: TENANT_ID, taskId: TASK_ID },
    ])
    await queue.close()
  })

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
