import { Buffer } from 'node:buffer'
import { parentPort, workerData } from 'node:worker_threads'
import type { ParseTask, StoredProjectFile } from '../../domain/models.js'
import { DigitalDocumentParser } from './digital-document-parser.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  isParserFailureCode,
  type ParserWorkerReply,
  type ParserWorkerRequest,
} from './parser-types.js'

const WORKER_FAILURE_MESSAGE = 'Parser worker failed'

if (parentPort === null) throw new Error('Parser worker must run in a worker thread')
const port = parentPort

async function run(): Promise<void> {
  let reply: ParserWorkerReply
  try {
    const request = parseRequest(workerData)
    const file: StoredProjectFile = {
      ...request.file,
      content: Buffer.from(request.file.content),
    }
    const requirements = await new DigitalDocumentParser().parse(
      file,
      request.task,
      request.now,
      new AbortController().signal,
    )
    reply = { ok: true, requirements }
  } catch (error) {
    reply = parserFailureReply(error)
  }
  port.postMessage(reply)
  port.close()
}

function parseRequest(value: unknown): ParserWorkerRequest {
  const request = plainDataRecord(value, 'Parser worker request')
  const file = plainDataRecord(request.file, 'Parser worker file')
  const task = plainDataRecord(request.task, 'Parser worker task')
  const content = file.content
  if (!(content instanceof Uint8Array) || !(content.buffer instanceof ArrayBuffer) ||
      content.byteOffset !== 0 ||
      content.byteLength !== content.buffer.byteLength) {
    throw new Error('Parser worker content must own one exact ArrayBuffer')
  }
  if (content.byteLength > DEFAULT_PARSER_LIMITS.maxInputBytes) {
    throw new ParserError(
      'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      'Document input exceeds the configured byte limit',
    )
  }
  if (typeof request.now !== 'string') throw new Error('Parser worker timestamp must be a string')
  return {
    file: file as unknown as ParserWorkerRequest['file'],
    task: task as unknown as ParseTask,
    now: request.now,
  }
}

function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error(`${label} must use string keys`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`${label} must contain enumerable own data properties`)
    }
  }
  return value as Record<string, unknown>
}

function parserFailureReply(error: unknown): ParserWorkerReply {
  if (error instanceof ParserError && isParserFailureCode(error.code)) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: { code: 'PARSER_WORKER_FAILED', message: WORKER_FAILURE_MESSAGE },
  }
}

void run().catch(() => {
  port.close()
})
