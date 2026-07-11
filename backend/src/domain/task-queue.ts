export interface TaskQueuePayload {
  eventId: string
  tenantId: string
  taskId: string
}

/** A queue payload plus the broker-specific delivery id used for acknowledgement. */
export interface TaskQueueDelivery extends TaskQueuePayload {
  deliveryId: string
}

export interface TaskQueueReadOptions {
  count: number
  blockMs: number
}

/**
 * At-least-once task notification queue.
 *
 * The queue is deliberately not the source of truth. Consumers must claim the
 * corresponding database task lease before doing any work.
 */
export interface TaskQueue {
  connect(): Promise<void>
  publish(payload: TaskQueuePayload): Promise<string>
  read(consumerId: string, options: TaskQueueReadOptions): Promise<TaskQueueDelivery[]>
  reclaim(
    consumerId: string,
    minimumIdleMs: number,
    count: number,
  ): Promise<TaskQueueDelivery[]>
  acknowledge(deliveryId: string): Promise<void>
  close(): Promise<void>
}
