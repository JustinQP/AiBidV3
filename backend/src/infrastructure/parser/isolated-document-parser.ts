import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { DocumentParser } from '../../application/document-parser.js'
import type { ParseTask, Requirement, StoredProjectFile } from '../../domain/models.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  isParserFailureCode,
  type ParserWorkerRequest,
} from './parser-types.js'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_OLD_GENERATION_SIZE_MB = 256
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_WORKER_ERROR_MESSAGE_LENGTH = 4_096
const WORKER_FAILURE_MESSAGE = 'Parser worker failed'
const INVALID_REPLY_MESSAGE = 'Parser worker returned an invalid reply'

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker

export interface IsolatedDocumentParserOptions {
  timeoutMs?: number
  maxOldGenerationSizeMb?: number
  workerFactory?: WorkerFactory
}

type ParseOutcome =
  | { kind: 'resolve'; requirements: Requirement[] }
  | { kind: 'reject'; error: unknown }

export class IsolatedDocumentParser implements DocumentParser {
  private readonly timeoutMs: number
  private readonly maxOldGenerationSizeMb: number
  private readonly workerFactory: WorkerFactory

  constructor(options: IsolatedDocumentParserOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ??
      DEFAULT_MAX_OLD_GENERATION_SIZE_MB
    assertPositiveSafeInteger(this.timeoutMs, 'timeoutMs')
    if (this.timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
    }
    assertPositiveSafeInteger(this.maxOldGenerationSizeMb, 'maxOldGenerationSizeMb')
    this.workerFactory = options.workerFactory ?? ((url, workerOptions) =>
      new Worker(url, workerOptions))
  }

  async parse(
    file: StoredProjectFile,
    task: ParseTask,
    now: string,
    signal: AbortSignal,
  ): Promise<Requirement[]> {
    signal.throwIfAborted()
    if (file.content.byteLength > DEFAULT_PARSER_LIMITS.maxInputBytes) {
      throw new ParserError(
        'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
        'Document input exceeds the configured byte limit',
      )
    }

    let transferred: Uint8Array
    try {
      transferred = Uint8Array.from(file.content)
    } catch {
      throw workerFailure()
    }
    const transferredBuffer = transferred.buffer
    if (!(transferredBuffer instanceof ArrayBuffer)) throw workerFailure()
    const request: ParserWorkerRequest = {
      file: { ...file, content: transferred },
      task: {
        ...task,
        error: task.error === null ? null : { ...task.error },
      },
      now,
    }

    return new Promise<Requirement[]>((resolve, reject) => {
      let worker: Worker | undefined
      let timer: NodeJS.Timeout | undefined
      let workerListenersAttached = false
      let constructing = true
      let terminal = false
      let finalizing = false
      let pendingOutcome: ParseOutcome | undefined
      let pendingTermination = false
      let terminationPromise: Promise<number> | undefined

      const handleMessage = (value: unknown): void => {
        requestSettlement(parseReply(value), true)
      }
      const handleMessageError = (): void => {
        requestSettlement({ kind: 'reject', error: workerFailure() }, true)
      }
      const handleWorkerError = (error: Error): void => {
        requestSettlement({
          kind: 'reject',
          error: isOutOfMemoryError(error)
            ? new ParserError(
                'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
                'Parser worker exceeded the configured memory limit',
              )
            : workerFailure(),
        }, true)
      }
      const handleExit = (): void => {
        requestSettlement({ kind: 'reject', error: workerFailure() }, false)
      }
      const handleAbort = (): void => {
        requestSettlement({ kind: 'reject', error: abortReason(signal) }, true)
      }

      const clearParentListeners = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        signal.removeEventListener('abort', handleAbort)
      }

      const clearWorkerListeners = (): void => {
        if (!workerListenersAttached || worker === undefined) return
        worker.off('message', handleMessage)
        worker.off('messageerror', handleMessageError)
        worker.off('error', handleWorkerError)
        worker.off('exit', handleExit)
        workerListenersAttached = false
      }

      const terminateOnce = (): Promise<number> => {
        if (terminationPromise !== undefined) return terminationPromise
        if (worker === undefined) return Promise.resolve(0)
        try {
          terminationPromise = worker.terminate()
        } catch (error) {
          terminationPromise = Promise.reject(error)
        }
        return terminationPromise
      }

      const finalize = (outcome: ParseOutcome, terminate: boolean): void => {
        if (finalizing) return
        finalizing = true
        void (async () => {
          let terminationFailed = false
          try {
            if (terminate) await terminateOnce()
          } catch {
            terminationFailed = true
          } finally {
            clearWorkerListeners()
          }

          if (outcome.kind === 'resolve') {
            if (terminationFailed) reject(workerFailure())
            else resolve(outcome.requirements)
          } else {
            reject(outcome.error)
          }
        })()
      }

      function requestSettlement(outcome: ParseOutcome, terminate: boolean): void {
        if (terminal) return
        terminal = true
        pendingOutcome = outcome
        pendingTermination = terminate
        clearParentListeners()
        if (!constructing) finalize(outcome, terminate)
      }

      signal.addEventListener('abort', handleAbort, { once: true })
      timer = setTimeout(() => {
        requestSettlement({
          kind: 'reject',
          error: new ParserError(
            'DOCUMENT_PARSE_TIMEOUT',
            'Document parsing exceeded the configured timeout',
          ),
        }, true)
      }, this.timeoutMs)

      try {
        worker = this.workerFactory(
          new URL('./parser-worker.js', import.meta.url),
          {
            workerData: request,
            transferList: [transferredBuffer],
            resourceLimits: { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb },
          },
        )
      } catch {
        constructing = false
        if (terminal && pendingOutcome !== undefined) {
          finalize(pendingOutcome, pendingTermination)
        } else {
          requestSettlement({ kind: 'reject', error: workerFailure() }, false)
        }
        return
      }
      constructing = false

      if (terminal && pendingOutcome !== undefined) {
        finalize(pendingOutcome, pendingTermination)
        return
      }

      worker.on('message', handleMessage)
      worker.on('messageerror', handleMessageError)
      worker.on('error', handleWorkerError)
      worker.on('exit', handleExit)
      workerListenersAttached = true

      if (signal.aborted) handleAbort()
    })
  }
}

function parseReply(value: unknown): ParseOutcome {
  try {
    const reply = plainDataRecord(value)
    if (reply.ok === true) {
      return { kind: 'resolve', requirements: parseRequirements(reply.requirements) }
    }
    if (reply.ok === false) {
      const error = plainDataRecord(reply.error)
      if (!isParserFailureCode(error.code) || typeof error.message !== 'string' ||
          error.message.trim().length === 0 ||
          error.message.length > MAX_WORKER_ERROR_MESSAGE_LENGTH) {
        throw new Error('Invalid parser worker error')
      }
      return { kind: 'reject', error: new ParserError(error.code, error.message) }
    }
  } catch {
    return { kind: 'reject', error: invalidReply() }
  }
  return { kind: 'reject', error: invalidReply() }
}

function parseRequirements(value: unknown): Requirement[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > DEFAULT_PARSER_LIMITS.maxRequirements ||
      Reflect.ownKeys(value).length !== value.length + 1) {
    throw new Error('Invalid parser worker requirements')
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error('Sparse parser worker requirements')
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('Invalid parser worker requirement entry')
    }
    plainDataRecord(descriptor.value)
  }
  return value as Requirement[]
}

function plainDataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a plain data object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Expected a plain data object')
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('Expected string-keyed data')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error('Expected enumerable own data properties')
    }
  }
  return value as Record<string, unknown>
}

function isOutOfMemoryError(error: Error): boolean {
  try {
    return 'code' in error && (error as Error & { code?: unknown }).code ===
      'ERR_WORKER_OUT_OF_MEMORY'
  } catch {
    return false
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}

function workerFailure(): ParserError {
  return new ParserError('PARSER_WORKER_FAILED', WORKER_FAILURE_MESSAGE)
}

function invalidReply(): ParserError {
  return new ParserError('PARSER_WORKER_FAILED', INVALID_REPLY_MESSAGE)
}
