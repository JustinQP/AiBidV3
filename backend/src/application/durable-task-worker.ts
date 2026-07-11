import type { TaskError, TaskLease } from '../domain/models.js'
import type { BidRepository } from '../domain/repository.js'
import type { TaskQueue, TaskQueueDelivery } from '../domain/task-queue.js'
import { AppError } from '../lib/app-error.js'
import type { DevelopmentDocumentParser } from './development-document-parser.js'
import type { FileContentLoader } from './file-content-loader.js'

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
    private readonly parser: DevelopmentDocumentParser,
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

      for (const delivery of deliveries.slice(0, capacity)) this.schedule(delivery)
    }
    await Promise.allSettled([...this.inFlight])
  }

  /** One delivery hook used by deterministic tests and one-shot smoke checks. */
  async processDelivery(delivery: TaskQueueDelivery): Promise<void> {
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
      this.reportError(error, { stage: 'claim', ...context })
      return
    }

    if (!claimed) {
      const task = await this.repository.findTask(delivery.tenantId, delivery.taskId)
      // Terminal and deleted tasks can never become executable. A queued task or
      // a running task with another valid lease must remain pending for reclaim.
      if (!task || task.status === 'succeeded' || task.status === 'failed') {
        await this.acknowledge(delivery)
      }
      return
    }

    const heartbeat = this.startHeartbeat(claimed.lease, context)
    try {
      let requirements
      try {
        const file = await this.fileContentLoader.loadForProcessing(
          delivery.tenantId,
          claimed.task.fileId,
        )
        if (!file) {
          throw new AppError(
            500,
            'UPLOADED_FILE_NOT_FOUND',
            'Uploaded file disappeared before parsing',
            'Internal Server Error',
          )
        }
        const parsedAt = new Date().toISOString()
        requirements = await this.parser.parse(file, claimed.task.id, parsedAt)
      } catch (error) {
        this.reportError(error, { stage: 'process', ...context })
        await heartbeat.stop()
        if (heartbeat.leaseLost()) return

        const failedAt = new Date()
        const normalized = taskError(error)
        try {
          if (isTransient(error) && claimed.task.attempt < this.options.maxAttempts) {
            const exponent = Math.max(0, Math.min(claimed.task.attempt - 1, 16))
            const retryAt = new Date(
              failedAt.getTime() + this.options.retryBackoffMs * 2 ** exponent,
            ).toISOString()
            const requeued = await this.repository.requeueTask(
              heartbeat.currentLease(),
              normalized,
              failedAt.toISOString(),
              retryAt,
            )
            if (requeued) await this.acknowledge(delivery)
            else this.reportError(new Error('Task retry transition was rejected'), {
              stage: 'transition',
              ...context,
            })
            return
          }

          const failed = await this.repository.failTask(
            heartbeat.currentLease(),
            normalized,
            failedAt.toISOString(),
            true,
          )
          if (failed) await this.acknowledge(delivery)
          else this.reportError(new Error('Task failure transition was rejected'), {
            stage: 'transition',
            ...context,
          })
        } catch (transitionError) {
          // The transaction outcome may be ambiguous. Leave the notification
          // pending so a later fenced claim can reconcile the database state.
          this.reportError(transitionError, { stage: 'transition', ...context })
        }
        return
      }

      await heartbeat.stop()
      if (heartbeat.leaseLost()) return
      const completedAt = new Date().toISOString()
      try {
        const completed = await this.repository.completeTask(
          heartbeat.currentLease(),
          requirements,
          completedAt,
        )
        if (completed) await this.acknowledge(delivery)
        else this.reportError(new Error('Task completion was rejected'), {
          stage: 'complete',
          ...context,
        })
      } catch (error) {
        // Never turn an ambiguous completion into a failure. A committed result
        // may merely have lost its acknowledgement; redelivery will reconcile it.
        this.reportError(error, { stage: 'complete', ...context })
      }
    } finally {
      await heartbeat.stop()
    }
  }

  private schedule(delivery: TaskQueueDelivery): void {
    const work = this.processDelivery(delivery)
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
            this.reportError(new Error('Task lease renewal was rejected'), {
              stage: 'heartbeat',
              ...context,
            })
          } else lease = renewed
        } catch (error) {
          // Conservatively stop mutation/acknowledgement. The database token
          // fences this worker even if the lease is later claimed elsewhere.
          lost = true
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
