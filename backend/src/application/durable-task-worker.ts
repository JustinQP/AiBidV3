import type { TaskError, TaskLease } from '../domain/models.js'
import type { BidRepository } from '../domain/repository.js'
import type { TaskQueue, TaskQueueDelivery } from '../domain/task-queue.js'
import { AppError } from '../lib/app-error.js'
import { ParserError } from '../infrastructure/parser/parser-types.js'
import type { DocumentParser } from './document-parser.js'
import type { FileContentLoader } from './file-content-loader.js'

const NEVER_ABORTED_SIGNAL = new AbortController().signal

export interface DurableTaskWorkerOptions {
  workerId: string
  concurrency: number
  leaseMs: number
  heartbeatMs: number
  maxAttempts: number
  retryBackoffMs: number
  queueClaimIdleMs: number
  queueBlockMs?: number
}

export interface DurableTaskWorkerErrorContext {
  stage: 'queue-read' | 'claim' | 'process' | 'heartbeat' | 'complete' | 'transition' | 'acknowledge'
  deliveryId?: string
  tenantId?: string
  taskId?: string
}

interface Heartbeat {
  currentLease(): TaskLease
  leaseLost(): boolean
  stop(): Promise<void>
}

function taskError(error: unknown): TaskError {
  if (error instanceof ParserError) return { code: error.code, message: error.message }
  if (error instanceof AppError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'DEVELOPMENT_PARSER_FAILED', message: error.message }
  return { code: 'DEVELOPMENT_PARSER_FAILED', message: 'Unknown development parser failure' }
}

function isTransient(error: unknown): boolean {
  return error instanceof AppError && (
    error.code === 'OBJECT_STORAGE_UNAVAILABLE' ||
    error.code === 'DATABASE_UNAVAILABLE'
  )
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Consumes duplicate-friendly queue notifications using a PostgreSQL lease as
 * the sole authority for execution and completion.
 */
export class DurableTaskWorker {
  private readonly inFlight = new Set<Promise<void>>()
  private readonly queueBlockMs: number

  constructor(
    private readonly repository: BidRepository,
    private readonly queue: TaskQueue,
    private readonly fileContentLoader: FileContentLoader,
    private readonly parser: DocumentParser,
    private readonly options: DurableTaskWorkerOptions,
    private readonly reportError: (
      error: unknown,
      context: DurableTaskWorkerErrorContext,
    ) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error('Worker concurrency must be a positive integer')
    }
    if (options.heartbeatMs >= options.leaseMs) {
      throw new Error('Task heartbeat interval must be shorter than the task lease')
    }
    this.queueBlockMs = options.queueBlockMs ?? 1_000
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const capacity = this.options.concurrency - this.inFlight.size
      if (capacity === 0) {
        await Promise.race(this.inFlight)
        continue
      }

      let deliveries: TaskQueueDelivery[] = []
      try {
        deliveries = await this.queue.reclaim(
          this.options.workerId,
          this.options.queueClaimIdleMs,
          capacity,
        )
        if (deliveries.length === 0 && !signal.aborted) {
          deliveries = await this.queue.read(this.options.workerId, {
            count: capacity,
            blockMs: this.queueBlockMs,
          })
        }
      } catch (error) {
        if (!signal.aborted) this.reportError(error, { stage: 'queue-read' })
        await abortableDelay(250, signal)
        continue
      }

      for (const delivery of deliveries.slice(0, capacity)) {
        if (signal.aborted) break
        this.schedule(delivery, signal)
      }
    }
    await Promise.allSettled([...this.inFlight])
  }

  /** One delivery hook used by deterministic tests and one-shot smoke checks. */
  async processDelivery(
    delivery: TaskQueueDelivery,
    shutdownSignal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<void> {
    if (shutdownSignal.aborted) return
    const context = {
      deliveryId: delivery.deliveryId,
      tenantId: delivery.tenantId,
      taskId: delivery.taskId,
    }
    const now = new Date()
    let claimed
    try {
      claimed = await this.repository.claimTask(
        delivery.tenantId,
        delivery.taskId,
        this.options.workerId,
        now.toISOString(),
        new Date(now.getTime() + this.options.leaseMs).toISOString(),
        this.options.maxAttempts,
      )
    } catch (error) {
      if (!shutdownSignal.aborted) this.reportError(error, { stage: 'claim', ...context })
      return
    }

    if (!claimed) {
      const task = await this.repository.findTask(delivery.tenantId, delivery.taskId)
      // Terminal and deleted tasks can never become executable. A queued task or
      // a running task with another valid lease must remain pending for reclaim.
      if (!task || task.status === 'succeeded' || task.status === 'failed') {
        if (!shutdownSignal.aborted) await this.acknowledge(delivery)
      }
      return
    }

    const deliveryController = new AbortController()
    const abortDelivery = (reason: unknown): void => {
      if (!deliveryController.signal.aborted) deliveryController.abort(reason)
    }
    const abortForShutdown = (): void => abortDelivery(shutdownSignal.reason)
    if (shutdownSignal.aborted) abortForShutdown()
    else shutdownSignal.addEventListener('abort', abortForShutdown, { once: true })

    const heartbeat = this.startHeartbeat(
      claimed.lease,
      context,
      () => abortDelivery(new Error('Task lease was lost')),
    )
    const intentionallyAborted = (): boolean =>
      shutdownSignal.aborted || deliveryController.signal.aborted || heartbeat.leaseLost()

    try {
      let requirements
      try {
        if (intentionallyAborted()) return
        const file = await this.fileContentLoader.loadForProcessing(
          delivery.tenantId,
          claimed.task.fileId,
        )
        if (intentionallyAborted()) return
        if (!file) {
          throw new AppError(
            500,
            'UPLOADED_FILE_NOT_FOUND',
            'Uploaded file disappeared before parsing',
            'Internal Server Error',
          )
        }
        const parsedAt = new Date().toISOString()
        requirements = await this.parser.parse(
          file,
          claimed.task,
          parsedAt,
          deliveryController.signal,
        )
      } catch (error) {
        await heartbeat.stop()
        if (intentionallyAborted()) return
        this.reportError(error, { stage: 'process', ...context })

        const failedAt = new Date()
        const normalized = taskError(error)
        try {
          if (isTransient(error) && claimed.task.attempt < this.options.maxAttempts) {
            const exponent = Math.max(0, Math.min(claimed.task.attempt - 1, 16))
            const retryAt = new Date(
              failedAt.getTime() + this.options.retryBackoffMs * 2 ** exponent,
            ).toISOString()
            if (intentionallyAborted()) return
            const requeued = await this.repository.requeueTask(
              heartbeat.currentLease(),
              normalized,
              failedAt.toISOString(),
              retryAt,
            )
            if (intentionallyAborted()) return
            if (requeued) {
              if (!intentionallyAborted()) await this.acknowledge(delivery)
            } else {
              this.reportError(new Error('Task retry transition was rejected'), {
                stage: 'transition',
                ...context,
              })
            }
            return
          }

          if (intentionallyAborted()) return
          const failed = await this.repository.failTask(
            heartbeat.currentLease(),
            normalized,
            failedAt.toISOString(),
            true,
          )
          if (intentionallyAborted()) return
          if (failed) {
            if (!intentionallyAborted()) await this.acknowledge(delivery)
          } else {
            this.reportError(new Error('Task failure transition was rejected'), {
              stage: 'transition',
              ...context,
            })
          }
        } catch (transitionError) {
          // The transaction outcome may be ambiguous. Leave the notification
          // pending so a later fenced claim can reconcile the database state.
          if (!intentionallyAborted()) {
            this.reportError(transitionError, { stage: 'transition', ...context })
          }
        }
        return
      }

      await heartbeat.stop()
      if (intentionallyAborted()) return
      const completedAt = new Date().toISOString()
      try {
        if (intentionallyAborted()) return
        const completed = await this.repository.completeTask(
          heartbeat.currentLease(),
          requirements,
          completedAt,
        )
        if (intentionallyAborted()) return
        if (completed) {
          if (!intentionallyAborted()) await this.acknowledge(delivery)
        } else {
          this.reportError(new Error('Task completion was rejected'), {
            stage: 'complete',
            ...context,
          })
        }
      } catch (error) {
        // Never turn an ambiguous completion into a failure. A committed result
        // may merely have lost its acknowledgement; redelivery will reconcile it.
        if (!intentionallyAborted()) this.reportError(error, { stage: 'complete', ...context })
      }
    } finally {
      shutdownSignal.removeEventListener('abort', abortForShutdown)
      await heartbeat.stop()
    }
  }

  private schedule(delivery: TaskQueueDelivery, shutdownSignal: AbortSignal): void {
    const work = this.processDelivery(delivery, shutdownSignal)
      .catch((error: unknown) => {
        this.reportError(error, {
          stage: 'process',
          deliveryId: delivery.deliveryId,
          tenantId: delivery.tenantId,
          taskId: delivery.taskId,
        })
      })
      .finally(() => this.inFlight.delete(work))
    this.inFlight.add(work)
  }

  private async acknowledge(delivery: TaskQueueDelivery): Promise<void> {
    try {
      await this.queue.acknowledge(delivery.deliveryId)
    } catch (error) {
      this.reportError(error, {
        stage: 'acknowledge',
        deliveryId: delivery.deliveryId,
        tenantId: delivery.tenantId,
        taskId: delivery.taskId,
      })
    }
  }

  private startHeartbeat(
    initialLease: TaskLease,
    context: Omit<DurableTaskWorkerErrorContext, 'stage'>,
    onLeaseLost: () => void,
  ): Heartbeat {
    let lease = initialLease
    let lost = false
    let stopped = false
    let timer: NodeJS.Timeout | null = null
    let pending: Promise<void> = Promise.resolve()

    const tick = (): void => {
      if (stopped || lost) return
      pending = (async () => {
        const now = new Date()
        try {
          const renewed = await this.repository.renewTaskLease(
            lease,
            now.toISOString(),
            new Date(now.getTime() + this.options.leaseMs).toISOString(),
          )
          if (!renewed) {
            lost = true
            onLeaseLost()
            this.reportError(new Error('Task lease renewal was rejected'), {
              stage: 'heartbeat',
              ...context,
            })
          } else lease = renewed
        } catch (error) {
          // Conservatively stop mutation/acknowledgement. The database token
          // fences this worker even if the lease is later claimed elsewhere.
          lost = true
          onLeaseLost()
          this.reportError(error, { stage: 'heartbeat', ...context })
        }
        if (!stopped && !lost) timer = setTimeout(tick, this.options.heartbeatMs)
      })()
    }
    timer = setTimeout(tick, this.options.heartbeatMs)

    return {
      currentLease: () => lease,
      leaseLost: () => lost,
      stop: async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        await pending
      },
    }
  }
}
