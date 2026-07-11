import { createHash } from 'node:crypto'

export type ExtractionMethod = 'development-fixture' | 'deterministic-rules-v1'

export interface DevelopmentSourceLocator {
  kind: 'development-fixture'
  fileId: string
  fileName: string
  pageNumber: null
  sectionPath: string[]
  paragraphIndex: null
  quote: string
}

export interface RealLocatorBaseV1 {
  version: 1
  sourceFileId: string
  sourceFileName: string
  sourceRevision: 1
  sourceSha256: string
  quote: string
  quoteSha256: string
  textStart: number
  textEnd: number
  sectionPath: string[]
  parserVersion: string
}

export interface PdfBoundingBoxV1 {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfRegionV1 {
  page: number
  bbox: PdfBoundingBoxV1
}

export interface PdfSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'pdf'
  regions: PdfRegionV1[]
}

export interface DocxTablePathEntryV1 {
  tableIndex: number
  rowIndex: number
  cellIndex: number
}

export interface DocxTextRangeV1 {
  paragraphId: string | null
  paragraphIndex: number
  tablePath: DocxTablePathEntryV1[]
  charStart: number
  charEnd: number
}

export interface DocxSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'docx'
  ranges: DocxTextRangeV1[]
}

export interface TxtPositionV1 {
  line: number
  column: number
}

export interface TxtSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'txt'
  start: TxtPositionV1
  end: TxtPositionV1
}

export type RealSourceLocatorV1 =
  | PdfSourceLocatorV1
  | DocxSourceLocatorV1
  | TxtSourceLocatorV1

export type SourceLocator = DevelopmentSourceLocator | RealSourceLocatorV1

export type ParseTaskTypeForEvidence = 'development-document-parse' | 'document-parse-v1'

declare const canonicalSourceTextIndexType: unique symbol

export interface CanonicalSourceTextIndex {
  readonly [canonicalSourceTextIndexType]: true
}

export interface SourceLocatorValidationContext {
  canonicalText?: string
  canonicalTextIndex?: CanonicalSourceTextIndex
  expectedSourceFileId?: string
  expectedSourceFileName?: string
  expectedSourceSha256?: string
  expectedSourceMediaType?: string
  expectedTaskType?: unknown
}

export interface RequirementEvidenceInput {
  extractionMethod: unknown
  confidence: unknown
  sourceLocator: unknown
}

export interface RequirementEvidence {
  extractionMethod: ExtractionMethod
  confidence: number | null
  sourceLocator: SourceLocator
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_CONFIDENCE_DECIMALS = 4
const DEVELOPMENT_LOCATOR_KEYS = [
  'kind',
  'fileId',
  'fileName',
  'pageNumber',
  'sectionPath',
  'paragraphIndex',
  'quote',
] as const
const REAL_BASE_KEYS = [
  'version',
  'sourceFileId',
  'sourceFileName',
  'sourceRevision',
  'sourceSha256',
  'quote',
  'quoteSha256',
  'textStart',
  'textEnd',
  'sectionPath',
  'parserVersion',
] as const
const PDF_LOCATOR_KEYS = ['kind', ...REAL_BASE_KEYS, 'regions'] as const
const DOCX_LOCATOR_KEYS = ['kind', ...REAL_BASE_KEYS, 'ranges'] as const
const TXT_LOCATOR_KEYS = ['kind', ...REAL_BASE_KEYS, 'start', 'end'] as const
const PDF_REGION_KEYS = ['page', 'bbox'] as const
const PDF_BOUNDING_BOX_KEYS = ['x', 'y', 'width', 'height'] as const
const DOCX_RANGE_KEYS = [
  'paragraphId',
  'paragraphIndex',
  'tablePath',
  'charStart',
  'charEnd',
] as const
const DOCX_TABLE_PATH_KEYS = ['tableIndex', 'rowIndex', 'cellIndex'] as const
const TXT_POSITION_KEYS = ['line', 'column'] as const

interface CanonicalSourceTextIndexData {
  canonicalText: string
  lineStarts: Uint32Array
}

const canonicalSourceTextIndexBrand = new WeakSet<object>()
const canonicalSourceTextIndexData = new WeakMap<object, CanonicalSourceTextIndexData>()

export function canonicalizeSourceText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').normalize('NFC')
}

export function createCanonicalSourceTextIndex(
  canonicalText: string,
  signal?: AbortSignal,
): CanonicalSourceTextIndex {
  signal?.throwIfAborted()
  if (typeof canonicalText !== 'string' || canonicalText !== canonicalizeSourceText(canonicalText)) {
    throw new Error('Canonical text index input must already use LF newlines and NFC normalization')
  }
  const lineStarts = buildLineStarts(canonicalText, signal)
  const index = Object.freeze({}) as CanonicalSourceTextIndex
  canonicalSourceTextIndexBrand.add(index)
  canonicalSourceTextIndexData.set(index, {
    canonicalText,
    lineStarts,
  })
  return index
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function validateSourceLocator(
  value: unknown,
  context: SourceLocatorValidationContext = {},
): SourceLocator {
  const locator = record(value, 'source locator')
  const kind = locator.kind
  if (kind === 'development-fixture') {
    exactKeys(locator, DEVELOPMENT_LOCATOR_KEYS, 'development source locator')
    return validateDevelopmentLocator(locator, context)
  }
  if (kind !== 'pdf' && kind !== 'docx' && kind !== 'txt') {
    throw new Error('Source locator kind is not supported')
  }

  const expectedKeys = {
    pdf: PDF_LOCATOR_KEYS,
    docx: DOCX_LOCATOR_KEYS,
    txt: TXT_LOCATOR_KEYS,
  }[kind]
  exactKeys(locator, expectedKeys, `${kind.toUpperCase()} source locator`)
  const canonicalTextIndex = resolveCanonicalSourceTextIndex(context)
  const base = validateRealBase(locator, context, canonicalTextIndex)
  validateFileKind(kind, base.sourceFileName, context.expectedSourceMediaType)

  if (kind === 'pdf') {
    return {
      ...base,
      kind,
      regions: validatePdfRegions(locator.regions),
    }
  }
  if (kind === 'docx') {
    return {
      ...base,
      kind,
      ranges: validateDocxRanges(locator.ranges),
    }
  }

  const start = validateTxtPosition(locator.start, 'TXT start')
  const end = validateTxtPosition(locator.end, 'TXT end')
  if (start.line > end.line || (start.line === end.line && start.column >= end.column)) {
    throw new Error('TXT source range must be non-empty and ordered')
  }
  const quoteEnd = advancePosition(start, base.quote)
  if (end.line !== quoteEnd.line || end.column !== quoteEnd.column) {
    throw new Error('TXT source range does not match the UTF-16 quote length')
  }
  if (canonicalTextIndex !== null) {
    const expectedStart = positionAt(canonicalTextIndex.lineStarts, base.textStart)
    const expectedEnd = positionAt(canonicalTextIndex.lineStarts, base.textEnd)
    if (
      start.line !== expectedStart.line ||
      start.column !== expectedStart.column ||
      end.line !== expectedEnd.line ||
      end.column !== expectedEnd.column
    ) {
      throw new Error('TXT line and column positions do not match canonical text offsets')
    }
  }
  return {
    ...base,
    kind,
    start,
    end,
  }
}

export function validateRequirementEvidence(
  value: RequirementEvidenceInput,
  context: SourceLocatorValidationContext = {},
): RequirementEvidence {
  const sourceLocator = validateSourceLocator(value.sourceLocator, context)
  const hasExpectedTaskType = Object.hasOwn(context, 'expectedTaskType')
  if (value.extractionMethod === 'development-fixture') {
    if (
      sourceLocator.kind !== 'development-fixture' ||
      value.confidence !== null ||
      (hasExpectedTaskType && context.expectedTaskType !== 'development-document-parse')
    ) {
      throw new Error('Development fixture evidence is inconsistent')
    }
    return {
      extractionMethod: value.extractionMethod,
      confidence: null,
      sourceLocator,
    }
  }
  if (value.extractionMethod !== 'deterministic-rules-v1') {
    throw new Error('Requirement extraction method is not supported')
  }
  if (
    sourceLocator.kind === 'development-fixture' ||
    (hasExpectedTaskType && context.expectedTaskType !== 'document-parse-v1')
  ) {
    throw new Error('Real parser evidence is inconsistent')
  }
  const confidence = validConfidence(value.confidence)
  return {
    extractionMethod: value.extractionMethod,
    confidence,
    sourceLocator,
  }
}

function validateDevelopmentLocator(
  locator: Record<string, unknown>,
  context: SourceLocatorValidationContext,
): DevelopmentSourceLocator {
  const fileId = nonEmptyString(locator.fileId, 'fixture file ID')
  const fileName = nonEmptyString(locator.fileName, 'fixture file name')
  if (locator.pageNumber !== null || locator.paragraphIndex !== null) {
    throw new Error('Development fixture positions must be null')
  }
  const sectionPath = stringArray(locator.sectionPath, 'fixture section path')
  const quote = nonEmptyString(locator.quote, 'fixture quote')
  matchesExpected(fileId, context.expectedSourceFileId, 'source file ID')
  matchesExpected(fileName, context.expectedSourceFileName, 'source file name')
  return {
    kind: 'development-fixture',
    fileId,
    fileName,
    pageNumber: null,
    sectionPath,
    paragraphIndex: null,
    quote,
  }
}

function validateRealBase(
  locator: Record<string, unknown>,
  context: SourceLocatorValidationContext,
  canonicalTextIndex: CanonicalSourceTextIndexData | null,
): RealLocatorBaseV1 {
  if (locator.version !== 1 || locator.sourceRevision !== 1) {
    throw new Error('Real source locator version is not supported')
  }
  const sourceFileId = nonEmptyString(locator.sourceFileId, 'source file ID')
  const sourceFileName = nonEmptyString(locator.sourceFileName, 'source file name')
  const sourceSha256 = sha256(locator.sourceSha256, 'source SHA-256')
  const quote = nonEmptyString(locator.quote, 'source quote')
  if (quote !== canonicalizeSourceText(quote)) {
    throw new Error('Source quote must already be canonical text')
  }
  const quoteSha256 = sha256(locator.quoteSha256, 'quote SHA-256')
  if (quoteSha256 !== sha256Hex(quote)) {
    throw new Error('Source quote SHA-256 does not match the quote')
  }
  const textStart = nonNegativeInteger(locator.textStart, 'source text start')
  const textEnd = nonNegativeInteger(locator.textEnd, 'source text end')
  if (textEnd <= textStart || textEnd - textStart !== quote.length) {
    throw new Error('Source text offsets must be a non-empty UTF-16 half-open quote range')
  }
  if (containsUnpairedSurrogate(quote)) {
    throw new Error('Source quote contains an unpaired surrogate')
  }
  const sectionPath = stringArray(locator.sectionPath, 'source section path')
  const parserVersion = nonEmptyString(locator.parserVersion, 'parser version')

  matchesExpected(sourceFileId, context.expectedSourceFileId, 'source file ID')
  matchesExpected(sourceFileName, context.expectedSourceFileName, 'source file name')
  matchesExpected(sourceSha256, context.expectedSourceSha256, 'source SHA-256')

  if (canonicalTextIndex !== null) {
    const { canonicalText } = canonicalTextIndex
    if (textEnd > canonicalText.length || canonicalText.slice(textStart, textEnd) !== quote) {
      throw new Error('Source quote does not match canonical text at its offsets')
    }
    if (
      splitsSurrogatePair(canonicalText, textStart) ||
      splitsSurrogatePair(canonicalText, textEnd)
    ) {
      throw new Error('Source text offsets must not split a surrogate pair')
    }
  }
  return {
    version: 1,
    sourceFileId,
    sourceFileName,
    sourceRevision: 1,
    sourceSha256,
    quote,
    quoteSha256,
    textStart,
    textEnd,
    sectionPath,
    parserVersion,
  }
}

function validatePdfRegions(value: unknown): PdfRegionV1[] {
  const candidates = denseArray(value, 'PDF source regions')
  if (candidates.length === 0) {
    throw new Error('PDF source regions must not be empty')
  }
  return candidates.map((candidate) => {
    const region = record(candidate, 'PDF source region')
    exactKeys(region, PDF_REGION_KEYS, 'PDF source region')
    const page = positiveInteger(region.page, 'PDF page')
    const bbox = record(region.bbox, 'PDF bounding box')
    exactKeys(bbox, PDF_BOUNDING_BOX_KEYS, 'PDF bounding box')
    const x = normalizedNumber(bbox.x, 'PDF bounding box x', true)
    const y = normalizedNumber(bbox.y, 'PDF bounding box y', true)
    const width = normalizedNumber(bbox.width, 'PDF bounding box width', false)
    const height = normalizedNumber(bbox.height, 'PDF bounding box height', false)
    if (x + width > 1 || y + height > 1) {
      throw new Error('PDF bounding box must remain within normalized page bounds')
    }
    return { page, bbox: { x, y, width, height } }
  })
}

function validateDocxRanges(value: unknown): DocxTextRangeV1[] {
  const candidates = denseArray(value, 'DOCX source ranges')
  if (candidates.length === 0) {
    throw new Error('DOCX source ranges must not be empty')
  }
  return candidates.map((candidate) => {
    const range = record(candidate, 'DOCX source range')
    exactKeys(range, DOCX_RANGE_KEYS, 'DOCX source range')
    const paragraphId =
      range.paragraphId === null
        ? null
        : nonEmptyString(range.paragraphId, 'DOCX paragraph ID')
    const paragraphIndex = nonNegativeInteger(range.paragraphIndex, 'DOCX paragraph index')
    const tablePath = denseArray(range.tablePath, 'DOCX table path').map((pathCandidate) => {
      const path = record(pathCandidate, 'DOCX table path entry')
      exactKeys(path, DOCX_TABLE_PATH_KEYS, 'DOCX table path entry')
      return {
        tableIndex: nonNegativeInteger(path.tableIndex, 'DOCX table index'),
        rowIndex: nonNegativeInteger(path.rowIndex, 'DOCX row index'),
        cellIndex: nonNegativeInteger(path.cellIndex, 'DOCX cell index'),
      }
    })
    const charStart = nonNegativeInteger(range.charStart, 'DOCX character start')
    const charEnd = nonNegativeInteger(range.charEnd, 'DOCX character end')
    if (charEnd <= charStart) throw new Error('DOCX character range must not be empty')
    return { paragraphId, paragraphIndex, tablePath, charStart, charEnd }
  })
}

function validateTxtPosition(value: unknown, label: string): TxtPositionV1 {
  const position = record(value, label)
  exactKeys(position, TXT_POSITION_KEYS, label)
  return {
    line: positiveInteger(position.line, `${label} line`),
    column: nonNegativeInteger(position.column, `${label} column`),
  }
}

function validateFileKind(
  kind: RealSourceLocatorV1['kind'],
  fileName: string,
  expectedMediaType: string | undefined,
): void {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  const expected = {
    pdf: { extension: '.pdf', mediaType: 'application/pdf' },
    docx: { extension: '.docx', mediaType: DOCX_MEDIA_TYPE },
    txt: { extension: '.txt', mediaType: 'text/plain' },
  }[kind]
  if (extension !== expected.extension) {
    throw new Error('Source locator kind does not match the source file extension')
  }
  const normalizedMediaType = expectedMediaType?.split(';', 1)[0]?.trim().toLowerCase()
  if (normalizedMediaType !== undefined && normalizedMediaType !== expected.mediaType) {
    throw new Error('Source locator kind does not match the source file media type')
  }
}

function validConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Real parser confidence must be a finite number between 0 and 1')
  }
  const scale = 10 ** MAX_CONFIDENCE_DECIMALS
  const roundTrip = Math.round(value * scale) / scale
  if (roundTrip !== value) {
    throw new Error('Real parser confidence must have at most four decimal places')
  }
  return value
}

function buildLineStarts(canonicalText: string, signal?: AbortSignal): Uint32Array {
  let lineCount = 1
  for (let index = 0; index < canonicalText.length; index += 1) {
    if (index % 16_384 === 0) signal?.throwIfAborted()
    if (canonicalText[index] === '\n') lineCount += 1
  }
  const lineStarts = new Uint32Array(lineCount)
  let lineIndex = 1
  for (let index = 0; index < canonicalText.length; index += 1) {
    if (index % 16_384 === 0) signal?.throwIfAborted()
    if (canonicalText[index] === '\n') {
      lineStarts[lineIndex] = index + 1
      lineIndex += 1
    }
  }
  return lineStarts
}

function resolveCanonicalSourceTextIndex(
  context: SourceLocatorValidationContext,
): CanonicalSourceTextIndexData | null {
  if (context.canonicalTextIndex !== undefined && context.canonicalText !== undefined) {
    throw new Error('Canonical text context must provide either canonicalText or canonicalTextIndex')
  }
  if (context.canonicalTextIndex !== undefined) {
    const index = context.canonicalTextIndex as object
    if (typeof index !== 'object' || index === null || !canonicalSourceTextIndexBrand.has(index)) {
      throw new Error('Canonical text index is invalid')
    }
    const data = canonicalSourceTextIndexData.get(index)
    if (data === undefined) throw new Error('Canonical text index is invalid')
    return data
  }
  if (context.canonicalText === undefined) return null
  const canonicalText = canonicalizeSourceText(context.canonicalText)
  return { canonicalText, lineStarts: buildLineStarts(canonicalText) }
}

function positionAt(lineStarts: Uint32Array, offset: number): TxtPositionV1 {
  let low = 0
  let high = lineStarts.length
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (lineStarts[middle]! <= offset) low = middle
    else high = middle
  }
  return { line: low + 1, column: offset - lineStarts[low]! }
}

function advancePosition(start: TxtPositionV1, text: string): TxtPositionV1 {
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`${label} must contain only string-keyed JSON properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`${label} must contain only enumerable own data properties`)
    }
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly the versioned locator keys`)
  }
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a plain dense JSON array`)
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    throw new Error(`${label} must be a dense JSON array without extra properties`)
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new Error(`${label} must be a dense JSON array without sparse entries`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`${label} must contain only own data entries`)
    }
  }
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return denseArray(value, label).map((entry) => nonEmptyString(entry, label))
}

function sha256(value: unknown, label: string): string {
  const hash = nonEmptyString(value, label)
  if (!SHA256_PATTERN.test(hash)) throw new Error(`${label} must be lowercase hexadecimal`)
  return hash
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const integer = nonNegativeInteger(value, label)
  if (integer === 0) throw new Error(`${label} must be positive`)
  return integer
}

function normalizedNumber(value: unknown, label: string, allowZero: boolean): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value > 1 ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(`${label} must be a finite normalized number`)
  }
  return value
}

function matchesExpected(actual: string, expected: string | undefined, label: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label} does not match the stored source file`)
  }
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

function containsUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
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
