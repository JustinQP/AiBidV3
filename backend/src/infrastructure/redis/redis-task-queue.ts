import { createClient, type RedisClientType } from 'redis'
import type {
  TaskQueue,
  TaskQueueDelivery,
  TaskQueuePayload,
  TaskQueueReadOptions,
} from '../../domain/task-queue.js'

type RedisCommandReply = unknown

interface RedisCommandClient {
  connect(): Promise<unknown>
  close(): Promise<unknown>
  destroy(): void
  on(event: 'error', listener: (error: Error) => void): unknown
  sendCommand(command: string[]): Promise<RedisCommandReply>
  duplicate(): RedisCommandClient
  readonly isOpen: boolean
}

export interface RedisTaskQueueOptions {
  url: string
  streamKey: string
  consumerGroup: string
  onError?: (error: Error) => void
  client?: RedisCommandClient
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Redis task message is missing ${field}`)
  }
  return value
}

function parseFields(raw: unknown): TaskQueuePayload {
  if (!Array.isArray(raw)) throw new Error('Redis task message fields were malformed')
  const fields = new Map<string, string>()
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index]
    const value = raw[index + 1]
    if (typeof key === 'string' && typeof value === 'string') fields.set(key, value)
  }
  return {
    eventId: requireText(fields.get('eventId'), 'eventId'),
    tenantId: requireText(fields.get('tenantId'), 'tenantId'),
    taskId: requireText(fields.get('taskId'), 'taskId'),
  }
}

function parseEntries(raw: unknown): TaskQueueDelivery[] {
  if (!Array.isArray(raw)) return []
  const deliveries: TaskQueueDelivery[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const deliveryId = requireText(entry[0], 'deliveryId')
    deliveries.push({ deliveryId, ...parseFields(entry[1]) })
  }
  return deliveries
}

function parseReadGroupReply(raw: unknown): TaskQueueDelivery[] {
  const deliveries: TaskQueueDelivery[] = []
  if (raw instanceof Map) {
    for (const entries of raw.values()) deliveries.push(...parseEntries(entries))
    return deliveries
  }
  if (!Array.isArray(raw)) {
    if (typeof raw === 'object' && raw !== null) {
      for (const entries of Object.values(raw)) deliveries.push(...parseEntries(entries))
    }
    return deliveries
  }
  for (const stream of raw) {
    if (!Array.isArray(stream) || stream.length < 2) continue
    deliveries.push(...parseEntries(stream[1]))
  }
  return deliveries
}

function parseAutoClaimReply(raw: unknown): {
  nextCursor: string
  deliveries: TaskQueueDelivery[]
} {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('Redis XAUTOCLAIM reply was malformed')
  }
  return {
    nextCursor: requireText(raw[0], 'nextCursor'),
    deliveries: parseEntries(raw[1]),
  }
}

function isBusyGroup(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP')
}

/** Redis Streams implementation. Database task leases provide fencing. */
export class RedisTaskQueue implements TaskQueue {
  private readonly commandClient: RedisCommandClient
  private readonly readClient: RedisCommandClient
  private readonly reclaimCursors = new Map<string, string>()
  private connected = false

  constructor(private readonly options: RedisTaskQueueOptions) {
    if (options.url.trim().length === 0) throw new Error('Redis URL must not be empty')
    if (options.streamKey.trim().length === 0) throw new Error('Redis stream key must not be empty')
    if (options.consumerGroup.trim().length === 0) throw new Error('Redis consumer group must not be empty')

    // The URL may contain credentials and is therefore never included in errors or logs.
    const client = options.client ?? (createClient({ url: options.url }) as RedisClientType)
    this.commandClient = client
    this.readClient = client.duplicate()
    const report = options.onError ?? (() => undefined)
    this.commandClient.on('error', report)
    this.readClient.on('error', report)
  }

  async connect(): Promise<void> {
    if (this.connected) return
    try {
      await Promise.all([this.commandClient.connect(), this.readClient.connect()])
      await this.commandClient.sendCommand([
        'XGROUP',
        'CREATE',
        this.options.streamKey,
        this.options.consumerGroup,
        '0',
        'MKSTREAM',
      ])
    } catch (error) {
      if (isBusyGroup(error)) {
        this.connected = true
        return
      }
      await this.close()
      throw error
    }
    this.connected = true
  }

  async publish(payload: TaskQueuePayload): Promise<string> {
    const response = await this.commandClient.sendCommand([
      'XADD',
      this.options.streamKey,
      '*',
      'eventId',
      payload.eventId,
      'tenantId',
      payload.tenantId,
      'taskId',
      payload.taskId,
    ])
    return requireText(response, 'deliveryId')
  }

  async read(consumerId: string, options: TaskQueueReadOptions): Promise<TaskQueueDelivery[]> {
    const response = await this.readClient.sendCommand([
      'XREADGROUP',
      'GROUP',
      this.options.consumerGroup,
      consumerId,
      'COUNT',
      String(options.count),
      'BLOCK',
      String(options.blockMs),
      'STREAMS',
      this.options.streamKey,
      '>',
    ])
    return parseReadGroupReply(response)
  }

  async reclaim(
    consumerId: string,
    minimumIdleMs: number,
    count: number,
  ): Promise<TaskQueueDelivery[]> {
    const cursor = this.reclaimCursors.get(consumerId) ?? '0-0'
    const response = await this.commandClient.sendCommand([
      'XAUTOCLAIM',
      this.options.streamKey,
      this.options.consumerGroup,
      consumerId,
      String(minimumIdleMs),
      cursor,
      'COUNT',
      String(count),
    ])
    const parsed = parseAutoClaimReply(response)
    this.reclaimCursors.set(consumerId, parsed.nextCursor)
    return parsed.deliveries
  }

  async acknowledge(deliveryId: string): Promise<void> {
    await this.commandClient.sendCommand([
      'XACK',
      this.options.streamKey,
      this.options.consumerGroup,
      deliveryId,
    ])
    // Removing acknowledged entries keeps the notification stream bounded. The
    // durable audit/source-of-truth remains in PostgreSQL.
    await this.commandClient.sendCommand(['XDEL', this.options.streamKey, deliveryId])
  }

  /** Interrupts a blocking XREADGROUP while leaving publish/ack commands usable. */
  interruptReads(): void {
    try {
      this.readClient.destroy()
    } catch {
      // Closing an already-closed reader is intentionally idempotent.
    }
  }

  async close(): Promise<void> {
    this.connected = false
    this.reclaimCursors.clear()
    await Promise.allSettled(
      [this.readClient, this.commandClient].map(async (client) => {
        if (!client.isOpen) return
        try {
          await client.close()
        } catch {
          client.destroy()
        }
      }),
    )
  }
}
