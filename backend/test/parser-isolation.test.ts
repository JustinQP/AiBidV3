import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import type { ParseTask, Requirement, StoredProjectFile } from '../src/domain/models.js'
import { IsolatedDocumentParser } from '../src/infrastructure/parser/isolated-document-parser.js'
import {
  DEFAULT_PARSER_LIMITS,
  PARSER_FAILURE_CODES,
  ParserError,
  isParserFailureCode,
} from '../src/infrastructure/parser/parser-types.js'

const FIXED_NOW = '2026-07-11T12:00:00.000Z'
const BACKEND_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE_URL = new URL('./fixtures/parser-worker-fixture.mjs', import.meta.url)
const execFileAsync = promisify(execFile)

class FakeWorker extends EventEmitter {
  terminateCalls = 0
  private terminationResolver: ((code: number) => void) | undefined

  constructor(private readonly deferredTermination = false) {
    super()
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1
    if (!this.deferredTermination) return Promise.resolve(1)
    return new Promise((resolve) => {
      this.terminationResolver = resolve
    })
  }

  finishTermination(code = 1): void {
    this.terminationResolver?.(code)
  }
}

class TrackedWorker extends Worker {
  terminateCalls = 0

  override terminate(): Promise<number> {
    this.terminateCalls += 1
    return super.terminate()
  }
}

describe('isolated parser protocol', () => {
  it('derives the complete stable-code allowlist from one runtime tuple', () => {
    expect(PARSER_FAILURE_CODES).toEqual([
      'FORMAT_MISMATCH',
      'UNSUPPORTED_DOCUMENT_FORMAT',
      'INVALID_PDF',
      'PDF_ENCRYPTED',
      'OCR_REQUIRED',
      'INVALID_DOCX',
      'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      'DOCUMENT_PARSE_TIMEOUT',
      'INVALID_TEXT_ENCODING',
      'PARSER_WORKER_FAILED',
    ])
    for (const code of PARSER_FAILURE_CODES) expect(isParserFailureCode(code)).toBe(true)
    for (const value of ['', 'UNKNOWN', null, {}, Symbol('code')]) {
      expect(isParserFailureCode(value)).toBe(false)
    }
  })

  it('uses the sibling .js URL, inherited execArgv, and the default old-generation limit', async () => {
    const worker = new FakeWorker()
    let capturedUrl: URL | undefined
    let capturedOptions: WorkerOptions | undefined
    const parser = new IsolatedDocumentParser({
      workerFactory: (url, options) => {
        capturedUrl = url
        capturedOptions = options
        queueMicrotask(() => worker.emit('message', successReply()))
        return asWorker(worker)
      },
    })

    await parser.parse(storedFile(), parseTask(), FIXED_NOW, new AbortController().signal)

    expect(capturedUrl?.pathname).toMatch(/\/parser-worker\.js$/u)
    expect(capturedOptions?.resourceLimits).toEqual({ maxOldGenerationSizeMb: 256 })
    expect(capturedOptions).not.toHaveProperty('execArgv')
    expect(worker.terminateCalls).toBe(1)
  })

  it('transfers one exact owned ArrayBuffer without mutating the pooled source bytes or digest', async () => {
    const backing = Buffer.allocUnsafe(64)
    const content = backing.subarray(17, 20)
    content.set([0x61, 0x62, 0x63])
    expect(content.byteOffset === 0 && content.buffer.byteLength === content.byteLength).toBe(false)
    const file = storedFile(content)
    const originalBytes = Buffer.from(content)
    const originalSha256 = file.sha256
    const worker = new FakeWorker()
    let capturedOptions: WorkerOptions | undefined
    const parser = new IsolatedDocumentParser({
      workerFactory: (_url, options) => {
        capturedOptions = options
        queueMicrotask(() => worker.emit('message', successReply()))
        return asWorker(worker)
      },
    })

    await parser.parse(file, parseTask(), FIXED_NOW, new AbortController().signal)

    const request = capturedOptions?.workerData as { file?: { content?: Uint8Array } } | undefined
    const transferred = request?.file?.content
    expect(transferred).toBeInstanceOf(Uint8Array)
    expect(transferred?.byteOffset).toBe(0)
    expect(transferred?.byteLength).toBe(content.byteLength)
    expect(transferred?.buffer.byteLength).toBe(content.byteLength)
    expect(capturedOptions?.transferList).toEqual([transferred?.buffer])
    expect(capturedOptions?.transferList).toHaveLength(1)
    expect(file.content).toEqual(originalBytes)
    expect(file.sha256).toBe(originalSha256)
    expect(createHash('sha256').update(file.content).digest('hex')).toBe(originalSha256)
  })

  it('rejects oversized input before copying bytes or constructing a worker', async () => {
    const factory = vi.fn(() => {
      throw new Error('Oversized input must not construct a worker')
    })
    const parser = new IsolatedDocumentParser({ workerFactory: factory })
    const oversized = storedFile(Buffer.alloc(DEFAULT_PARSER_LIMITS.maxInputBytes + 1))

    const error = await rejectionOf(parser.parse(
      oversized,
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    ))

    expect(error).toMatchObject({
      code: 'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      retryable: false,
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it('waits for termination before resolving a valid success and terminates once', async () => {
    const worker = new FakeWorker(true)
    const parser = parserWithFake(worker)
    let settled = false
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    ).then((requirements) => {
      settled = true
      return requirements
    })
    worker.emit('message', successReply())
    await Promise.resolve()

    expect(worker.terminateCalls).toBe(1)
    expect(settled).toBe(false)
    worker.finishTermination()
    await expect(parsing).resolves.toEqual([requirement()])
    expect(worker.terminateCalls).toBe(1)
  })

  it('rehydrates an allowlisted parser error locally without remote stack, cause, or extras', async () => {
    let tracked: TrackedWorker | undefined
    const parser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        tracked = new TrackedWorker(FIXTURE_URL, options)
        return tracked
      },
    })
    const error = await rejectionOf(parser.parse(
      storedFile(),
      parseTask('fixture-error'),
      FIXED_NOW,
      new AbortController().signal,
    ))

    expect(error).toBeInstanceOf(ParserError)
    expect(error).toMatchObject({
      code: 'INVALID_TEXT_ENCODING',
      message: 'TXT input must be strictly encoded as UTF-8',
      retryable: false,
    })
    expect(error).not.toHaveProperty('cause')
    expect((error as Error).stack).not.toContain('REMOTE_SECRET')
    expect(tracked?.terminateCalls).toBe(1)
  })

  it.each([
    ['null reply', null],
    ['non-plain reply', new Date()],
    ['unknown error code', { ok: false, error: { code: 'UNKNOWN', message: 'no' } }],
    ['empty error message', { ok: false, error: { code: 'INVALID_PDF', message: '  ' } }],
    ['oversized error message', { ok: false, error: { code: 'INVALID_PDF', message: 'x'.repeat(4_097) } }],
    ['non-array requirements', { ok: true, requirements: {} }],
    ['sparse requirements', { ok: true, requirements: sparseRequirements() }],
    ['primitive requirement', { ok: true, requirements: ['not an object'] }],
    ['non-plain requirement', { ok: true, requirements: [new Date()] }],
    ['too many requirements', {
      ok: true,
      requirements: Array.from(
        { length: DEFAULT_PARSER_LIMITS.maxRequirements + 1 },
        () => ({}),
      ),
    }],
  ])('maps malformed worker protocol data to a fixed local failure: %s', async (_label, reply) => {
    const worker = new FakeWorker()
    const parser = parserWithFake(worker)
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    )
    worker.emit('message', reply)

    const error = await rejectionOf(parsing)
    expect(error).toBeInstanceOf(ParserError)
    expect(error).toMatchObject({ code: 'PARSER_WORKER_FAILED', retryable: false })
    expect((error as Error).message).not.toContain('UNKNOWN')
    expect(worker.terminateCalls).toBe(1)
  })

  it('maps a worker error to a sanitized permanent failure', async () => {
    const worker = new FakeWorker()
    const parser = parserWithFake(worker)
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    )
    worker.emit('error', new Error('REMOTE_SECRET_WORKER_ERROR'))

    const error = await rejectionOf(parsing)
    expect(error).toMatchObject({ code: 'PARSER_WORKER_FAILED', retryable: false })
    expect((error as Error).message).not.toContain('REMOTE_SECRET')
    expect(worker.terminateCalls).toBe(1)
  })

  it('maps messageerror to a sanitized permanent failure', async () => {
    const worker = new FakeWorker()
    const parser = parserWithFake(worker)
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    )
    worker.emit('messageerror', new Error('REMOTE_SECRET_DESERIALIZATION'))

    const error = await rejectionOf(parsing)
    expect(error).toMatchObject({ code: 'PARSER_WORKER_FAILED', retryable: false })
    expect((error as Error).message).not.toContain('REMOTE_SECRET')
    expect(worker.terminateCalls).toBe(1)
  })

  it('maps ERR_WORKER_OUT_OF_MEMORY to the stable document resource-limit code', async () => {
    const worker = new FakeWorker()
    const parser = parserWithFake(worker)
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    )
    worker.emit('error', Object.assign(new Error('REMOTE_SECRET_OOM'), {
      code: 'ERR_WORKER_OUT_OF_MEMORY',
    }))

    const error = await rejectionOf(parsing)
    expect(error).toMatchObject({
      code: 'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      retryable: false,
    })
    expect((error as Error).message).not.toContain('REMOTE_SECRET')
    expect(worker.terminateCalls).toBe(1)
  })

  it('maps a reply-free worker exit to a sanitized permanent failure without hanging', async () => {
    let tracked: TrackedWorker | undefined
    const parser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        tracked = new TrackedWorker(FIXTURE_URL, options)
        return tracked
      },
    })

    const error = await rejectionOf(parser.parse(
      storedFile(),
      parseTask('fixture-exit'),
      FIXED_NOW,
      new AbortController().signal,
    ))

    expect(error).toMatchObject({ code: 'PARSER_WORKER_FAILED', retryable: false })
    expect(tracked?.terminateCalls).toBe(0)
  })

  it('maps an actual crashing worker to a sanitized permanent failure', async () => {
    const parser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => new TrackedWorker(FIXTURE_URL, options),
    })

    const error = await rejectionOf(parser.parse(
      storedFile(),
      parseTask('fixture-crash'),
      FIXED_NOW,
      new AbortController().signal,
    ))

    expect(error).toMatchObject({ code: 'PARSER_WORKER_FAILED', retryable: false })
    expect((error as Error).message).not.toContain('REMOTE_SECRET')
  })

  it('accepts a valid reply from an actual fixture worker', async () => {
    let tracked: TrackedWorker | undefined
    const parser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        tracked = new TrackedWorker(FIXTURE_URL, options)
        return tracked
      },
    })

    const requirements = await parser.parse(
      storedFile(),
      parseTask('fixture-success'),
      FIXED_NOW,
      new AbortController().signal,
    )

    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toMatchObject({
      id: 'fixture-requirement',
      extractionMethod: 'deterministic-rules-v1',
    })
    expect(tracked?.terminateCalls).toBe(1)
  })

  it('terminates an infinite-CPU worker exactly once before rejecting at the deadline', async () => {
    let tracked: TrackedWorker | undefined
    const parser = new IsolatedDocumentParser({
      timeoutMs: 100,
      workerFactory: (_url, options) => {
        tracked = new TrackedWorker(FIXTURE_URL, options)
        return tracked
      },
    })

    const error = await rejectionOf(parser.parse(
      storedFile(),
      parseTask('fixture-hang'),
      FIXED_NOW,
      new AbortController().signal,
    ))

    expect(error).toMatchObject({ code: 'DOCUMENT_PARSE_TIMEOUT', retryable: false })
    expect(tracked?.terminateCalls).toBe(1)
  })

  it('does not construct a worker for a pre-aborted call', async () => {
    const reason = new DOMException('lease lost', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const factory = vi.fn(() => asWorker(new FakeWorker()))
    const parser = new IsolatedDocumentParser({ workerFactory: factory })

    await expect(parser.parse(storedFile(), parseTask(), FIXED_NOW, controller.signal)).rejects.toBe(
      reason,
    )
    expect(factory).not.toHaveBeenCalled()
  })

  it('closes the construction-time abort race and waits for one termination', async () => {
    const reason = new DOMException('shutdown', 'AbortError')
    const controller = new AbortController()
    const worker = new FakeWorker(true)
    const parser = new IsolatedDocumentParser({
      workerFactory: () => {
        controller.abort(reason)
        return asWorker(worker)
      },
    })
    let settled = false
    const parsing = parser.parse(storedFile(), parseTask(), FIXED_NOW, controller.signal)
      .finally(() => {
        settled = true
      })
    await Promise.resolve()

    expect(worker.terminateCalls).toBe(1)
    expect(settled).toBe(false)
    worker.finishTermination()
    await expect(parsing).rejects.toBe(reason)
    expect(worker.terminateCalls).toBe(1)
  })

  it('terminates an in-flight infinite-CPU worker and rejects with the caller reason', async () => {
    const reason = new DOMException('lease lost', 'AbortError')
    const controller = new AbortController()
    let tracked: TrackedWorker | undefined
    const parser = new IsolatedDocumentParser({
      timeoutMs: 2_000,
      workerFactory: (_url, options) => {
        tracked = new TrackedWorker(FIXTURE_URL, options)
        return tracked
      },
    })
    const parsing = parser.parse(
      storedFile(),
      parseTask('fixture-hang'),
      FIXED_NOW,
      controller.signal,
    )
    if (tracked === undefined) throw new Error('Expected fixture worker construction')
    await once(tracked, 'online')
    controller.abort(reason)

    await expect(parsing).rejects.toBe(reason)
    expect(tracked.terminateCalls).toBe(1)
  })

  it('preserves an explicit null abort reason during in-flight termination', async () => {
    const controller = new AbortController()
    const worker = new FakeWorker()
    const parser = parserWithFake(worker)
    const parsing = parser.parse(storedFile(), parseTask(), FIXED_NOW, controller.signal)

    controller.abort(null)

    await expect(rejectionOf(parsing)).resolves.toBeNull()
    expect(worker.terminateCalls).toBe(1)
  })

  it('locks the first terminal reason when competing events arrive', async () => {
    const worker = new FakeWorker(true)
    const parser = parserWithFake(worker)
    const parsing = parser.parse(
      storedFile(),
      parseTask(),
      FIXED_NOW,
      new AbortController().signal,
    )
    worker.emit('message', successReply())
    worker.emit('message', null)
    worker.emit('messageerror', new Error('late event'))
    worker.emit('exit', 1)
    await Promise.resolve()

    expect(worker.terminateCalls).toBe(1)
    worker.finishTermination()
    await expect(parsing).resolves.toEqual([requirement()])
    expect(worker.terminateCalls).toBe(1)
  })

  it.each([
    ['timeoutMs', { timeoutMs: 0 }],
    ['timeoutMs', { timeoutMs: -1 }],
    ['timeoutMs', { timeoutMs: 1.5 }],
    ['timeoutMs', { timeoutMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['maxOldGenerationSizeMb', { maxOldGenerationSizeMb: 0 }],
    ['maxOldGenerationSizeMb', { maxOldGenerationSizeMb: -1 }],
    ['maxOldGenerationSizeMb', { maxOldGenerationSizeMb: 1.5 }],
    ['maxOldGenerationSizeMb', { maxOldGenerationSizeMb: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)('rejects an invalid positive-safe-integer option: %s %j', (name, options) => {
    expect(() => new IsolatedDocumentParser(options)).toThrow(`${name} must be a positive safe integer`)
  })

  it('rejects a timeout beyond the maximum supported by Node timers', () => {
    expect(() => new IsolatedDocumentParser({ timeoutMs: 2_147_483_648 })).toThrow(
      'timeoutMs must not exceed 2147483647',
    )
  })
})

describe('real source worker execution', () => {
  it('parses a real TXT through node --import tsx and the default sibling .js worker URL', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/parser-worker-fixture.mjs', 'source-proof'],
      { cwd: BACKEND_ROOT, timeout: 10_000 },
    )

    expect(stderr).toBe('')
    const proof = JSON.parse(stdout) as {
      execArgv: string[]
      count: number
      requirement: {
        extractionMethod: string
        confidence: number
        title: string
        sourceLocator: { kind: string; quote: string; sectionPath: string[] }
      }
    }
    expect(proof.execArgv).toEqual(['--import', 'tsx'])
    expect(proof.count).toBe(1)
    expect(proof.requirement).toMatchObject({
      extractionMethod: 'deterministic-rules-v1',
      confidence: 0.95,
      title: '投标人必须提交完整的技术实施方案。',
      sourceLocator: {
        kind: 'txt',
        quote: '投标人必须提交完整的技术实施方案。',
        sectionPath: ['技术要求'],
      },
    })
  })

  it('rejects a non-exact transferred view inside the real parser worker with a plain fixed reply', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/parser-worker-fixture.mjs', 'invalid-protocol-proof'],
      { cwd: BACKEND_ROOT, timeout: 10_000 },
    )

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: { code: 'PARSER_WORKER_FAILED', message: 'Parser worker failed' },
    })
  })

  it('rejects an exact SharedArrayBuffer view inside the real parser worker', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/parser-worker-fixture.mjs', 'shared-buffer-protocol-proof'],
      { cwd: BACKEND_ROOT, timeout: 10_000 },
    )

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: { code: 'PARSER_WORKER_FAILED', message: 'Parser worker failed' },
    })
  })
})

function parserWithFake(worker: FakeWorker): IsolatedDocumentParser {
  return new IsolatedDocumentParser({ workerFactory: () => asWorker(worker) })
}

function asWorker(worker: FakeWorker): Worker {
  return worker as unknown as Worker
}

function successReply(): { ok: true; requirements: Requirement[] } {
  return { ok: true, requirements: [requirement()] }
}

function sparseRequirements(): Requirement[] {
  const requirements = new Array<Requirement>(1)
  return requirements
}

function storedFile(content = Buffer.from('Supplier must comply.', 'utf8')): StoredProjectFile {
  return {
    id: 'file-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileName: 'requirements.txt',
    mediaType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'parsing',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content,
  }
}

function parseTask(id = 'task-1'): ParseTask {
  return {
    id,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileId: 'file-1',
    type: 'document-parse-v1',
    status: 'running',
    progress: 25,
    attempt: 1,
    error: null,
    createdAt: FIXED_NOW,
    startedAt: FIXED_NOW,
    finishedAt: null,
    updatedAt: FIXED_NOW,
  }
}

function requirement(): Requirement {
  return {
    id: 'requirement-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileId: 'file-1',
    taskId: 'task-1',
    code: 'REQ-0001',
    title: 'Supplier must comply.',
    description: 'Supplier must comply.',
    category: 'technical',
    priority: 'mandatory',
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: 'deterministic-rules-v1',
    confidence: 0.95,
    sourceLocator: {
      kind: 'txt',
      version: 1,
      sourceFileId: 'file-1',
      sourceFileName: 'requirements.txt',
      sourceRevision: 1,
      sourceSha256: 'a'.repeat(64),
      quote: 'Supplier must comply.',
      quoteSha256: 'b'.repeat(64),
      textStart: 0,
      textEnd: 21,
      sectionPath: [],
      parserVersion: 'deterministic-rules-v1',
      start: { line: 1, column: 0 },
      end: { line: 1, column: 21 },
    },
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise rejection')
}
