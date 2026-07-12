import { createHash } from 'node:crypto'
import type { DocumentParser } from '../../application/document-parser.js'
import type { ParseTask, Requirement, StoredProjectFile } from '../../domain/models.js'
import { DeterministicRequirementExtractor } from './deterministic-requirement-extractor.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  normalizeParserLimits,
  type ParserLimits,
} from './parser-types.js'
import { DocxDocumentExtractor } from './docx-document-extractor.js'
import { TextDocumentExtractor } from './text-document-extractor.js'

const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const KNOWN_FORMATS = new Map([
  ['.txt', 'text/plain'],
  ['.pdf', 'application/pdf'],
  ['.docx', DOCX_MEDIA_TYPE],
])

export class DigitalDocumentParser implements DocumentParser {
  private readonly limits: ParserLimits

  constructor(limits: ParserLimits = DEFAULT_PARSER_LIMITS) {
    this.limits = normalizeParserLimits(limits)
  }

  async parse(
    file: StoredProjectFile,
    task: ParseTask,
    now: string,
    signal: AbortSignal,
  ): Promise<Requirement[]> {
    signal.throwIfAborted()
    validateDirectContentMetadata(file, this.limits)
    const ownedContent = Uint8Array.from(file.content)
    validateDirectContentSnapshot(file, ownedContent)
    const fileSnapshot: StoredProjectFile = { ...file }
    const taskSnapshot: ParseTask = {
      ...task,
      error: task.error === null ? null : { ...task.error },
    }
    validateTaskFileLineage(fileSnapshot, taskSnapshot)

    const extension = extensionOf(fileSnapshot.fileName)
    const mediaType = mediaTypeEssence(fileSnapshot.mediaType)
    const expectedMediaType = KNOWN_FORMATS.get(extension)
    const knownMediaType = [...KNOWN_FORMATS.values()].includes(mediaType)
    if ((expectedMediaType !== undefined && expectedMediaType !== mediaType) ||
        (expectedMediaType === undefined && knownMediaType)) {
      throw new ParserError('FORMAT_MISMATCH', 'Source file extension and media type do not match')
    }
    if (expectedMediaType === undefined) {
      throw new ParserError('UNSUPPORTED_DOCUMENT_FORMAT', 'Source document format is not supported')
    }
    if (extension === '.docx' && hasPdfMagic(ownedContent)) {
      throw new ParserError('FORMAT_MISMATCH', 'DOCX metadata conflicts with a PDF signature')
    }
    const document = extension === '.pdf'
      ? await extractPdf(ownedContent, this.limits, signal)
      : extension === '.docx'
        ? await new DocxDocumentExtractor(this.limits).extract(ownedContent, signal)
        : new TextDocumentExtractor(this.limits).extract(ownedContent, signal)
    if (document.format !== extension.slice(1)) {
      throw new ParserError('FORMAT_MISMATCH', 'Document extractor returned a mismatched format')
    }
    return new DeterministicRequirementExtractor(this.limits).extract(
      document,
      fileSnapshot,
      taskSnapshot,
      now,
      signal,
    )
  }
}

async function extractPdf(content: Uint8Array, limits: ParserLimits, signal: AbortSignal) {
  const { PdfDocumentExtractor } = await import('./pdf-document-extractor.js')
  signal.throwIfAborted()
  return new PdfDocumentExtractor(limits).extractOwnedSnapshot(content, signal)
}

function hasPdfMagic(content: Uint8Array): boolean {
  return content.length >= 5 && content[0] === 0x25 && content[1] === 0x50 &&
    content[2] === 0x44 && content[3] === 0x46 && content[4] === 0x2d
}

function validateTaskFileLineage(file: StoredProjectFile, task: ParseTask): void {
  if (task.type !== 'document-parse-v1' || task.tenantId !== file.tenantId ||
      task.projectId !== file.projectId || task.fileId !== file.id) {
    throw new ParserError('FORMAT_MISMATCH', 'Parse task does not match the stored source file')
  }
}

function validateDirectContentMetadata(file: StoredProjectFile, limits: ParserLimits): void {
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 ||
      file.sizeBytes !== file.content.length) {
    throw new ParserError('FORMAT_MISMATCH', 'Declared source size does not match parser input bytes')
  }
  if (file.sizeBytes > limits.maxInputBytes || file.content.length > limits.maxInputBytes) {
    throw new ParserError(
      'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      'Document input exceeds the configured byte limit',
    )
  }
}

function validateDirectContentSnapshot(file: StoredProjectFile, content: Uint8Array): void {
  if (content.length !== file.sizeBytes) {
    throw new ParserError('FORMAT_MISMATCH', 'Parser input changed while taking an owned snapshot')
  }
  const actualSha256 = createHash('sha256').update(content).digest('hex')
  if (!/^[0-9a-f]{64}$/u.test(file.sha256) || file.sha256 !== actualSha256) {
    throw new ParserError('FORMAT_MISMATCH', 'Stored source digest does not match parser input bytes')
  }
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index < 0 ? '' : fileName.slice(index).toLowerCase()
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(';', 1)[0]!.trim().toLowerCase()
}
