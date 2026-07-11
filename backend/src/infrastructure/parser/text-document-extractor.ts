import { canonicalizeSourceText } from '../../domain/source-locator.js'
import { hasRequirementSignal, hasSentenceDelimiter } from './deterministic-requirement-extractor.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  normalizeParserLimits,
  validateParsedDocument,
  type DocumentBlock,
  type ParsedDocument,
  type ParserLimits,
} from './parser-types.js'

interface SectionEntry {
  level: number
  title: string
}

interface HeadingMatch {
  level: number
  title: string
}

export class TextDocumentExtractor {
  private readonly limits: ParserLimits

  constructor(limits: ParserLimits = DEFAULT_PARSER_LIMITS) {
    this.limits = normalizeParserLimits(limits)
  }

  extract(content: Uint8Array, signal: AbortSignal): ParsedDocument {
    signal.throwIfAborted()
    if (content.byteLength > this.limits.maxInputBytes) {
      throw new ParserError(
        'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
        'Document input exceeds the configured byte limit',
      )
    }

    const decoded = decodeStrictUtf8(content)
    const canonicalText = canonicalizeSourceText(decoded)
    if (canonicalText.length > this.limits.maxCanonicalTextUnits) {
      throw new ParserError(
        'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
        'Canonical document text exceeds the configured UTF-16 limit',
      )
    }

    const blocks: DocumentBlock[] = []
    const sections: SectionEntry[] = []
    let textStart = 0
    let line = 1
    for (let cursor = 0; cursor <= canonicalText.length; cursor += 1) {
      if (cursor % 16_384 === 0) signal.throwIfAborted()
      if (cursor < canonicalText.length && canonicalText[cursor] !== '\n') continue
      const textEnd = cursor
      if (textEnd > textStart) {
        if (blocks.length >= this.limits.maxDocumentBlocks) {
          throw new ParserError(
            'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
            'Document exceeds the configured block limit',
          )
        }
        if (blocks.length >= this.limits.maxSourceSpans) {
          throw new ParserError(
            'DOCUMENT_RESOURCE_LIMIT_EXCEEDED',
            'Document exceeds the configured source-span limit',
          )
        }
        const text = canonicalText.slice(textStart, textEnd)
        const heading = matchHeading(text)
        if (heading) {
          while (sections.length > 0 && sections[sections.length - 1]!.level >= heading.level) {
            sections.pop()
          }
          sections.push(heading)
        }
        blocks.push({
          kind: heading ? 'heading' : 'paragraph',
          text,
          textStart,
          textEnd,
          sectionPath: sections.map((entry) => entry.title),
          sourceSpans: [{
            textStart,
            textEnd,
            source: {
              kind: 'txt',
              start: { line, column: 0 },
              end: { line, column: text.length },
            },
          }],
        })
      }
      textStart = cursor + 1
      line += 1
    }

    return validateParsedDocument({ format: 'txt', canonicalText, blocks }, this.limits, signal)
  }
}

export function extractTextDocument(
  content: Uint8Array,
  signal: AbortSignal,
  limits: ParserLimits = DEFAULT_PARSER_LIMITS,
): ParsedDocument {
  return new TextDocumentExtractor(limits).extract(content, signal)
}

function decodeStrictUtf8(content: Uint8Array): string {
  if ((content[0] === 0xff && content[1] === 0xfe) ||
      (content[0] === 0xfe && content[1] === 0xff)) {
    throw invalidEncoding()
  }
  const startsWithUtf8Bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  const bytes = startsWithUtf8Bom ? content.subarray(3) : content
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw invalidEncoding()
  }
}

function invalidEncoding(): ParserError {
  return new ParserError('INVALID_TEXT_ENCODING', 'TXT input must be strictly encoded as UTF-8')
}

function matchHeading(text: string): HeadingMatch | null {
  if (text.length > 120 || hasRequirementSignal(text) || hasSentenceDelimiter(text)) return null

  const markdown = /^(#{1,6})[\t ]+(.+)$/u.exec(text)
  if (markdown) return nonEmptyHeading(markdown[1]!.length, markdown[2]!)

  const chineseSection = /^第[零〇一二三四五六七八九十百千万两0-9]+([章节])[\t \u3000]*(.+)$/u.exec(text)
  if (chineseSection) return nonEmptyHeading(chineseSection[1] === '章' ? 1 : 2, chineseSection[2]!)

  const decimal = /^(\d+(?:\.\d+)*)[\t \u3000]+(.+)$/u.exec(text)
  if (decimal) return nonEmptyHeading(decimal[1]!.split('.').length, decimal[2]!)

  const chineseList = /^[一二三四五六七八九十百]+、[\t \u3000]*(.+)$/u.exec(text)
  if (chineseList) return nonEmptyHeading(1, chineseList[1]!)
  return null
}

function nonEmptyHeading(level: number, title: string): HeadingMatch | null {
  return title.trim().length === 0 ? null : { level, title }
}
