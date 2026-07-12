import { describe, expect, it, vi } from 'vitest'
import {
  DocumentParserRouter,
  type DocumentParser,
} from '../src/application/document-parser.js'
import { DevelopmentDocumentParser } from '../src/application/development-document-parser.js'
import type { ParseTask, StoredProjectFile } from '../src/domain/models.js'

const NOW = '2026-07-11T00:00:00.000Z'

function task(type: ParseTask['type']): ParseTask {
  return {
    id: 'task-router',
    tenantId: 'tenant-router',
    projectId: 'project-router',
    fileId: 'file-router',
    type,
    status: 'running',
    progress: 0,
    attempt: 1,
    error: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    updatedAt: NOW,
  }
}

function file(overrides: Partial<StoredProjectFile> = {}): StoredProjectFile {
  return {
    id: 'file-router',
    tenantId: 'tenant-router',
    projectId: 'project-router',
    fileName: 'requirements.txt',
    mediaType: 'text/plain',
    sizeBytes: 4,
    sha256: 'test',
    parseStatus: 'parsing',
    createdAt: NOW,
    updatedAt: NOW,
    content: Buffer.from('test'),
    ...overrides,
  }
}

describe('DocumentParserRouter', () => {
  it('routes document-parse-v1 to the real parser with the complete task and signal', async () => {
    const developmentParser = {
      parse: vi.fn(async () => []),
    } as unknown as DevelopmentDocumentParser
    const realParser: DocumentParser = {
      parse: vi.fn(async () => []),
    }
    const router = new DocumentParserRouter(developmentParser, realParser)
    const sourceFile = file()
    const parseTask = task('document-parse-v1')
    const signal = new AbortController().signal

    await router.parse(sourceFile, parseTask, NOW, signal)

    expect(developmentParser.parse).not.toHaveBeenCalled()
    expect(realParser.parse).toHaveBeenCalledOnce()
    expect(realParser.parse).toHaveBeenCalledWith(sourceFile, parseTask, NOW, signal)
  })

  it('keeps historical development tasks, including DOC, on fixture parsing', async () => {
    const realParser: DocumentParser = {
      parse: vi.fn(async () => []),
    }
    const router = new DocumentParserRouter(new DevelopmentDocumentParser(), realParser)
    const historicalFile = file({
      fileName: 'historical.doc',
      mediaType: 'application/msword',
    })

    const requirements = await router.parse(
      historicalFile,
      task('development-document-parse'),
      NOW,
      new AbortController().signal,
    )

    expect(realParser.parse).not.toHaveBeenCalled()
    expect(requirements).toHaveLength(3)
    expect(requirements.every(({ extractionMethod }) =>
      extractionMethod === 'development-fixture')).toBe(true)
  })

  it('does not invoke either parser when the delivery is already aborted', async () => {
    const developmentParser = {
      parse: vi.fn(async () => []),
    } as unknown as DevelopmentDocumentParser
    const realParser: DocumentParser = {
      parse: vi.fn(async () => []),
    }
    const router = new DocumentParserRouter(developmentParser, realParser)
    const controller = new AbortController()
    const reason = new Error('worker shutdown')
    controller.abort(reason)

    await expect(router.parse(
      file(),
      task('document-parse-v1'),
      NOW,
      controller.signal,
    )).rejects.toBe(reason)
    expect(developmentParser.parse).not.toHaveBeenCalled()
    expect(realParser.parse).not.toHaveBeenCalled()
  })

  it('rejects an unknown runtime task type instead of guessing a parser', async () => {
    const developmentParser = {
      parse: vi.fn(async () => []),
    } as unknown as DevelopmentDocumentParser
    const realParser: DocumentParser = {
      parse: vi.fn(async () => []),
    }
    const router = new DocumentParserRouter(developmentParser, realParser)
    const invalidTask = {
      ...task('document-parse-v1'),
      type: 'unexpected-parser-type',
    } as unknown as ParseTask

    await expect(router.parse(
      file(),
      invalidTask,
      NOW,
      new AbortController().signal,
    )).rejects.toThrow('Unsupported document parser task type')
    expect(developmentParser.parse).not.toHaveBeenCalled()
    expect(realParser.parse).not.toHaveBeenCalled()
  })
})
