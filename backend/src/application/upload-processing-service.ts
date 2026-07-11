import type { BidRepository } from '../domain/repository.js'
import { AppError } from '../lib/app-error.js'
import type { DevelopmentDocumentParser } from './development-document-parser.js'
import type { FileContentLoader } from './file-content-loader.js'

interface ProcessingErrorContext {
  tenantId: string
  taskId: string
  stage: 'process' | 'persist-failure' | 'lease-lost'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class UploadProcessingService {
  private readonly pending = new Set<Promise<void>>()
  private readonly enqueuedTaskKeys = new Set<string>()
  private readonly rerunRequested = new Set<string>()

  constructor(
    private readonly repository: BidRepository,
    private readonly fileContentLoader: FileContentLoader,
    private readonly parser: DevelopmentDocumentParser,
    private readonly delayMs: number,
    private readonly workerId: string,
    private readonly leaseMs: number,
    private readonly maxAttempts: number,
    private readonly reportError: (error: unknown, context: ProcessingErrorContext) => void = () => undefined,
  ) {}

  enqueue(tenantId: string, taskId: string): void {
    const taskKey = `${tenantId}:${taskId}`
    if (this.enqueuedTaskKeys.has(taskKey)) {
      this.rerunRequested.add(taskKey)
      return
    }
    this.enqueuedTaskKeys.add(taskKey)
    const work = this.process(tenantId, taskId)
      .catch((error: unknown) => {
        this.reportError(error, { tenantId, taskId, stage: 'process' })
      })
      .finally(() => {
        this.pending.delete(work)
        this.enqueuedTaskKeys.delete(taskKey)
        if (this.rerunRequested.delete(taskKey)) this.enqueue(tenantId, taskId)
      })
    this.pending.add(work)
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }
  }

  private async process(tenantId: string, taskId: string): Promise<void> {
    await delay(this.delayMs)
    const startedAt = new Date().toISOString()
    const leaseExpiresAt = new Date(Date.parse(startedAt) + this.leaseMs).toISOString()
    const claimed = await this.repository.claimTask(
      tenantId,
      taskId,
      this.workerId,
      startedAt,
      leaseExpiresAt,
      this.maxAttempts,
    )
    if (!claimed) return

    try {
      const file = await this.fileContentLoader.loadForProcessing(tenantId, claimed.task.fileId)
      if (!file) throw new Error('Uploaded file disappeared before development parsing')
      const completedAt = new Date().toISOString()
      const requirements = await this.parser.parse(file, claimed.task.id, completedAt)
      const completed = await this.repository.completeTask(claimed.lease, requirements, completedAt)
      if (!completed) {
        this.reportError(new Error('Development processor lost its task lease'), {
          tenantId,
          taskId,
          stage: 'lease-lost',
        })
      }
    } catch (error) {
      this.reportError(error, { tenantId, taskId, stage: 'process' })
      const code = error instanceof AppError ? error.code : 'DEVELOPMENT_PARSER_FAILED'
      const message = error instanceof Error ? error.message : 'Unknown development parser failure'
      try {
        const failed = await this.repository.failTask(
          claimed.lease,
          { code, message },
          new Date().toISOString(),
          true,
        )
        if (!failed) {
          this.reportError(new Error('Development processor lost its task lease'), {
            tenantId,
            taskId,
            stage: 'lease-lost',
          })
        }
      } catch (persistenceError) {
        this.reportError(persistenceError, { tenantId, taskId, stage: 'persist-failure' })
      }
    }
  }
}
