import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFPageProxy,
  TextContent,
  TextItem,
  TextStyle,
} from 'pdfjs-dist/types/src/display/api.js'
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport.js'
import { hasRequirementSignal } from './deterministic-requirement-extractor.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  normalizeParserLimits,
  validateParsedDocument,
  type DocumentBlock,
  type DocumentSourceSpan,
  type ParsedDocument,
  type ParserLimits,
  type PdfBlockSource,
} from './parser-types.js'

const PDFJS_ROOT = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
const STANDARD_FONT_DATA_URL = `${join(PDFJS_ROOT, 'standard_fonts')}/`
const CMAP_URL = `${join(PDFJS_ROOT, 'cmaps')}/`
const WASM_URL = `${join(PDFJS_ROOT, 'wasm')}/`

interface ProjectedItem {
  text: string
  itemIndex: number
  origin: readonly [number, number]
  flow: readonly [number, number]
  up: readonly [number, number]
  advance: number
  fontHeight: number
  structural: boolean
  region: PdfBlockSource | null
  lineHint: number
}

interface RelativePdfSpan {
  textStart: number
  textEnd: number
  source: PdfBlockSource
}

interface BlockDraft {
  kind: DocumentBlock['kind']
  text: string
  spans: RelativePdfSpan[]
  heading?: { level: number; title: string }
}

interface PositionedItem {
  item: ProjectedItem
  start: number
  end: number
  lineCoordinate: number
}

interface SegmentContributor {
  item: ProjectedItem
  separatorBefore: '' | ' '
}

interface LayoutSegment {
  contributors: SegmentContributor[]
  start: number
  end: number
  fontHeight: number
  draft: BlockDraft
}

interface LayoutLine {
  lineCoordinate: number
  items: PositionedItem[]
  segments: LayoutSegment[]
}

interface DocumentAssembly {
  canonicalParts: string[]
  canonicalUnits: number
  blocks: DocumentBlock[]
  sourceSpanCount: number
  sections: string[]
}

interface LayoutBudget {
  blocksRemaining: number
  spansRemaining: number
  canonicalUnitsRemaining: number
  hasPriorBlock: boolean
}

export class PdfDocumentExtractor {
  private readonly limits: ParserLimits

  constructor(limits: ParserLimits = DEFAULT_PARSER_LIMITS) {
    this.limits = normalizeParserLimits(limits)
  }

  async extract(content: Uint8Array, signal: AbortSignal): Promise<ParsedDocument> {
    signal.throwIfAborted()
    if (content.byteLength > this.limits.maxInputBytes) {
      resourceLimit('PDF input exceeds the configured byte limit')
    }
    return this.extractOwnedSnapshot(Uint8Array.from(content), signal)
  }

  async extractOwnedSnapshot(
    ownedBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<ParsedDocument> {
    signal.throwIfAborted()
    if (ownedBytes.byteLength > this.limits.maxInputBytes) {
      resourceLimit('PDF input exceeds the configured byte limit')
    }
    let loadingTask: PDFDocumentLoadingTask
    try {
      loadingTask = getDocument({
        data: ownedBytes,
        stopAtErrors: true,
        disableFontFace: true,
        useSystemFonts: false,
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        wasmUrl: WASM_URL,
      })
    } catch (error) {
      throwPdfJsError(error, signal)
    }

    let destroyPromise: Promise<void> | undefined
    const destroyOnce = (): Promise<void> => {
      if (destroyPromise === undefined) {
        try {
          destroyPromise = Promise.resolve(loadingTask.destroy()).then(() => undefined)
        } catch (error) {
          destroyPromise = Promise.reject(error)
        }
      }
      return destroyPromise
    }
    const abortListener = (): void => {
      void destroyOnce().catch(() => undefined)
    }
    let result: ParsedDocument | undefined
    let primaryError: unknown
    let listenerRegistered = false
    try {
      signal.addEventListener('abort', abortListener, { once: true })
      listenerRegistered = true
      signal.throwIfAborted()
      const pdf = await awaitPdfJs(loadingTask.promise, signal)
      signal.throwIfAborted()
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) {
        invalidPdf('PDF page count is invalid')
      }
      if (pdf.numPages > this.limits.maxPdfPages) {
        resourceLimit('PDF exceeds the configured page-count limit')
      }

      const assembly: DocumentAssembly = {
        canonicalParts: [],
        canonicalUnits: 0,
        blocks: [],
        sourceSpanCount: 0,
        sections: [],
      }
      let pdfItemCount = 0
      let decodedTextUnits = 0
      const itemBudget = Math.max(this.limits.maxSourceSpans, this.limits.maxDocumentBlocks)
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        signal.throwIfAborted()
        const page = await awaitPdfJs(pdf.getPage(pageNumber), signal)
        try {
          const viewport = page.getViewport({ scale: 1 })
          validateViewport(viewport)
          const textContent = await awaitPdfJs(page.getTextContent({
            includeMarkedContent: false,
            disableNormalization: false,
          }), signal)
          signal.throwIfAborted()
          if (textContent.items.length > itemBudget - pdfItemCount) {
            resourceLimit('PDF exceeds the configured text-item limit')
          }
          pdfItemCount += textContent.items.length
          for (let itemIndex = 0; itemIndex < textContent.items.length; itemIndex += 1) {
            if (itemIndex % 1_024 === 0) signal.throwIfAborted()
            const value = textContent.items[itemIndex]
            if (typeof value !== 'object' || value === null || !('str' in value)) continue
            const rawText = Reflect.get(value, 'str')
            if (typeof rawText !== 'string') invalidPdf('PDF text item string is invalid')
            if (rawText.length > this.limits.maxCanonicalTextUnits - decodedTextUnits) {
              resourceLimit('PDF exceeds the configured decoded text limit')
            }
            decodedTextUnits += rawText.length
          }
          const layoutBudget: LayoutBudget = {
            blocksRemaining: this.limits.maxDocumentBlocks - assembly.blocks.length,
            spansRemaining: this.limits.maxSourceSpans - assembly.sourceSpanCount,
            canonicalUnitsRemaining: this.limits.maxCanonicalTextUnits - assembly.canonicalUnits,
            hasPriorBlock: assembly.blocks.length > 0,
          }
          const drafts = buildConservativePageDrafts(
            textContent,
            viewport,
            pageNumber,
            layoutBudget,
            signal,
          )
          appendDrafts(assembly, drafts, this.limits, signal)
        } finally {
          cleanupPage(page)
        }
      }

      if (assembly.blocks.length === 0) {
        throw new ParserError(
          'OCR_REQUIRED',
          'PDF contains no locatable digital text; OCR is outside this parser version',
        )
      }
      signal.throwIfAborted()
      const canonicalText = assembly.canonicalParts.join('\n')
      signal.throwIfAborted()
      const document: ParsedDocument = {
        format: 'pdf',
        canonicalText,
        blocks: assembly.blocks,
      }
      result = validateParsedDocument(document, this.limits, signal)
    } catch (error) {
      primaryError = normalizeExtractorError(error, signal)
    } finally {
      if (listenerRegistered) signal.removeEventListener('abort', abortListener)
      try {
        await destroyOnce()
      } catch (error) {
        if (primaryError === undefined) {
          primaryError = new ParserError(
            'PARSER_WORKER_FAILED',
            error instanceof Error ? error.message : 'PDF cleanup failed',
          )
        }
      }
    }

    signal.throwIfAborted()
    if (primaryError !== undefined) throw primaryError
    if (result === undefined) {
      throw new ParserError('PARSER_WORKER_FAILED', 'PDF parser produced no document')
    }
    return result
  }
}

function buildConservativePageDrafts(
  content: TextContent,
  viewport: PageViewport,
  pageNumber: number,
  budget: LayoutBudget,
  signal: AbortSignal,
): BlockDraft[] {
  const items: ProjectedItem[] = []
  let lineHint = 0
  for (let itemIndex = 0; itemIndex < content.items.length; itemIndex += 1) {
    if (itemIndex % 1_024 === 0) signal.throwIfAborted()
    const value = content.items[itemIndex]
    if (!isTextItem(value)) continue
    const item = projectTextItem(
      value,
      content.styles[value.fontName],
      viewport,
      pageNumber,
      itemIndex,
      lineHint,
      signal,
    )
    if (item === null) {
      if (value.hasEOL) lineHint += 1
      continue
    }
    items.push(item)
    if (value.hasEOL) lineHint += 1
  }
  const layoutItems: ProjectedItem[] = []
  for (const item of items) {
    signal.throwIfAborted()
    if (item.region !== null || isCombiningHint(item, signal)) layoutItems.push(item)
  }
  const dominant = dominantFlow(layoutItems, signal)
  if (dominant === null) {
    return conservativeItemDrafts(layoutItems, budget, signal)
  }
  const structural: ProjectedItem[] = []
  const conservative: ProjectedItem[] = []
  for (const item of layoutItems) {
    signal.throwIfAborted()
    if (item.structural && angleDistance(item.flow, dominant) <= Math.PI / 60) {
      structural.push(item)
    } else {
      conservative.push(item)
    }
  }
  const viewportScale = Math.hypot(viewport.transform[0]!, viewport.transform[1]!)
  const lines = groupLines(structural, dominant, viewportScale, budget, signal)
  const drafts = classifyPage(lines, structural, dominant, viewport, viewportScale, signal)
  for (const draft of conservativeItemDrafts(conservative, budget, signal)) {
    signal.throwIfAborted()
    drafts.push(draft)
  }
  return drafts
}

function dominantFlow(
  items: ProjectedItem[],
  signal: AbortSignal,
): readonly [number, number] | null {
  let cosine = 0
  let sine = 0
  let orientationX = 0
  let orientationY = 0
  let weightTotal = 0
  for (let index = 0; index < items.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const item = items[index]!
    if (!item.structural) continue
    const weight = Math.max(1, item.text.length)
    const angle = Math.atan2(item.flow[1], item.flow[0])
    cosine += Math.cos(2 * angle) * weight
    sine += Math.sin(2 * angle) * weight
    orientationX += item.flow[0] * weight
    orientationY += item.flow[1] * weight
    weightTotal += weight
  }
  if (weightTotal === 0 || (!Number.isFinite(cosine) || !Number.isFinite(sine))) return null
  const angle = Math.atan2(sine, cosine) / 2
  let flow: readonly [number, number] = [Math.cos(angle), Math.sin(angle)]
  if (flow[0] * orientationX + flow[1] * orientationY < 0) {
    flow = [-flow[0], -flow[1]]
  }
  return flow
}

function groupLines(
  items: ProjectedItem[],
  dominant: readonly [number, number],
  viewportScale: number,
  budget: LayoutBudget,
  signal: AbortSignal,
): LayoutLine[] {
  const normal: readonly [number, number] = [-dominant[1], dominant[0]]
  const positioned: PositionedItem[] = []
  for (let index = 0; index < items.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const item = items[index]!
    const start = dot(item.origin, dominant)
    const along = Math.abs(dot(item.flow, dominant))
    positioned.push({
      item,
      start,
      end: start + item.advance * along,
      lineCoordinate: dot(item.origin, normal),
    })
  }
  signal.throwIfAborted()
  positioned.sort((left, right) =>
    left.lineCoordinate - right.lineCoordinate || left.start - right.start ||
    left.item.itemIndex - right.item.itemIndex
  )
  signal.throwIfAborted()

  type LineGroup = {
    coordinate: number
    fontHeight: number
    lineHint: number
    items: PositionedItem[]
  }
  const lines: LayoutLine[] = []
  let current: LineGroup | undefined
  const finishCurrentLine = (): void => {
    if (current === undefined) return
    signal.throwIfAborted()
    current.items.sort((left, right) => left.start - right.start ||
      left.item.itemIndex - right.item.itemIndex)
    signal.throwIfAborted()
    const segments = segmentLine(current.items, budget, signal)
    if (segments.length > 0) {
      lines.push({
        lineCoordinate: current.coordinate,
        items: current.items,
        segments,
      })
    }
  }
  for (const candidate of positioned) {
    signal.throwIfAborted()
    const tolerance = Math.max(
      2 * viewportScale,
      0.3 * Math.max(candidate.item.fontHeight, current?.fontHeight ?? 0),
    )
    if (current === undefined || candidate.item.lineHint !== current.lineHint ||
        Math.abs(candidate.lineCoordinate - current.coordinate) > tolerance) {
      finishCurrentLine()
      current = {
        coordinate: candidate.lineCoordinate,
        fontHeight: candidate.item.fontHeight,
        lineHint: candidate.item.lineHint,
        items: [candidate],
      }
    } else {
      const count = current.items.length
      current.coordinate = (current.coordinate * count + candidate.lineCoordinate) / (count + 1)
      current.fontHeight = Math.max(current.fontHeight, candidate.item.fontHeight)
      current.items.push(candidate)
    }
  }
  finishCurrentLine()
  return lines
}

function angleDistance(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  const absoluteDot = Math.min(1, Math.abs(dot(left, right)))
  return Math.acos(absoluteDot)
}

function dot(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  return left[0] * right[0] + left[1] * right[1]
}

function conservativeItemDrafts(
  items: ProjectedItem[],
  budget: LayoutBudget,
  signal: AbortSignal,
): BlockDraft[] {
  const drafts: BlockDraft[] = []
  signal.throwIfAborted()
  const ordered = [...items]
  ordered.sort((left, right) => left.itemIndex - right.itemIndex)
  signal.throwIfAborted()
  for (let index = 0; index < ordered.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const item = ordered[index]!
    if (item.region === null) continue
    const draft: BlockDraft = {
      kind: 'paragraph',
      text: item.text,
      spans: [{ textStart: 0, textEnd: item.text.length, source: item.region }],
    }
    reserveDraft(draft, budget)
    drafts.push(draft)
  }
  return drafts
}

function reserveDraft(draft: BlockDraft, budget: LayoutBudget): void {
  if (budget.blocksRemaining < 1) resourceLimit('PDF exceeds the configured block limit')
  if (draft.spans.length > budget.spansRemaining) {
    resourceLimit('PDF exceeds the configured source-span limit')
  }
  const separatorUnits = budget.hasPriorBlock ? 1 : 0
  if (draft.text.length + separatorUnits > budget.canonicalUnitsRemaining) {
    resourceLimit('PDF exceeds the configured canonical text limit')
  }
  budget.blocksRemaining -= 1
  budget.spansRemaining -= draft.spans.length
  budget.canonicalUnitsRemaining -= draft.text.length + separatorUnits
  budget.hasPriorBlock = true
}

function isCombiningHint(item: ProjectedItem, signal: AbortSignal): boolean {
  if (item.advance !== 0 || item.text.length === 0 || item.text.length > 64) return false
  signal.throwIfAborted()
  const combining = /^\p{M}+$/u.test(item.text)
  signal.throwIfAborted()
  return combining
}

function segmentLine(
  items: PositionedItem[],
  budget: LayoutBudget,
  signal: AbortSignal,
): LayoutSegment[] {
  const segments: LayoutSegment[] = []
  let current: SegmentContributor[] = []
  let first: PositionedItem | undefined
  let previous: PositionedItem | undefined
  const finishCurrentSegment = (): void => {
    if (first === undefined || previous === undefined || current.length === 0) return
    signal.throwIfAborted()
    const separatorUnits = budget.hasPriorBlock ? 1 : 0
    const draft = buildSegmentDraft(
      current,
      budget.spansRemaining,
      budget.canonicalUnitsRemaining - separatorUnits,
      signal,
    )
    if (draft === null) return
    let weightedHeight = 0
    let characterCount = 0
    for (let index = 0; index < current.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const contributor = current[index]!
      weightedHeight += contributor.item.fontHeight * contributor.item.text.length
      characterCount += contributor.item.text.length
    }
    reserveDraft(draft, budget)
    segments.push({
      contributors: current,
      start: first.start,
      end: previous.end,
      fontHeight: characterCount === 0 ? first.item.fontHeight : weightedHeight / characterCount,
      draft,
    })
  }

  for (let index = 0; index < items.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const positioned = items[index]!
    if (previous === undefined) {
      current = [{ item: positioned.item, separatorBefore: '' }]
      first = positioned
      previous = positioned
      continue
    }
    const gap = positioned.start - previous.end
    const em = Math.max(1, (positioned.item.fontHeight + previous.item.fontHeight) / 2)
    if (gap > 1.5 * em) {
      finishCurrentSegment()
      current = [{ item: positioned.item, separatorBefore: '' }]
      first = positioned
    } else {
      current.push({
        item: positioned.item,
        separatorBefore: gap < 0.2 * em ? '' : ' ',
      })
    }
    previous = positioned
  }
  finishCurrentSegment()
  return segments
}

function buildSegmentDraft(
  contributors: SegmentContributor[],
  maxSpans: number,
  maxTextUnits: number,
  signal: AbortSignal,
): BlockDraft | null {
  const groups: Array<{ separator: boolean; items: ProjectedItem[] }> = []
  for (const contributor of contributors) {
    signal.throwIfAborted()
    if (groups.length === 0 || contributor.separatorBefore === ' ') {
      groups.push({ separator: contributor.separatorBefore === ' ', items: [contributor.item] })
    } else {
      groups.at(-1)!.items.push(contributor.item)
    }
  }

  const textParts: string[] = []
  let textLength = 0
  const spans: RelativePdfSpan[] = []
  for (const group of groups) {
    signal.throwIfAborted()
    const usableItems: ProjectedItem[] = []
    let hasLocatablePredecessor = false
    let hasUnlocatableCombining = false
    for (let index = 0; index < group.items.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const item = group.items[index]!
      if (item.region !== null) {
        usableItems.push(item)
        hasLocatablePredecessor = true
      } else if (hasLocatablePredecessor && isCombiningHint(item, signal)) {
        usableItems.push(item)
        hasUnlocatableCombining = true
      }
    }
    const regions: PdfBlockSource[] = []
    const joinedParts: string[] = []
    for (let index = 0; index < usableItems.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const item = usableItems[index]!
      joinedParts.push(item.text)
      if (item.region !== null) regions.push(item.region)
    }
    if (regions.length === 0) continue
    signal.throwIfAborted()
    const joined = joinedParts.join('')
    signal.throwIfAborted()
    const normalized = joined.normalize('NFC')
    signal.throwIfAborted()
    if (normalized.length === 0) continue
    const separator = group.separator && textLength > 0 ? 1 : 0
    if (normalized.length + separator > maxTextUnits - textLength) {
      resourceLimit('PDF exceeds the configured canonical text limit')
    }
    if (separator === 1) {
      textParts.push(' ')
      textLength += 1
    }
    const groupStart = textLength
    textParts.push(normalized)
    textLength += normalized.length
    const mustCoalesce = normalized !== joined || hasUnlocatableCombining
    if (mustCoalesce) {
      if (spans.length >= maxSpans) resourceLimit('PDF exceeds the configured source-span limit')
      spans.push({
        textStart: groupStart,
        textEnd: textLength,
        source: unionPdfSources(regions, signal),
      })
      continue
    }
    let itemOffset = groupStart
    for (let index = 0; index < usableItems.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const item = usableItems[index]!
      const itemEnd = itemOffset + item.text.length
      if (item.region !== null && itemEnd > itemOffset) {
        if (spans.length >= maxSpans) resourceLimit('PDF exceeds the configured source-span limit')
        spans.push({ textStart: itemOffset, textEnd: itemEnd, source: item.region })
      }
      itemOffset = itemEnd
    }
  }
  if (textLength === 0 || spans.length === 0) return null
  signal.throwIfAborted()
  const text = textParts.join('')
  signal.throwIfAborted()
  return { kind: 'paragraph', text, spans }
}

function unionPdfSources(sources: PdfBlockSource[], signal: AbortSignal): PdfBlockSource {
  const page = sources[0]?.page
  if (page === undefined) throw new ParserError('PARSER_WORKER_FAILED', 'PDF region union is empty')
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (let index = 0; index < sources.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const source = sources[index]!
    if (source.page !== page) {
      throw new ParserError('PARSER_WORKER_FAILED', 'PDF region union crossed page boundaries')
    }
    left = Math.min(left, source.bbox.x)
    top = Math.min(top, source.bbox.y)
    right = Math.max(right, source.bbox.x + source.bbox.width)
    bottom = Math.max(bottom, source.bbox.y + source.bbox.height)
  }
  const x = round6(left)
  const y = round6(top)
  return {
    kind: 'pdf',
    page,
    bbox: {
      x,
      y,
      width: Math.min(round6(right - left), round6(1 - x)),
      height: Math.min(round6(bottom - top), round6(1 - y)),
    },
  }
}

function classifyPage(
  lines: LayoutLine[],
  items: ProjectedItem[],
  dominant: readonly [number, number],
  viewport: PageViewport,
  viewportScale: number,
  signal: AbortSignal,
): BlockDraft[] {
  signal.throwIfAborted()
  const tableLineIndexes = stableTableLineIndexes(lines, viewport, viewportScale, signal)
  if (tableLineIndexes.size > 0) {
    const fallback = classifyFallbackHeadingLines(lines, items, dominant, viewport, signal)
    const drafts: BlockDraft[] = []
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (lineIndex % 1_024 === 0) signal.throwIfAborted()
      if (tableLineIndexes.has(lineIndex)) {
        const segments = lines[lineIndex]!.segments
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
          if (segmentIndex % 1_024 === 0) signal.throwIfAborted()
          const segment = segments[segmentIndex]!
          drafts.push({ ...segment.draft, kind: 'table-cell' })
        }
      } else {
        const lineDrafts = fallback[lineIndex] ?? []
        for (let draftIndex = 0; draftIndex < lineDrafts.length; draftIndex += 1) {
          if (draftIndex % 1_024 === 0) signal.throwIfAborted()
          drafts.push(lineDrafts[draftIndex]!)
        }
      }
    }
    return drafts
  }
  const columnBands = stableColumnBands(lines, dominant, viewport, viewportScale, signal)
  if (columnBands.length > 0) {
    const fallback = classifyFallbackHeadingLines(lines, items, dominant, viewport, signal)
    const drafts: BlockDraft[] = []
    let lineIndex = 0
    let bandIndex = 0
    while (lineIndex < lines.length) {
      signal.throwIfAborted()
      const band = columnBands[bandIndex]
      if (band !== undefined && band.start === lineIndex) {
        for (const segment of band.segments) {
          signal.throwIfAborted()
          drafts.push(segment.draft)
        }
        lineIndex = band.end
        bandIndex += 1
      } else {
        const lineDrafts = fallback[lineIndex] ?? []
        for (let draftIndex = 0; draftIndex < lineDrafts.length; draftIndex += 1) {
          if (draftIndex % 1_024 === 0) signal.throwIfAborted()
          drafts.push(lineDrafts[draftIndex]!)
        }
        lineIndex += 1
      }
    }
    return drafts
  }
  return classifyFallbackHeadings(lines, items, dominant, viewport, signal)
}

function stableColumnBands(
  lines: LayoutLine[],
  dominant: readonly [number, number],
  viewport: PageViewport,
  viewportScale: number,
  signal: AbortSignal,
): Array<{ start: number; end: number; segments: LayoutSegment[] }> {
  if (lines.length < 6) return []
  const spacings: number[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const spacing = lines[index]!.lineCoordinate - lines[index - 1]!.lineCoordinate
    if (spacing > 0) spacings.push(spacing)
  }
  const typicalSpacing = numericMedian(spacings, signal)
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  for (let index = 1; index < lines.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const spacing = lines[index]!.lineCoordinate - lines[index - 1]!.lineCoordinate
    if (typicalSpacing !== null && spacing >= 2 * typicalSpacing) {
      ranges.push({ start, end: index })
      start = index
    }
  }
  ranges.push({ start, end: lines.length })

  const bands: Array<{ start: number; end: number; segments: LayoutSegment[] }> = []
  for (const rangeValue of ranges) {
    signal.throwIfAborted()
    if (rangeValue.end - rangeValue.start < 6) continue
    const columns = stableColumns(
      lines.slice(rangeValue.start, rangeValue.end),
      dominant,
      viewport,
      viewportScale,
      signal,
    )
    if (columns !== null) {
      const segments: LayoutSegment[] = []
      for (let index = 0; index < columns.left.length; index += 1) {
        if (index % 1_024 === 0) signal.throwIfAborted()
        segments.push(columns.left[index]!)
      }
      for (let index = 0; index < columns.right.length; index += 1) {
        if (index % 1_024 === 0) signal.throwIfAborted()
        segments.push(columns.right[index]!)
      }
      bands.push({
        ...rangeValue,
        segments,
      })
    }
  }
  return bands
}

function stableTableLineIndexes(
  lines: LayoutLine[],
  viewport: PageViewport,
  viewportScale: number,
  signal: AbortSignal,
): Set<number> {
  const indexes = new Set<number>()
  let start = 0
  while (start < lines.length) {
    signal.throwIfAborted()
    const columnCount = lines[start]!.segments.length
    if (columnCount < 2) {
      start += 1
      continue
    }
    let end = start + 1
    while (end < lines.length && lines[end]!.segments.length === columnCount) {
      if (end % 1_024 === 0) signal.throwIfAborted()
      end += 1
    }
    if (end - start >= 3 && isStableTable(lines.slice(start, end), viewport, viewportScale, signal)) {
      for (let index = start; index < end; index += 1) {
        if (index % 1_024 === 0) signal.throwIfAborted()
        indexes.add(index)
      }
    }
    start = end
  }
  return indexes
}

function isStableTable(
  lines: LayoutLine[],
  viewport: PageViewport,
  viewportScale: number,
  signal: AbortSignal,
): boolean {
  if (lines.length < 3) return false
  const columnCount = lines[0]?.segments.length ?? 0
  if (columnCount < 2) return false
  for (let index = 0; index < lines.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    if (lines[index]!.segments.length !== columnCount) return false
  }
  const tolerance = Math.max(2 * viewportScale, 0.01 * viewport.width)
  for (let column = 0; column < columnCount; column += 1) {
    signal.throwIfAborted()
    let minimumStart = Number.POSITIVE_INFINITY
    let maximumStart = Number.NEGATIVE_INFINITY
    for (let index = 0; index < lines.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const line = lines[index]!
      const start = line.segments[column]!.start
      minimumStart = Math.min(minimumStart, start)
      maximumStart = Math.max(maximumStart, start)
    }
    if (maximumStart - minimumStart > tolerance) return false
  }
  for (let column = 0; column < columnCount - 1; column += 1) {
    signal.throwIfAborted()
    let rightEdge = Number.NEGATIVE_INFINITY
    let nextLeft = Number.POSITIVE_INFINITY
    for (let index = 0; index < lines.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      const line = lines[index]!
      rightEdge = Math.max(rightEdge, line.segments[column]!.end)
      nextLeft = Math.min(nextLeft, line.segments[column + 1]!.start)
    }
    if (rightEdge >= nextLeft) return false
  }
  let minimumSpacing = Number.POSITIVE_INFINITY
  let maximumSpacing = Number.NEGATIVE_INFINITY
  for (let index = 1; index < lines.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const spacing = lines[index]!.lineCoordinate - lines[index - 1]!.lineCoordinate
    if (spacing <= 0) return false
    minimumSpacing = Math.min(minimumSpacing, spacing)
    maximumSpacing = Math.max(maximumSpacing, spacing)
  }
  return minimumSpacing > 0 && maximumSpacing <= minimumSpacing * 3
}

function stableColumns(
  lines: LayoutLine[],
  dominant: readonly [number, number],
  viewport: PageViewport,
  viewportScale: number,
  signal: AbortSignal,
): { left: LayoutSegment[]; right: LayoutSegment[] } | null {
  const references: Array<{
    segment: LayoutSegment
    lineIndex: number
    lineCoordinate: number
  }> = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex % 1_024 === 0) signal.throwIfAborted()
    const line = lines[lineIndex]!
    for (const segment of line.segments) {
      references.push({ segment, lineIndex, lineCoordinate: line.lineCoordinate })
    }
  }
  if (references.length < 6 || lines.length < 6) return null
  signal.throwIfAborted()
  const sorted = [...references]
  sorted.sort((left, right) =>
    left.segment.start - right.segment.start || left.lineIndex - right.lineIndex
  )
  signal.throwIfAborted()
  let splitIndex = -1
  let largestStartGap = 0
  for (let index = 1; index < sorted.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const gap = sorted[index]!.segment.start - sorted[index - 1]!.segment.start
    if (gap > largestStartGap) {
      largestStartGap = gap
      splitIndex = index
    }
  }
  if (splitIndex < 3 || sorted.length - splitIndex < 3) return null
  const leftReferences = sorted.slice(0, splitIndex)
  const rightReferences = sorted.slice(splitIndex)
  const leftLines = new Set<number>()
  const rightLines = new Set<number>()
  for (let index = 0; index < leftReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    leftLines.add(leftReferences[index]!.lineIndex)
  }
  for (let index = 0; index < rightReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    rightLines.add(rightReferences[index]!.lineIndex)
  }
  if (leftLines.size < 3 || rightLines.size < 3) return null
  for (const line of leftLines) {
    signal.throwIfAborted()
    if (rightLines.has(line)) return null
  }

  const flowExtent = Math.abs(dominant[0]) * viewport.width +
    Math.abs(dominant[1]) * viewport.height
  let gutterLeft = Number.NEGATIVE_INFINITY
  let gutterRight = Number.POSITIVE_INFINITY
  let leftStartMinimum = Number.POSITIVE_INFINITY
  let leftStartMaximum = Number.NEGATIVE_INFINITY
  let leftLineMinimum = Number.POSITIVE_INFINITY
  let leftLineMaximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < leftReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const reference = leftReferences[index]!
    gutterLeft = Math.max(gutterLeft, reference.segment.end)
    leftStartMinimum = Math.min(leftStartMinimum, reference.segment.start)
    leftStartMaximum = Math.max(leftStartMaximum, reference.segment.start)
    leftLineMinimum = Math.min(leftLineMinimum, reference.lineCoordinate)
    leftLineMaximum = Math.max(leftLineMaximum, reference.lineCoordinate)
  }
  let rightStartMinimum = Number.POSITIVE_INFINITY
  let rightStartMaximum = Number.NEGATIVE_INFINITY
  let rightLineMinimum = Number.POSITIVE_INFINITY
  let rightLineMaximum = Number.NEGATIVE_INFINITY
  for (let index = 0; index < rightReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const reference = rightReferences[index]!
    gutterRight = Math.min(gutterRight, reference.segment.start)
    rightStartMinimum = Math.min(rightStartMinimum, reference.segment.start)
    rightStartMaximum = Math.max(rightStartMaximum, reference.segment.start)
    rightLineMinimum = Math.min(rightLineMinimum, reference.lineCoordinate)
    rightLineMaximum = Math.max(rightLineMaximum, reference.lineCoordinate)
  }
  if (gutterRight - gutterLeft <= 0.05 * flowExtent) return null
  const anchorTolerance = Math.max(2 * viewportScale, 0.01 * flowExtent)
  if (leftStartMaximum - leftStartMinimum > anchorTolerance ||
      rightStartMaximum - rightStartMinimum > anchorTolerance) {
    return null
  }
  if (Math.max(leftLineMinimum, rightLineMinimum) >
      Math.min(leftLineMaximum, rightLineMaximum)) {
    return null
  }
  const readingOrder = (
    left: typeof leftReferences[number],
    right: typeof leftReferences[number],
  ): number => left.lineCoordinate - right.lineCoordinate ||
    left.segment.start - right.segment.start || left.lineIndex - right.lineIndex
  signal.throwIfAborted()
  leftReferences.sort(readingOrder)
  rightReferences.sort(readingOrder)
  signal.throwIfAborted()
  const left: LayoutSegment[] = []
  const right: LayoutSegment[] = []
  for (let index = 0; index < leftReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    left.push(leftReferences[index]!.segment)
  }
  for (let index = 0; index < rightReferences.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    right.push(rightReferences[index]!.segment)
  }
  return { left, right }
}

function range(values: number[]): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const value of values) {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  return { minimum, maximum }
}

function classifyFallbackHeadings(
  lines: LayoutLine[],
  items: ProjectedItem[],
  dominant: readonly [number, number],
  viewport: PageViewport,
  signal: AbortSignal,
): BlockDraft[] {
  const drafts: BlockDraft[] = []
  for (const lineDrafts of classifyFallbackHeadingLines(lines, items, dominant, viewport, signal)) {
    signal.throwIfAborted()
    for (let index = 0; index < lineDrafts.length; index += 1) {
      if (index % 1_024 === 0) signal.throwIfAborted()
      drafts.push(lineDrafts[index]!)
    }
  }
  return drafts
}

function classifyFallbackHeadingLines(
  lines: LayoutLine[],
  items: ProjectedItem[],
  dominant: readonly [number, number],
  viewport: PageViewport,
  signal: AbortSignal,
): BlockDraft[][] {
  const bodyMedian = weightedMedianFontHeight(items, signal)
  const bounds = projectedViewportBounds(dominant, viewport)
  const lineSpacings: number[] = []
  for (let index = 1; index < lines.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const spacing = lines[index]!.lineCoordinate - lines[index - 1]!.lineCoordinate
    if (spacing > 0) lineSpacings.push(spacing)
  }
  const typicalSpacing = numericMedian(lineSpacings, signal)
  const viewportScale = Math.hypot(viewport.transform[0]!, viewport.transform[1]!)
  const fontRanks = headingFontRanks(lines, bodyMedian, viewportScale, signal)
  const drafts: BlockDraft[][] = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    signal.throwIfAborted()
    const line = lines[lineIndex]!
    const lineDrafts: BlockDraft[] = []
    for (const segment of line.segments) {
      signal.throwIfAborted()
      const heading = line.segments.length === 1
        ? classifyHeading(
            segment,
            lineIndex,
            lines,
            bodyMedian,
            bounds,
            typicalSpacing,
            fontRanks.get(fontSizeBucket(segment.fontHeight, viewportScale)),
          )
        : null
      lineDrafts.push(heading === null
        ? segment.draft
        : { ...segment.draft, kind: 'heading', heading })
    }
    drafts.push(lineDrafts)
  }
  return drafts
}

function classifyHeading(
  segment: LayoutSegment,
  lineIndex: number,
  lines: LayoutLine[],
  bodyMedian: number | null,
  bounds: { minimum: number; maximum: number },
  typicalSpacing: number | null,
  derivedLevel: number | undefined,
): { level: number; title: string } | null {
  const text = segment.draft.text
  if (text.length > 120 || text.length === 0 || hasRequirementSignal(text) ||
      /[。！？；!?;.]\s*$/u.test(text)) {
    return null
  }
  const explicit = explicitHeading(text)
  const large = bodyMedian !== null && bodyMedian > 0 &&
    segment.fontHeight >= 1.25 * bodyMedian
  const extent = bounds.maximum - bounds.minimum
  const centered = extent > 0 && Math.abs(
    (segment.start + segment.end) / 2 - (bounds.minimum + bounds.maximum) / 2,
  ) <= 0.1 * extent
  const before = lineIndex === 0
    ? Number.POSITIVE_INFINITY
    : lines[lineIndex]!.lineCoordinate - lines[lineIndex - 1]!.lineCoordinate
  const after = lineIndex === lines.length - 1
    ? Number.POSITIVE_INFINITY
    : lines[lineIndex + 1]!.lineCoordinate - lines[lineIndex]!.lineCoordinate
  const isolated = typicalSpacing !== null && before >= 1.25 * typicalSpacing &&
    after >= 1.25 * typicalSpacing
  const signalCount = Number(explicit !== null) + Number(large) + Number(centered && isolated)
  if (signalCount < 2) return null
  if (explicit !== null) return explicit
  const title = text.trim()
  return title.length === 0 || derivedLevel === undefined
    ? null
    : { level: derivedLevel, title }
}

function headingFontRanks(
  lines: LayoutLine[],
  bodyMedian: number | null,
  viewportScale: number,
  signal: AbortSignal,
): Map<number, number> {
  const sizes = new Set<number>()
  if (bodyMedian === null || bodyMedian <= 0) return new Map()
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (lineIndex % 1_024 === 0) signal.throwIfAborted()
    const line = lines[lineIndex]!
    if (line.segments.length !== 1) continue
    const segment = line.segments[0]!
    const text = segment.draft.text
    if (segment.fontHeight >= 1.25 * bodyMedian && text.length <= 120 &&
        text.length > 0 && !hasRequirementSignal(text) &&
        !/[。！？；!?;.]\s*$/u.test(text)) {
      sizes.add(fontSizeBucket(segment.fontHeight, viewportScale))
    }
  }
  signal.throwIfAborted()
  const ordered = [...sizes]
  ordered.sort((left, right) => right - left)
  signal.throwIfAborted()
  const ranks = new Map<number, number>()
  for (let index = 0; index < ordered.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    ranks.set(ordered[index]!, Math.min(9, index + 1))
  }
  return ranks
}

function fontSizeBucket(fontHeight: number, viewportScale: number): number {
  const unscaled = viewportScale > 0 ? fontHeight / viewportScale : fontHeight
  return Math.round(unscaled * 4) / 4
}

function explicitHeading(text: string): { level: number; title: string } | null {
  const markdown = /^(#{1,6})\s+(.+)$/u.exec(text)
  if (markdown !== null) return nonEmptyHeading(markdown[1]!.length, markdown[2]!)

  const chineseSection = /^第[零〇一二三四五六七八九十百千万两0-9]+([章节])\s*(.+)$/u.exec(text)
  if (chineseSection !== null) {
    return nonEmptyHeading(chineseSection[1] === '章' ? 1 : 2, chineseSection[2]!)
  }
  const decimal = /^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/u.exec(text)
  if (decimal !== null) {
    return nonEmptyHeading(Math.min(9, decimal[1]!.split('.').length), decimal[2]!)
  }
  const chineseList = /^[一二三四五六七八九十百千万]+、\s*(.+)$/u.exec(text)
  if (chineseList !== null) return nonEmptyHeading(1, chineseList[1]!)
  return null
}

function nonEmptyHeading(level: number, value: string): { level: number; title: string } | null {
  const title = value.trim()
  return title.length === 0 ? null : { level, title }
}

function weightedMedianFontHeight(
  items: ProjectedItem[],
  signal: AbortSignal,
): number | null {
  const samples: Array<{ value: number; weight: number }> = []
  for (let index = 0; index < items.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const item = items[index]!
    if (item.structural && item.text.length > 0) {
      samples.push({ value: item.fontHeight, weight: item.text.length })
    }
  }
  if (samples.length < 2) return null
  signal.throwIfAborted()
  samples.sort((left, right) => left.value - right.value)
  signal.throwIfAborted()
  let total = 0
  for (let index = 0; index < samples.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    total += samples[index]!.weight
  }
  let cumulative = 0
  for (let index = 0; index < samples.length; index += 1) {
    if (index % 1_024 === 0) signal.throwIfAborted()
    const sample = samples[index]!
    cumulative += sample.weight
    if (cumulative * 2 >= total) return sample.value
  }
  return samples.at(-1)?.value ?? null
}

function projectedViewportBounds(
  flow: readonly [number, number],
  viewport: PageViewport,
): { minimum: number; maximum: number } {
  const values = [
    dot([0, 0], flow),
    dot([viewport.width, 0], flow),
    dot([0, viewport.height], flow),
    dot([viewport.width, viewport.height], flow),
  ]
  return range(values)
}

function numericMedian(values: number[], signal?: AbortSignal): number | null {
  if (values.length === 0) return null
  signal?.throwIfAborted()
  const sorted = [...values]
  sorted.sort((left, right) => left - right)
  signal?.throwIfAborted()
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function projectTextItem(
  item: TextItem,
  style: TextStyle | undefined,
  viewport: PageViewport,
  pageNumber: number,
  itemIndex: number,
  lineHint: number,
  signal: AbortSignal,
): ProjectedItem | null {
  validateTextItem(item)
  const text = canonicalizePdfText(item.str, signal)
  signal.throwIfAborted()
  const trimmed = text.trim()
  signal.throwIfAborted()
  if (trimmed.length === 0) return null

  const matrix = Util.transform(viewport.transform, item.transform) as unknown
  if (!isFiniteMatrix(matrix)) invalidPdf('PDF text transformation matrix is invalid')
  const flowLength = Math.hypot(matrix[0], matrix[1])
  const fontHeight = Math.hypot(matrix[2], matrix[3])
  const viewportScale = Math.hypot(viewport.transform[0]!, viewport.transform[1]!)
  if (!Number.isFinite(flowLength) || flowLength <= 0 ||
      !Number.isFinite(fontHeight) || fontHeight <= 0 ||
      !Number.isFinite(viewportScale) || viewportScale <= 0) {
    invalidPdf('PDF text geometry is degenerate')
  }
  const flow: readonly [number, number] = [matrix[0] / flowLength, matrix[1] / flowLength]
  const up: readonly [number, number] = [matrix[2] / fontHeight, matrix[3] / fontHeight]
  const advance = item.width * viewportScale
  if (!Number.isFinite(advance) || advance < 0) invalidPdf('PDF text advance is invalid')
  const origin: readonly [number, number] = [matrix[4], matrix[5]]
  const region = normalizedRegion(
    pageNumber,
    origin,
    flow,
    up,
    advance,
    fontHeight,
    style,
    viewport,
  )
  return {
    text,
    itemIndex,
    origin,
    flow,
    up,
    advance,
    fontHeight,
    structural: item.dir === 'ltr' && style?.vertical !== true,
    region,
    lineHint,
  }
}

function normalizedRegion(
  page: number,
  origin: readonly [number, number],
  flow: readonly [number, number],
  up: readonly [number, number],
  advance: number,
  fontHeight: number,
  style: TextStyle | undefined,
  viewport: PageViewport,
): PdfBlockSource | null {
  const { ascent, descent } = safeFontMetrics(style)
  const corners: Array<readonly [number, number]> = []
  for (const along of [0, advance]) {
    for (const vertical of [descent * fontHeight, ascent * fontHeight]) {
      corners.push([
        origin[0] + flow[0] * along + up[0] * vertical,
        origin[1] + flow[1] * along + up[1] * vertical,
      ])
    }
  }
  if (corners.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    invalidPdf('PDF text bounding box is invalid')
  }
  const left = Math.max(0, Math.min(...corners.map(([x]) => x)))
  const top = Math.max(0, Math.min(...corners.map(([, y]) => y)))
  const right = Math.min(viewport.width, Math.max(...corners.map(([x]) => x)))
  const bottom = Math.min(viewport.height, Math.max(...corners.map(([, y]) => y)))
  if (right <= left || bottom <= top) return null

  const x = round6(left / viewport.width)
  const y = round6(top / viewport.height)
  const width = Math.min(round6((right - left) / viewport.width), round6(1 - x))
  const height = Math.min(round6((bottom - top) / viewport.height), round6(1 - y))
  if (width <= 0 || height <= 0) return null
  return { kind: 'pdf', page, bbox: { x, y, width, height } }
}

function appendDrafts(
  assembly: DocumentAssembly,
  drafts: BlockDraft[],
  limits: ParserLimits,
  signal: AbortSignal,
): void {
  for (const draft of drafts) {
    signal.throwIfAborted()
    if (draft.text.length === 0) continue
    if (assembly.blocks.length >= limits.maxDocumentBlocks) {
      resourceLimit('PDF exceeds the configured block limit')
    }
    if (draft.spans.length > limits.maxSourceSpans - assembly.sourceSpanCount) {
      resourceLimit('PDF exceeds the configured source-span limit')
    }
    const separatorUnits = assembly.blocks.length === 0 ? 0 : 1
    if (draft.text.length + separatorUnits > limits.maxCanonicalTextUnits - assembly.canonicalUnits) {
      resourceLimit('PDF exceeds the configured canonical text limit')
    }

    const textStart = assembly.canonicalUnits + separatorUnits
    if (draft.heading !== undefined) {
      applyHeading(assembly.sections, draft.heading)
    }
    const sectionPath = [...assembly.sections]
    const sourceSpans: DocumentSourceSpan[] = []
    for (let spanIndex = 0; spanIndex < draft.spans.length; spanIndex += 1) {
      if (spanIndex % 1_024 === 0) signal.throwIfAborted()
      const span = draft.spans[spanIndex]!
      sourceSpans.push({
        textStart: textStart + span.textStart,
        textEnd: textStart + span.textEnd,
        source: span.source,
      })
    }
    assembly.blocks.push({
      kind: draft.kind,
      text: draft.text,
      textStart,
      textEnd: textStart + draft.text.length,
      sectionPath,
      sourceSpans,
    })
    assembly.canonicalParts.push(draft.text)
    assembly.canonicalUnits = textStart + draft.text.length
    assembly.sourceSpanCount += draft.spans.length
  }
}

function applyHeading(sections: string[], heading: { level: number; title: string }): void {
  const level = Math.max(1, Math.min(9, heading.level))
  if (level <= sections.length + 1) sections.length = level - 1
  sections.push(heading.title)
}

function validateViewport(viewport: PageViewport): void {
  if (!Number.isFinite(viewport.width) || viewport.width <= 0 ||
      !Number.isFinite(viewport.height) || viewport.height <= 0 ||
      !isFiniteMatrix(viewport.transform)) {
    invalidPdf('PDF viewport is invalid')
  }
}

function validateTextItem(item: TextItem): void {
  if (typeof item.str !== 'string' || typeof item.dir !== 'string' ||
      typeof item.fontName !== 'string' || typeof item.hasEOL !== 'boolean' ||
      !Number.isFinite(item.width) || item.width < 0 ||
      !Number.isFinite(item.height) || item.height < 0 ||
      !isFiniteMatrix(item.transform)) {
    invalidPdf('PDF text item is invalid')
  }
}

function isTextItem(value: TextContent['items'][number] | undefined): value is TextItem {
  return typeof value === 'object' && value !== null && 'str' in value
}

function isFiniteMatrix(value: unknown): value is [number, number, number, number, number, number] {
  return Array.isArray(value) && value.length === 6 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
}

function safeFontMetrics(style: TextStyle | undefined): { ascent: number; descent: number } {
  const ascent = style?.ascent
  const descent = style?.descent
  if (typeof ascent === 'number' && Number.isFinite(ascent) && ascent > 0 && ascent <= 2 &&
      typeof descent === 'number' && Number.isFinite(descent) && descent >= -1 && descent <= 0 &&
      ascent - descent <= 3) {
    return { ascent, descent }
  }
  return { ascent: 0.8, descent: -0.2 }
}

function canonicalizePdfText(value: string, signal: AbortSignal): string {
  if (containsUnpairedSurrogate(value, signal)) {
    invalidPdf('PDF text contains an unpaired surrogate')
  }
  signal.throwIfAborted()
  const lineNormalized = value.replace(/\r\n?/gu, '\n')
  signal.throwIfAborted()
  const canonical = lineNormalized.normalize('NFC')
  signal.throwIfAborted()
  if (containsUnpairedSurrogate(canonical, signal)) {
    invalidPdf('PDF text contains an unpaired surrogate')
  }
  return canonical
}

function containsUnpairedSurrogate(value: string, signal: AbortSignal): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (index % 16_384 === 0) signal.throwIfAborted()
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  signal.throwIfAborted()
  return false
}

function round6(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000
  return Object.is(rounded, -0) ? 0 : rounded
}

async function awaitPdfJs<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    const value = await promise
    signal.throwIfAborted()
    return value
  } catch (error) {
    throwPdfJsError(error, signal)
  }
}

function throwPdfJsError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw signal.reason
  if (error instanceof ParserError) throw error
  if (errorName(error) === 'PasswordException') {
    throw new ParserError('PDF_ENCRYPTED', 'Encrypted PDF documents are not supported')
  }
  throw new ParserError(
    'INVALID_PDF',
    error instanceof Error ? error.message : 'PDF.js could not read the document',
  )
}

function normalizeExtractorError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  if (error instanceof ParserError) return error
  return new ParserError(
    'PARSER_WORKER_FAILED',
    error instanceof Error ? error.message : 'PDF parser failed unexpectedly',
  )
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const name = Reflect.get(error, 'name')
  return typeof name === 'string' ? name : undefined
}

function cleanupPage(page: PDFPageProxy): void {
  try {
    page.cleanup()
  } catch {
    // Loading-task destruction remains the authoritative cleanup path.
  }
}

function invalidPdf(message: string): never {
  throw new ParserError('INVALID_PDF', message)
}

function resourceLimit(message: string): never {
  throw new ParserError('DOCUMENT_RESOURCE_LIMIT_EXCEEDED', message)
}
