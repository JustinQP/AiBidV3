import { randomUUID } from 'node:crypto'
import type { TaskOutboxEvent } from '../domain/models.js'
import type { BidRepository } from '../domain/repository.js'
import type { TaskQueue } from '../domain/task-queue.js'

export interface OutboxRelayOptions {
  relayId: string
  pollIntervalMs: number
  leaseMs: number
  batchSize: number
  retryBackoffMs: number
  maxRetryBackoffMs?: number
}

export interface OutboxRelayErrorContext {
  stage: 'claim' | 'publish' | 'mark-published' | 'release'
  eventId?: string
  taskId?: string
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

/** Publishes the PostgreSQL outbox to the at-least-once notification queue. */
export class OutboxRelay {
  private readonly maxRetryBackoffMs: number
  private readonly leaseOwner: string

  constructor(
    private readonly repository: BidRepository,
    private readonly queue: TaskQueue,
    private readonly options: OutboxRelayOptions,
    private readonly reportError: (
      error: unknown,
      context: OutboxRelayErrorContext,
    ) => void = () => undefined,
  ) {
    this.maxRetryBackoffMs = options.maxRetryBackoffMs ?? 60_000
    this.leaseOwner = `${options.relayId}:${randomUUID()}`
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let processed = 0
      try {
        processed = await this.runOnce()
      } catch (error) {
        this.reportError(error, { stage: 'claim' })
      }
      if (!signal.aborted && processed === 0) {
        await abortableDelay(this.options.pollIntervalMs, signal)
      }
    }
  }

  async runOnce(now = new Date()): Promise<number> {
    const claimedAt = now.toISOString()
    const leaseExpiresAt = new Date(now.getTime() + this.options.leaseMs).toISOString()
    const events = await this.repository.claimOutboxEvents(
      this.leaseOwner,
      claimedAt,
      leaseExpiresAt,
      this.options.batchSize,
    )
    for (const event of events) await this.publishOne(event)
    return events.length
  }

  private async publishOne(event: TaskOutboxEvent): Promise<void> {
    try {
      await this.queue.publish({
        eventId: event.id,
        tenantId: event.tenantId,
        taskId: event.taskId,
      })
    } catch (error) {
      this.reportError(error, { stage: 'publish', eventId: event.id, taskId: event.taskId })
      const exponent = Math.max(0, Math.min(event.publishAttempts - 1, 16))
      const delayMs = Math.min(
        this.options.retryBackoffMs * 2 ** exponent,
        this.maxRetryBackoffMs,
      )
      try {
        const releasedAt = new Date()
        const released = await this.repository.releaseOutboxEvent(
          event.id,
          this.leaseOwner,
          {
            code: 'TASK_QUEUE_PUBLISH_FAILED',
            message: 'Task queue publish is temporarily unavailable',
          },
          releasedAt.toISOString(),
          new Date(releasedAt.getTime() + delayMs).toISOString(),
        )
        if (!released) {
          this.reportError(new Error('Outbox publish claim was lost before release'), {
            stage: 'release',
            eventId: event.id,
            taskId: event.taskId,
          })
        }
      } catch (releaseError) {
        this.reportError(releaseError, {
          stage: 'release',
          eventId: event.id,
          taskId: event.taskId,
        })
      }
      return
    }

    try {
      const marked = await this.repository.markOutboxEventPublished(
        event.id,
        this.leaseOwner,
        new Date().toISOString(),
      )
      if (!marked) {
        this.reportError(new Error('Outbox publish claim was lost before acknowledgement'), {
          stage: 'mark-published',
          eventId: event.id,
          taskId: event.taskId,
        })
      }
    } catch (error) {
      // A publish followed by a database failure intentionally results in a
      // duplicate notification. The worker's database lease makes it harmless.
      this.reportError(error, {
        stage: 'mark-published',
        eventId: event.id,
        taskId: event.taskId,
      })
    }
  }
}
