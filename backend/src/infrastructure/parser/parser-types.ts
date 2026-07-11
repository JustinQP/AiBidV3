import type { ParseTask, Requirement, StoredProjectFile } from '../../domain/models.js'

export interface PdfBlockSource {
  kind: 'pdf'
  page: number
  bbox: { x: number; y: number; width: number; height: number }
}

export interface DocxBlockSource {
  kind: 'docx'
  paragraphId: string | null
  paragraphIndex: number
  tablePath: Array<{ tableIndex: number; rowIndex: number; cellIndex: number }>
  charStart: number
  charEnd: number
}

export interface TxtBlockSource {
  kind: 'txt'
  start: { line: number; column: number }
  end: { line: number; column: number }
}

export type DocumentBlockSource = PdfBlockSource | DocxBlockSource | TxtBlockSource

export interface DocumentSourceSpan {
  textStart: number
  textEnd: number
  source: DocumentBlockSource
}

export interface DocumentBlock {
  kind: 'heading' | 'paragraph' | 'table-cell'
  text: string
  textStart: number
  textEnd: number
  sectionPath: string[]
  sourceSpans: DocumentSourceSpan[]
}

export interface ParsedDocument {
  format: 'pdf' | 'docx' | 'txt'
  canonicalText: string
  blocks: DocumentBlock[]
}

export const PARSER_FAILURE_CODES = [
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
] as const

export type ParserFailureCode = typeof PARSER_FAILURE_CODES[number]

const parserFailureCodeSet: ReadonlySet<string> = new Set(PARSER_FAILURE_CODES)

export function isParserFailureCode(value: unknown): value is ParserFailureCode {
  return typeof value === 'string' && parserFailureCodeSet.has(value)
}

export interface ParserWorkerRequest {
  file: Omit<StoredProjectFile, 'content'> & { content: Uint8Array }
  task: ParseTask
  now: string
}

export type ParserWorkerReply =
  | { ok: true; requirements: Requirement[] }
  | { ok: false; error: { code: ParserFailureCode; message: string } }

export class ParserError extends Error {
  readonly retryable = false

  constructor(readonly code: ParserFailureCode, message: string) {
    super(message)
    this.name = 'ParserError'
  }
}

export interface ParserLimits {
  maxInputBytes: number
  maxCanonicalTextUnits: number
  maxRequirements: number
  maxDocumentBlocks: number
  maxSourceSpans: number
  maxPdfPages: number
  maxDocxEntries: number
  maxDocxExpandedBytes: number
  maxDocxSelectedXmlBytes: number
  maxDocxRawFilenameBytes: number
  minDocxCompressionRatioBytes: number
  maxDocxCompressionRatio: number
  maxXmlEntityDefinitions: number
  maxXmlEntitySize: number
  maxXmlEntityExpansionDepth: number
  maxXmlEntityExpansions: number
  maxXmlEntityExpandedUnits: number
  maxXmlNestingDepth: number
}

export const DEFAULT_PARSER_LIMITS: Readonly<ParserLimits> = Object.freeze({
  maxInputBytes: 25 * 1024 * 1024,
  maxCanonicalTextUnits: 10_000_000,
  maxRequirements: 2_000,
  maxDocumentBlocks: 100_000,
  maxSourceSpans: 250_000,
  maxPdfPages: 1_000,
  maxDocxEntries: 2_048,
  maxDocxExpandedBytes: 100 * 1024 * 1024,
  maxDocxSelectedXmlBytes: 32 * 1024 * 1024,
  maxDocxRawFilenameBytes: 4 * 1024,
  minDocxCompressionRatioBytes: 1024 * 1024,
  maxDocxCompressionRatio: 200,
  maxXmlEntityDefinitions: 32,
  maxXmlEntitySize: 128,
  maxXmlEntityExpansionDepth: 4,
  maxXmlEntityExpansions: 1_000,
  maxXmlEntityExpandedUnits: 100_000,
  maxXmlNestingDepth: 256,
})

export function normalizeParserLimits(limits: ParserLimits = DEFAULT_PARSER_LIMITS): ParserLimits {
  const normalized = {
    maxInputBytes: limits.maxInputBytes,
    maxCanonicalTextUnits: limits.maxCanonicalTextUnits,
    maxRequirements: limits.maxRequirements,
    maxDocumentBlocks: limits.maxDocumentBlocks,
    maxSourceSpans: limits.maxSourceSpans,
    maxPdfPages: limits.maxPdfPages,
    maxDocxEntries: limits.maxDocxEntries,
    maxDocxExpandedBytes: limits.maxDocxExpandedBytes,
    maxDocxSelectedXmlBytes: limits.maxDocxSelectedXmlBytes,
    maxDocxRawFilenameBytes: limits.maxDocxRawFilenameBytes,
    minDocxCompressionRatioBytes: limits.minDocxCompressionRatioBytes,
    maxDocxCompressionRatio: limits.maxDocxCompressionRatio,
    maxXmlEntityDefinitions: limits.maxXmlEntityDefinitions,
    maxXmlEntitySize: limits.maxXmlEntitySize,
    maxXmlEntityExpansionDepth: limits.maxXmlEntityExpansionDepth,
    maxXmlEntityExpansions: limits.maxXmlEntityExpansions,
    maxXmlEntityExpandedUnits: limits.maxXmlEntityExpandedUnits,
    maxXmlNestingDepth: limits.maxXmlNestingDepth,
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`)
    }
  }
  return normalized
}

export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

export function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 0
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  return { line, column }
}

export function advancePosition(
  start: { line: number; column: number },
  text: string,
): { line: number; column: number } {
  let line = start.line
  let column = start.column
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1
      column = 0
    } else {
      column += 1
    }
  }
  return { line, column }
}

export function validateParsedDocument(
  document: ParsedDocument,
  limits: ParserLimits = DEFAULT_PARSER_LIMITS,
  signal?: AbortSignal,
): ParsedDocument {
  signal?.throwIfAborted()
  const checkedLimits = normalizeParserLimits(limits)
  const documentRecord = plainRecord(document, 'Parsed document')
  const blocks = plainArray(documentRecord.blocks, 'Document blocks')
  if (blocks.length > checkedLimits.maxDocumentBlocks) {
    throw new ParserError(
      'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      'Document exceeds the configured block limit',
    )
  }
  assertDenseArray(blocks, 'Document blocks')

  const preparedBlocks: PreparedBlock[] = []
  let sourceSpanCount = 0
  for (const blockValue of blocks) {
    signal?.throwIfAborted()
    const block = plainRecord(blockValue, 'Document block')
    const sourceSpans = plainArray(block.sourceSpans, 'Document source spans')
    if (sourceSpans.length > checkedLimits.maxSourceSpans - sourceSpanCount) {
      throw new ParserError(
        'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
        'Document exceeds the configured source-span limit',
      )
    }
    sourceSpanCount += sourceSpans.length
    preparedBlocks.push({ block, sourceSpans })
  }
  for (const { sourceSpans } of preparedBlocks) {
    assertDenseArray(sourceSpans, 'Document source spans')
  }

  const format = documentRecord.format
  if (!isFormat(format)) invalidIr('Parsed document format is invalid')
  const canonicalText = documentRecord.canonicalText
  if (typeof canonicalText !== 'string') invalidIr('Canonical text must be a string')
  if (canonicalText.length > checkedLimits.maxCanonicalTextUnits) {
    throw new ParserError(
      'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
      'Canonical document text exceeds the configured UTF-16 limit',
    )
  }
  if (canonicalText !== canonicalize(canonicalText)) {
    invalidIr('Canonical text must use LF newlines and NFC normalization')
  }
  if (containsUnpairedSurrogate(canonicalText, signal)) {
    invalidIr('Canonical text contains an unpaired surrogate')
  }

  const txtCursor: TextPositionCursor | null = format === 'txt'
    ? { offset: 0, line: 1, column: 0 }
    : null
  const validatedBlocks: DocumentBlock[] = []
  let previousBlockEnd = -1
  for (const { block, sourceSpans } of preparedBlocks) {
    signal?.throwIfAborted()
    if (block.kind !== 'heading' && block.kind !== 'paragraph' && block.kind !== 'table-cell') {
      invalidIr('Document block kind is invalid')
    }
    validRange(canonicalText, block.textStart, block.textEnd, 'Document block')
    const textStart = block.textStart as number
    const textEnd = block.textEnd as number
    if (textStart < previousBlockEnd) {
      invalidIr('Document blocks must be ordered and non-overlapping')
    }
    if (typeof block.text !== 'string' || block.text.length === 0) {
      invalidIr('Document block text must be non-empty')
    }
    if (canonicalText.slice(textStart, textEnd) !== block.text) {
      invalidIr('Document block offsets must match canonical text')
    }
    const sectionPath = denseArray(block.sectionPath, 'Document block section path')
    for (const part of sectionPath) {
      if (typeof part !== 'string' || part.length === 0) {
        invalidIr('Document block section path must contain non-empty strings')
      }
    }

    let previousSpanEnd = textStart
    for (const spanValue of sourceSpans) {
      signal?.throwIfAborted()
      const span = plainRecord(spanValue, 'Document source span')
      validRange(canonicalText, span.textStart, span.textEnd, 'Document source span')
      const spanStart = span.textStart as number
      const spanEnd = span.textEnd as number
      if (spanStart < textStart || spanEnd > textEnd) {
        invalidIr('Document source span must be contained by its block')
      }
      if (spanStart < previousSpanEnd) {
        invalidIr('Document source spans must be ordered and non-overlapping')
      }
      const source = plainRecord(span.source, 'Document block source')
      validateBlockSource(format, canonicalText, spanStart, spanEnd, source, txtCursor, signal)
      previousSpanEnd = spanEnd
    }
    previousBlockEnd = textEnd
    validatedBlocks.push(block as unknown as DocumentBlock)
  }

  if (format === 'txt') validateTxtCanonicalCoverage(canonicalText, validatedBlocks, signal)
  else validateJoinedCanonicalText(canonicalText, validatedBlocks, signal)
  return document
}

interface PreparedBlock {
  block: Record<string, unknown>
  sourceSpans: unknown[]
}

interface TextPositionCursor {
  offset: number
  line: number
  column: number
}

function validateTxtCanonicalCoverage(
  canonicalText: string,
  blocks: DocumentBlock[],
  signal?: AbortSignal,
): void {
  let coveredUntil = 0
  for (const block of blocks) {
    if (block.text.includes('\n')) invalidIr('TXT blocks must contain exactly one physical line')
    if (block.textStart !== 0 && canonicalText[block.textStart - 1] !== '\n') {
      invalidIr('TXT blocks must start at a physical-line boundary')
    }
    if (block.textEnd !== canonicalText.length && canonicalText[block.textEnd] !== '\n') {
      invalidIr('TXT blocks must end at a physical-line boundary')
    }
    if (containsNonNewline(canonicalText, coveredUntil, block.textStart, signal)) {
      invalidIr('TXT blocks may omit only empty newline gaps, not hidden canonical characters')
    }
    coveredUntil = block.textEnd
  }
  if (containsNonNewline(
    canonicalText,
    coveredUntil,
    canonicalText.length,
    signal,
  )) {
    invalidIr('TXT blocks may omit only empty newline gaps, not hidden canonical characters')
  }
}

function containsNonNewline(
  text: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): boolean {
  for (let index = start; index < end; index += 1) {
    if (index % 16_384 === 0) signal?.throwIfAborted()
    if (text[index] !== '\n') return true
  }
  return false
}

function validateJoinedCanonicalText(
  canonicalText: string,
  blocks: DocumentBlock[],
  signal?: AbortSignal,
): void {
  const text: string[] = []
  for (const block of blocks) {
    signal?.throwIfAborted()
    text.push(block.text)
  }
  const rebuilt = text.join('\n')
  if (rebuilt !== canonicalText) {
    invalidIr('PDF and DOCX canonical text must be blocks joined by one LF')
  }
}

function validateBlockSource(
  format: ParsedDocument['format'],
  canonicalText: string,
  spanStart: number,
  spanEnd: number,
  source: Record<string, unknown>,
  txtCursor: TextPositionCursor | null,
  signal?: AbortSignal,
): void {
  if (source.kind !== format) {
    invalidIr('Document source kind must match the document format')
  }
  if (source.kind === 'txt') {
    const start = validPosition(source.start, 'TXT source start')
    const end = validPosition(source.end, 'TXT source end')
    if (txtCursor === null) invalidIr('TXT source requires a TXT position cursor')
    const expectedStart = advanceCursorTo(canonicalText, spanStart, txtCursor, signal)
    const expectedEnd = advanceCursorTo(canonicalText, spanEnd, txtCursor, signal)
    if (!samePosition(expectedStart, start) || !samePosition(expectedEnd, end)) {
      invalidIr('TXT source positions must match canonical text offsets and length')
    }
    return
  }
  if (source.kind === 'docx') {
    if (source.paragraphId !== null && (typeof source.paragraphId !== 'string' || source.paragraphId.length === 0)) {
      invalidIr('DOCX paragraph ID must be null or non-empty')
    }
    nonNegativeInteger(source.paragraphIndex, 'DOCX paragraph index')
    const tablePath = denseArray(source.tablePath, 'DOCX table path')
    for (const entryValue of tablePath) {
      const entry = plainRecord(entryValue, 'DOCX table path entry')
      nonNegativeInteger(entry.tableIndex, 'DOCX table index')
      nonNegativeInteger(entry.rowIndex, 'DOCX row index')
      nonNegativeInteger(entry.cellIndex, 'DOCX cell index')
    }
    nonNegativeInteger(source.charStart, 'DOCX character start')
    nonNegativeInteger(source.charEnd, 'DOCX character end')
    if ((source.charEnd as number) <= (source.charStart as number) ||
        (source.charEnd as number) - (source.charStart as number) !== spanEnd - spanStart) {
      invalidIr('DOCX source range length must match its canonical span length')
    }
    return
  }

  if (typeof source.page !== 'number' || !Number.isSafeInteger(source.page) || source.page < 1) {
    invalidIr('PDF page must be positive')
  }
  const bbox = plainRecord(source.bbox, 'PDF bounding box')
  const { x, y, width, height } = bbox
  if (![x, y, width, height].every((value) => Number.isFinite(value)) ||
      (x as number) < 0 || (y as number) < 0 || (width as number) <= 0 ||
      (height as number) <= 0 || (x as number) + (width as number) > 1 ||
      (y as number) + (height as number) > 1) {
    invalidIr('PDF bounding box must be finite, non-empty, and normalized')
  }
}

function advanceCursorTo(
  text: string,
  offset: number,
  cursor: TextPositionCursor,
  signal?: AbortSignal,
): { line: number; column: number } {
  if (offset < cursor.offset) invalidIr('TXT source spans must be globally ordered')
  for (let index = cursor.offset; index < offset; index += 1) {
    if (index % 16_384 === 0) signal?.throwIfAborted()
    if (text[index] === '\n') {
      cursor.line += 1
      cursor.column = 0
    } else {
      cursor.column += 1
    }
  }
  cursor.offset = offset
  return { line: cursor.line, column: cursor.column }
}

function validRange(text: string, start: unknown, end: unknown, label: string): void {
  if (typeof start !== 'number' || typeof end !== 'number' ||
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > text.length) {
    invalidIr(`${label} must be a non-empty in-bounds UTF-16 range`)
  }
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
    invalidIr(`${label} must not split a surrogate pair`)
  }
}

function validPosition(positionValue: unknown, label: string): { line: number; column: number } {
  const position = plainRecord(positionValue, label)
  if (typeof position.line !== 'number' || !Number.isSafeInteger(position.line) ||
      position.line < 1 || typeof position.column !== 'number' ||
      !Number.isSafeInteger(position.column) || position.column < 0) {
    invalidIr(`${label} is invalid`)
  }
  return { line: position.line as number, column: position.column as number }
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidIr(`${label} must be non-negative`)
  }
}

function samePosition(
  left: { line: number; column: number },
  right: { line: number; column: number },
): boolean {
  return left.line === right.line && left.column === right.column
}

function canonicalize(text: string): string {
  return text.replace(/\r\n?/gu, '\n').normalize('NFC')
}

function containsUnpairedSurrogate(text: string, signal?: AbortSignal): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (index % 16_384 === 0) signal?.throwIfAborted()
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function isFormat(value: unknown): value is ParsedDocument['format'] {
  return value === 'pdf' || value === 'docx' || value === 'txt'
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidIr(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalidIr(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidIr(`${label} must contain only string-keyed properties`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalidIr(`${label} must contain only enumerable own data properties`)
    }
  }
  return value as Record<string, unknown>
}

function denseArray(value: unknown, label: string): unknown[] {
  const array = plainArray(value, label)
  assertDenseArray(array, label)
  return array
}

function plainArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalidIr(`${label} must be a plain dense array`)
  }
  return value
}

function assertDenseArray(value: unknown[], label: string): void {
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    invalidIr(`${label} must be a dense array without extra properties`)
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidIr(`${label} must not contain sparse entries`)
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor)) {
      invalidIr(`${label} must contain only own data entries`)
    }
  }
}

function invalidIr(message: string): never {
  throw new ParserError('PARSER_WORKER_FAILED', message)
}
