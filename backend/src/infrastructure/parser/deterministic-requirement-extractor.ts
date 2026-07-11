import type {
  ParseTask,
  Requirement,
  RequirementCategory,
  RequirementPriority,
  StoredProjectFile,
} from '../../domain/models.js'
import {
  createCanonicalSourceTextIndex,
  sha256Hex,
  validateRequirementEvidence,
  type CanonicalSourceTextIndex,
  type DocxTextRangeV1,
  type PdfRegionV1,
  type RealLocatorBaseV1,
  type RealSourceLocatorV1,
  type TxtPositionV1,
} from '../../domain/source-locator.js'
import { createId } from '../../lib/id.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  normalizeParserLimits,
  splitsSurrogatePair,
  validateParsedDocument,
  type DocumentBlock,
  type DocumentSourceSpan,
  type ParsedDocument,
  type ParserLimits,
} from './parser-types.js'

const PARSER_VERSION = 'deterministic-rules-v1'
const SENTENCE_PUNCTUATION = new Set(['。', '！', '？', '；', '!', '?', ';'])
const HARD_ENGLISH = /(?<![\p{L}\p{N}_])(?:must|shall)(?![\p{L}\p{N}_])/iu
const HARD_CHINESE = /必须|不得|应当|(?<!无)须(?!知)/u
const CHINESE_SCORE = /(?:最高可得|最高得|最高为|满分为|满分|分值为|分值|得|计|赋)\s*\d+(?:\.\d+)?\s*分(?![\p{L}\p{N}_])/u
const ENGLISH_PREFIX_SCORE = /(?<![\p{L}\p{N}_])(?:worth|award(?:ed)?|score(?:s)?|maximum|max)(?![\p{L}\p{N}_])(?:\s+of)?\s+\d+(?:\.\d+)?\s+points?(?![\p{L}\p{N}_])/iu
const EXPLICIT_ENGLISH_SCORE = /(?<![\p{L}\p{N}_])\d+(?:\.\d+)?\s+points?(?![\p{L}\p{N}_])/iu

const COMPLIANCE_CHINESE = [
  '资格', '资质', '证书', '证照', '截止', '提交', '签字', '签章', '盖章', '密封', '废标', '无效', '合规',
] as const
const COMMERCIAL_CHINESE = [
  '报价', '价格', '价款', '费用', '付款', '支付', '结算', '税', '保证金', '预算',
] as const
const COMPLIANCE_ENGLISH = /(?<![\p{L}\p{N}_])(?:licen(?:se(?:s|d)?|sing)|certificat(?:e(?:s|d)?|ion(?:s)?)|deadlines?|submissions?|signatures?|seal(?:s|ed|ing)?|compliance)(?![\p{L}\p{N}_])/iu
const COMMERCIAL_ENGLISH = /(?<![\p{L}\p{N}_])(?:prices?|pricing|payments?|costs?|fees?|invoices?|tax(?:es)?|deposits?|commercial)(?![\p{L}\p{N}_])/iu

interface RequirementCandidate {
  textStart: number
  textEnd: number
  quote: string
  sectionPath: string[]
  block: DocumentBlock
  hard: boolean
  score: boolean
  firstSourceSpanIndex: number
}

interface CandidateRange {
  textStart: number
  textEnd: number
}

export class DeterministicRequirementExtractor {
  private readonly limits: ParserLimits

  constructor(limits: ParserLimits = DEFAULT_PARSER_LIMITS) {
    this.limits = normalizeParserLimits(limits)
  }

  extract(
    document: ParsedDocument,
    file: StoredProjectFile,
    task: ParseTask,
    now: string,
    signal: AbortSignal,
  ): Requirement[] {
    signal.throwIfAborted()
    validateLineage(file, task)
    validateDocumentFilePair(document.format, file)
    validateParsedDocument(document, this.limits, signal)

    const candidates: RequirementCandidate[] = []
    const quotes = new Set<string>()
    for (const block of document.blocks) {
      signal.throwIfAborted()
      if (block.kind === 'heading') continue
      for (const range of splitSentenceRanges(block.text, block.textStart, signal)) {
        signal.throwIfAborted()
        const quote = document.canonicalText.slice(range.textStart, range.textEnd)
        const hard = hasHardSignal(quote)
        const score = hasScoringSignal(quote)
        if (!hard && !score) continue
        const firstSourceSpanIndex = validateCandidate(document, block, range, quote)
        if (quotes.has(quote)) continue
        if (candidates.length >= this.limits.maxRequirements) {
          throw new ParserError(
            'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
            'Document exceeds the configured unique requirement limit',
          )
        }
        quotes.add(quote)
        candidates.push({
          ...range,
          quote,
          sectionPath: [...block.sectionPath],
          block,
          hard,
          score,
          firstSourceSpanIndex,
        })
      }
    }

    if (candidates.length === 0) return []
    const canonicalTextIndex = createCanonicalSourceTextIndex(document.canonicalText, signal)
    candidates.sort((left, right) => left.textStart - right.textStart || left.textEnd - right.textEnd)
    return candidates.map((candidate, index) => {
      signal.throwIfAborted()
      return mapRequirement(document, canonicalTextIndex, file, task, now, candidate, index)
    })
  }
}

export function extractDeterministicRequirements(
  document: ParsedDocument,
  file: StoredProjectFile,
  task: ParseTask,
  now: string,
  signal: AbortSignal,
  limits: ParserLimits = DEFAULT_PARSER_LIMITS,
): Requirement[] {
  return new DeterministicRequirementExtractor(limits).extract(document, file, task, now, signal)
}

export function hasHardSignal(text: string): boolean {
  return HARD_ENGLISH.test(text) || HARD_CHINESE.test(text)
}

export function hasScoringSignal(text: string): boolean {
  return CHINESE_SCORE.test(text) || ENGLISH_PREFIX_SCORE.test(text) || EXPLICIT_ENGLISH_SCORE.test(text)
}

export function hasRequirementSignal(text: string): boolean {
  return hasHardSignal(text) || hasScoringSignal(text)
}

export function hasSentenceDelimiter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (SENTENCE_PUNCTUATION.has(character)) return true
    if (character === '.') {
      const next = text[index + 1]
      if (next === undefined || /\s/u.test(next)) return true
    }
  }
  return false
}

function* splitSentenceRanges(
  text: string,
  absoluteStart: number,
  signal: AbortSignal,
): Generator<CandidateRange> {
  let sentenceStart = 0
  for (let index = 0; index < text.length; index += 1) {
    if (index % 16_384 === 0) signal.throwIfAborted()
    const character = text[index]!
    const next = text[index + 1]
    const delimiter = SENTENCE_PUNCTUATION.has(character) ||
      (character === '.' && (next === undefined || /\s/u.test(next)))
    if (!delimiter) continue
    const range = trimmedRange(text, sentenceStart, index + 1, absoluteStart)
    if (range) yield range
    sentenceStart = index + 1
  }
  if (sentenceStart < text.length) {
    const range = trimmedRange(text, sentenceStart, text.length, absoluteStart)
    if (range) yield range
  }
}

function trimmedRange(
  text: string,
  start: number,
  end: number,
  absoluteStart: number,
): CandidateRange | null {
  const raw = text.slice(start, end)
  const leading = /^\s*/u.exec(raw)?.[0].length ?? 0
  const trailing = /\s*$/u.exec(raw)?.[0].length ?? 0
  const trimmedStart = start + leading
  const trimmedEnd = end - trailing
  return trimmedEnd > trimmedStart
    ? { textStart: absoluteStart + trimmedStart, textEnd: absoluteStart + trimmedEnd }
    : null
}

function validateCandidate(
  document: ParsedDocument,
  block: DocumentBlock,
  range: CandidateRange,
  quote: string,
): number {
  if (block.kind === 'heading' || range.textStart < block.textStart || range.textEnd > block.textEnd ||
      range.textEnd <= range.textStart) {
    invalidCandidate('Requirement candidate must be a non-empty slice of one non-heading block')
  }
  if (splitsSurrogatePair(document.canonicalText, range.textStart) ||
      splitsSurrogatePair(document.canonicalText, range.textEnd)) {
    invalidCandidate('Requirement candidate must not split a surrogate pair')
  }
  if (quote.length !== range.textEnd - range.textStart ||
      document.canonicalText.slice(range.textStart, range.textEnd) !== quote ||
      quote !== quote.normalize('NFC')) {
    invalidCandidate('Requirement quote must exactly match its canonical text slice')
  }
  const firstSourceSpanIndex = findFirstOverlappingSpanIndex(block.sourceSpans, range)
  if (firstSourceSpanIndex < 0) {
    invalidCandidate('Requirement candidate must overlap at least one source span')
  }
  return firstSourceSpanIndex
}

function mapRequirement(
  document: ParsedDocument,
  canonicalTextIndex: CanonicalSourceTextIndex,
  file: StoredProjectFile,
  task: ParseTask,
  now: string,
  candidate: RequirementCandidate,
  index: number,
): Requirement {
  const confidence = candidate.hard && candidate.score ? 0.98 : candidate.hard ? 0.95 : 0.9
  const priority: RequirementPriority = candidate.hard ? 'mandatory' : 'important'
  const sourceLocator = buildSourceLocator(document, file, candidate)
  let evidence
  try {
    evidence = validateRequirementEvidence(
      { extractionMethod: PARSER_VERSION, confidence, sourceLocator },
      {
        canonicalTextIndex,
        expectedSourceFileId: file.id,
        expectedSourceFileName: file.fileName,
        expectedSourceSha256: file.sha256,
        expectedSourceMediaType: file.mediaType,
        expectedTaskType: task.type,
      },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown evidence validation error'
    throw new ParserError('PARSER_WORKER_FAILED', `Generated requirement evidence is invalid: ${detail}`)
  }

  return {
    id: createId(),
    tenantId: file.tenantId,
    projectId: file.projectId,
    fileId: file.id,
    taskId: task.id,
    code: `REQ-${String(index + 1).padStart(4, '0')}`,
    title: candidate.quote,
    description: candidate.quote,
    category: categoryFor(candidate),
    priority,
    confirmationStatus: 'pending',
    confirmationNote: null,
    confirmedAt: null,
    extractionMethod: evidence.extractionMethod,
    confidence: evidence.confidence,
    sourceLocator: evidence.sourceLocator,
    createdAt: now,
    updatedAt: now,
  }
}

function buildSourceLocator(
  document: ParsedDocument,
  file: StoredProjectFile,
  candidate: RequirementCandidate,
): RealSourceLocatorV1 {
  const base: RealLocatorBaseV1 = {
    version: 1,
    sourceFileId: file.id,
    sourceFileName: file.fileName,
    sourceRevision: 1,
    sourceSha256: file.sha256,
    quote: candidate.quote,
    quoteSha256: sha256Hex(candidate.quote),
    textStart: candidate.textStart,
    textEnd: candidate.textEnd,
    sectionPath: [...candidate.sectionPath],
    parserVersion: PARSER_VERSION,
  }
  const spans = candidate.block.sourceSpans
  const firstSpan = spans[candidate.firstSourceSpanIndex]
  if (!firstSpan || !overlaps(firstSpan, candidate)) {
    invalidCandidate('Requirement candidate must overlap a source span')
  }

  if (document.format === 'pdf') {
    const regions: PdfRegionV1[] = []
    const seen = new Set<string>()
    for (let index = candidate.firstSourceSpanIndex; index < spans.length; index += 1) {
      const span = spans[index]!
      if (span.textStart >= candidate.textEnd) break
      if (span.source.kind !== 'pdf') invalidCandidate('PDF candidate has a non-PDF source span')
      const region = { page: span.source.page, bbox: { ...span.source.bbox } }
      const key = `${region.page}:${region.bbox.x}:${region.bbox.y}:${region.bbox.width}:${region.bbox.height}`
      if (!seen.has(key)) {
        seen.add(key)
        regions.push(region)
      }
    }
    return { ...base, kind: 'pdf', regions }
  }

  if (document.format === 'docx') {
    const ranges: DocxTextRangeV1[] = []
    const seen = new Set<string>()
    for (let index = candidate.firstSourceSpanIndex; index < spans.length; index += 1) {
      const span = spans[index]!
      if (span.textStart >= candidate.textEnd) break
      if (span.source.kind !== 'docx') invalidCandidate('DOCX candidate has a non-DOCX source span')
      const overlapStart = Math.max(candidate.textStart, span.textStart)
      const overlapEnd = Math.min(candidate.textEnd, span.textEnd)
      const range: DocxTextRangeV1 = {
        paragraphId: span.source.paragraphId,
        paragraphIndex: span.source.paragraphIndex,
        tablePath: span.source.tablePath.map((entry) => ({ ...entry })),
        charStart: span.source.charStart + overlapStart - span.textStart,
        charEnd: span.source.charStart + overlapEnd - span.textStart,
      }
      const key = `${range.paragraphId ?? ''}:${range.paragraphIndex}:${JSON.stringify(range.tablePath)}:${range.charStart}:${range.charEnd}`
      if (!seen.has(key)) {
        seen.add(key)
        ranges.push(range)
      }
    }
    return { ...base, kind: 'docx', ranges }
  }

  let start: TxtPositionV1 | null = null
  let end: TxtPositionV1 | null = null
  for (let index = candidate.firstSourceSpanIndex; index < spans.length; index += 1) {
    const span = spans[index]!
    if (span.textStart >= candidate.textEnd) break
    if (span.source.kind !== 'txt') invalidCandidate('TXT candidate has a non-TXT source span')
    const overlapStart = Math.max(candidate.textStart, span.textStart)
    const overlapEnd = Math.min(candidate.textEnd, span.textEnd)
    const clippedStart = {
      line: span.source.start.line,
      column: span.source.start.column + overlapStart - span.textStart,
    }
    const clippedEnd = {
      line: span.source.start.line,
      column: span.source.start.column + overlapEnd - span.textStart,
    }
    start ??= clippedStart
    end = clippedEnd
  }
  if (!start || !end) invalidCandidate('TXT candidate has no physical source positions')
  return { ...base, kind: 'txt', start, end }
}

function categoryFor(candidate: RequirementCandidate): RequirementCategory {
  const text = `${candidate.sectionPath.join(' ')} ${candidate.quote}`
  if (COMPLIANCE_CHINESE.some((keyword) => text.includes(keyword)) || COMPLIANCE_ENGLISH.test(text)) {
    return 'compliance'
  }
  if (COMMERCIAL_CHINESE.some((keyword) => text.includes(keyword)) || COMMERCIAL_ENGLISH.test(text)) {
    return 'commercial'
  }
  return 'technical'
}

function overlaps(span: DocumentSourceSpan, range: CandidateRange): boolean {
  return span.textStart < range.textEnd && span.textEnd > range.textStart
}

function findFirstOverlappingSpanIndex(
  spans: readonly DocumentSourceSpan[],
  range: CandidateRange,
): number {
  let low = 0
  let high = spans.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (spans[middle]!.textEnd <= range.textStart) low = middle + 1
    else high = middle
  }
  return low < spans.length && spans[low]!.textStart < range.textEnd ? low : -1
}

function validateLineage(file: StoredProjectFile, task: ParseTask): void {
  if (task.type !== 'document-parse-v1' || task.tenantId !== file.tenantId ||
      task.projectId !== file.projectId || task.fileId !== file.id) {
    throw new ParserError('FORMAT_MISMATCH', 'Parse task does not match the stored source file')
  }
}

function validateDocumentFilePair(format: ParsedDocument['format'], file: StoredProjectFile): void {
  const extension = extensionOf(file.fileName)
  const mediaType = mediaTypeEssence(file.mediaType)
  const expected = {
    txt: ['.txt', 'text/plain'],
    pdf: ['.pdf', 'application/pdf'],
    docx: ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  }[format]
  if (extension !== expected[0] || mediaType !== expected[1]) {
    throw new ParserError('FORMAT_MISMATCH', 'Parsed document format does not match stored file metadata')
  }
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index < 0 ? '' : fileName.slice(index).toLowerCase()
}

function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(';', 1)[0]!.trim().toLowerCase()
}

function invalidCandidate(message: string): never {
  throw new ParserError('PARSER_WORKER_FAILED', message)
}
