import type { BidRepository } from '../domain/repository.js'
import type { DevelopmentDocumentParser } from './development-document-parser.js'

interface ProcessingErrorContext {
  tenantId: string
  taskId: string
  stage: 'process' | 'persist-failure'
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
    private readonly parser: DevelopmentDocumentParser,
    private readonly delayMs: number,
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
      .catch(async (error: unknown) => {
        this.reportError(error, { tenantId, taskId, stage: 'process' })
        const message = error instanceof Error ? error.message : 'Unknown development parser failure'
        try {
          await this.repository.failTask(
            tenantId,
            taskId,
            { code: 'DEVELOPMENT_PARSER_FAILED', message },
            new Date().toISOString(),
          )
        } catch (persistenceError) {
          // Keep the durable task state recoverable on the next single-instance startup.
          this.reportError(persistenceError, { tenantId, taskId, stage: 'persist-failure' })
        }
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
    const task = await this.repository.markTaskRunning(tenantId, taskId, startedAt)
    if (!task) return
    const file = await this.repository.findStoredFile(tenantId, task.fileId)
    if (!file) throw new Error('Uploaded file disappeared before development parsing')
    const completedAt = new Date().toISOString()
    const requirements = await this.parser.parse(file, task.id, completedAt)
    await this.repository.completeTask(tenantId, task.id, requirements, completedAt)
  }
}
