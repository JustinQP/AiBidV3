import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from '@zip.js/zip.js'
import { XMLParser } from 'fast-xml-parser'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  normalizeParserLimits,
  validateParsedDocument,
  type DocumentBlock,
  type ParsedDocument,
  type ParserLimits,
} from './parser-types.js'

const REQUIRED_XML_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
] as const
const OPTIONAL_XML_PARTS = ['word/styles.xml', 'word/numbering.xml'] as const
const SELECTED_XML_PARTS = new Set<string>([...REQUIRED_XML_PARTS, ...OPTIONAL_XML_PARTS])

type OrderedNode = Record<string, unknown>
type OrderedNodes = OrderedNode[]

interface ArchiveParts {
  entries: Map<string, FileEntry>
  xml: Map<string, OrderedNodes>
}

interface XmlElement {
  name: string
  children: OrderedNodes
  attributes: Record<string, string>
  namespaces: ReadonlyMap<string, string>
  parentNamespaces: ReadonlyMap<string, string>
}

interface WordXml {
  root: XmlElement
}

const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types'
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships'
const WORDPROCESSINGML_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
])
const WORD_2010_NAMESPACE = 'http://schemas.microsoft.com/office/word/2010/wordml'
const OFFICE_DOCUMENT_RELATIONSHIPS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
])
const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

export class DocxDocumentExtractor {
  private readonly limits: ParserLimits

  constructor(limits: ParserLimits = DEFAULT_PARSER_LIMITS) {
    this.limits = normalizeParserLimits(limits)
  }

  async extract(content: Uint8Array, signal: AbortSignal): Promise<ParsedDocument> {
    signal.throwIfAborted()
    if (content.byteLength > this.limits.maxInputBytes) {
      resourceLimit('DOCX input exceeds the configured byte limit')
    }
    const reader = new ZipReader(new Uint8ArrayReader(content), {
      checkSignature: true,
      checkOverlappingEntry: true,
      useWebWorkers: false,
      signal,
    })
    let document: ParsedDocument | undefined
    let primaryError: unknown
    let closeError: unknown
    try {
      const archive = await readArchive(reader, content, this.limits, signal)
      document = buildParsedDocument(archive, this.limits, signal)
    } catch (error) {
      primaryError = mapDocxError(error, signal)
    } finally {
      try {
        await reader.close()
      } catch (error) {
        closeError = error
      }
    }
    if (primaryError !== undefined) throw primaryError
    if (closeError !== undefined) throw mapDocxError(closeError, signal)
    if (document === undefined) invalidDocx('DOCX parser produced no document')
    return document
  }
}

async function readArchive(
  reader: ZipReader<Uint8Array>,
  content: Uint8Array,
  limits: ParserLimits,
  signal: AbortSignal,
): Promise<ArchiveParts> {
  const entries = new Map<string, FileEntry>()
  const canonicalPaths = new Set<string>()
  const files: FileEntry[] = []
  let count = 0
  let totalExpandedBytes = 0
  let minimumOffset = Number.POSITIVE_INFINITY

  for await (const entry of reader.getEntriesGenerator()) {
    signal.throwIfAborted()
    count += 1
    if (count > limits.maxDocxEntries) {
      resourceLimit('DOCX archive exceeds the configured entry-count limit')
    }
    validateArchiveNumber(entry.offset, 'entry offset')
    validateArchiveNumber(entry.compressedSize, 'compressed size')
    validateArchiveNumber(entry.uncompressedSize, 'uncompressed size')
    validateLocalHeader(entry, content, limits)
    if (entry.rawFilename.length > limits.maxDocxRawFilenameBytes) {
      resourceLimit('DOCX entry filename exceeds the configured byte limit')
    }
    validateRawEntryPath(entry.rawFilename, entry.directory)
    const canonicalPath = validateEntryPath(entry.filename, entry.directory)
    if (canonicalPaths.has(canonicalPath)) {
      invalidDocx('DOCX archive contains duplicate canonical entry paths')
    }
    canonicalPaths.add(canonicalPath)
    if (entry.encrypted) invalidDocx('Encrypted DOCX archive entries are not supported')
    if (entry.uncompressedSize > limits.maxDocxExpandedBytes - totalExpandedBytes) {
      resourceLimit('DOCX archive exceeds the configured expansion limit')
    }
    totalExpandedBytes += entry.uncompressedSize
    if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
      resourceLimit('DOCX entry declares output without compressed input')
    }
    if (entry.uncompressedSize >= limits.minDocxCompressionRatioBytes &&
        entry.uncompressedSize / entry.compressedSize > limits.maxDocxCompressionRatio) {
      resourceLimit('DOCX entry exceeds the configured compression ratio')
    }
    minimumOffset = Math.min(minimumOffset, entry.offset)
    if (!entry.directory) {
      entries.set(canonicalPath, entry)
      files.push(entry)
    }
  }

  if (count === 0 || minimumOffset !== 0) {
    invalidDocx('DOCX archive must start with a local entry header at offset zero')
  }
  for (const entry of [...files].sort((left, right) => left.offset - right.offset)) {
    signal.throwIfAborted()
    await entry.getData(new Uint8ArrayWriter(), {
      checkOverlappingEntryOnly: true,
      signal,
    })
  }

  for (const required of REQUIRED_XML_PARTS) {
    if (!entries.has(required)) invalidDocx(`DOCX archive is missing ${required}`)
  }
  for (const path of entries.keys()) {
    if (path.toLowerCase() === 'word/vbaproject.bin') {
      invalidDocx('Macro-enabled DOCX payloads are not supported')
    }
  }

  let selectedXmlBytes = 0
  for (const path of SELECTED_XML_PARTS) {
    const entry = entries.get(path)
    if (entry === undefined) continue
    if (entry.uncompressedSize > limits.maxDocxSelectedXmlBytes - selectedXmlBytes) {
      resourceLimit('DOCX selected XML exceeds the configured expansion limit')
    }
    selectedXmlBytes += entry.uncompressedSize
  }

  const xml = new Map<string, OrderedNodes>()
  for (const path of SELECTED_XML_PARTS) {
    signal.throwIfAborted()
    const entry = entries.get(path)
    if (entry === undefined) continue
    const bytes = await entry.getData(new Uint8ArrayWriter(), {
      checkSignature: true,
      checkOverlappingEntry: true,
      signal,
    })
    xml.set(path, parseXml(bytes, limits, signal))
  }
  return { entries, xml }
}

function validateArchiveNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidDocx(`DOCX archive ${label} is invalid`)
  }
}

interface RuntimeBitFlag {
  dataDescriptor: boolean
  languageEncodingFlag: boolean
}

function validateLocalHeader(
  entry: Entry,
  content: Uint8Array,
  limits: ParserLimits,
): void {
  if (entry.offset > content.byteLength - 30) invalidDocx('DOCX local entry header is truncated')
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength)
  if (view.getUint32(entry.offset, true) !== 0x04034b50) {
    invalidDocx('DOCX local entry header signature is invalid')
  }
  const flags = view.getUint16(entry.offset + 6, true)
  const method = view.getUint16(entry.offset + 8, true)
  const signature = view.getUint32(entry.offset + 14, true)
  const compressedSize32 = view.getUint32(entry.offset + 18, true)
  const uncompressedSize32 = view.getUint32(entry.offset + 22, true)
  const filenameLength = view.getUint16(entry.offset + 26, true)
  const extraLength = view.getUint16(entry.offset + 28, true)
  const filenameStart = entry.offset + 30
  const extraStart = filenameStart + filenameLength
  const dataStart = extraStart + extraLength
  if (filenameLength > limits.maxDocxRawFilenameBytes) {
    resourceLimit('DOCX local entry filename exceeds the configured byte limit')
  }
  if (dataStart > content.byteLength || entry.compressedSize > content.byteLength - dataStart) {
    invalidDocx('DOCX local entry data range is invalid')
  }
  const localFilename = content.subarray(filenameStart, extraStart)
  if (!sameBytes(localFilename, entry.rawFilename)) {
    invalidDocx('DOCX local and central entry filenames do not match')
  }
  if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
    invalidDocx('Encrypted DOCX local entries are not supported')
  }
  if (method !== entry.compressionMethod) {
    invalidDocx('DOCX local and central compression methods do not match')
  }
  const bitFlag = runtimeBitFlag(entry)
  const hasDataDescriptor = (flags & 0x8) !== 0
  const usesUtf8Filename = (flags & 0x800) !== 0
  if (hasDataDescriptor !== bitFlag.dataDescriptor ||
      usesUtf8Filename !== bitFlag.languageEncodingFlag) {
    invalidDocx('DOCX local and central entry flags do not match')
  }

  const localExtra = content.subarray(extraStart, dataStart)
  const localSizes = localHeaderSizes(localExtra, compressedSize32, uncompressedSize32)
  if (hasDataDescriptor) {
    if (signature !== 0 && signature !== entry.signature) {
      invalidDocx('DOCX local and central entry signatures do not match')
    }
    if ((localSizes.compressed !== 0 && localSizes.compressed !== entry.compressedSize) ||
        (localSizes.uncompressed !== 0 && localSizes.uncompressed !== entry.uncompressedSize)) {
      invalidDocx('DOCX local and central entry sizes do not match')
    }
  } else if (signature !== entry.signature ||
      localSizes.compressed !== entry.compressedSize ||
      localSizes.uncompressed !== entry.uncompressedSize) {
    invalidDocx('DOCX local and central entry metadata does not match')
  }
}

function runtimeBitFlag(entry: Entry): RuntimeBitFlag {
  const candidate = (entry as Entry & { bitFlag?: unknown }).bitFlag
  if (typeof candidate !== 'object' || candidate === null) {
    invalidDocx('DOCX central entry flags are unavailable')
  }
  const dataDescriptor = Reflect.get(candidate, 'dataDescriptor')
  const languageEncodingFlag = Reflect.get(candidate, 'languageEncodingFlag')
  if (typeof dataDescriptor !== 'boolean' || typeof languageEncodingFlag !== 'boolean') {
    invalidDocx('DOCX central entry flags are invalid')
  }
  return { dataDescriptor, languageEncodingFlag }
}

function localHeaderSizes(
  extra: Uint8Array,
  compressedSize32: number,
  uncompressedSize32: number,
): { compressed: number; uncompressed: number } {
  let compressed = compressedSize32
  let uncompressed = uncompressedSize32
  if (compressed !== 0xffffffff && uncompressed !== 0xffffffff) {
    return { compressed, uncompressed }
  }
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength)
  let offset = 0
  while (offset <= extra.byteLength - 4) {
    const type = view.getUint16(offset, true)
    const size = view.getUint16(offset + 2, true)
    const dataStart = offset + 4
    const dataEnd = dataStart + size
    if (dataEnd > extra.byteLength) invalidDocx('DOCX local extra field is malformed')
    if (type === 0x0001) {
      let cursor = dataStart
      if (uncompressed === 0xffffffff) {
        uncompressed = safeZip64Value(view, cursor, dataEnd)
        cursor += 8
      }
      if (compressed === 0xffffffff) compressed = safeZip64Value(view, cursor, dataEnd)
      return { compressed, uncompressed }
    }
    offset = dataEnd
  }
  invalidDocx('DOCX ZIP64 local sizes are missing')
}

function safeZip64Value(view: DataView, offset: number, end: number): number {
  if (offset > end - 8) invalidDocx('DOCX ZIP64 local size is truncated')
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalidDocx('DOCX ZIP64 local size is unsafe')
  return Number(value)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function validateEntryPath(filename: string, directory: boolean): string {
  const path = directory && filename.endsWith('/') ? filename.slice(0, -1) : filename
  if (path.length === 0 || containsControlCharacter(path) || path.includes('\\') ||
      path.startsWith('/') || /^[A-Za-z]:/u.test(path)) {
    invalidDocx('DOCX archive contains an unsafe entry path')
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    invalidDocx('DOCX archive contains an unsafe entry path segment')
  }
  return path.normalize('NFC')
}

function validateRawEntryPath(rawFilename: Uint8Array, directory: boolean): void {
  const end = directory && rawFilename.at(-1) === 0x2f
    ? rawFilename.length - 1
    : rawFilename.length
  if (end === 0 || rawFilename[0] === 0x2f ||
      (end >= 2 && isAsciiLetter(rawFilename[0]!) && rawFilename[1] === 0x3a)) {
    invalidDocx('DOCX archive contains an unsafe raw entry path')
  }
  let segmentStart = 0
  for (let index = 0; index <= end; index += 1) {
    const byte = rawFilename[index]
    if (index < end && (byte! <= 0x1f || byte === 0x7f || byte === 0x5c)) {
      invalidDocx('DOCX archive contains unsafe raw entry path bytes')
    }
    if (index === end || byte === 0x2f) {
      const length = index - segmentStart
      if (length === 0 ||
          (length === 1 && rawFilename[segmentStart] === 0x2e) ||
          (length === 2 && rawFilename[segmentStart] === 0x2e &&
            rawFilename[segmentStart + 1] === 0x2e)) {
        invalidDocx('DOCX archive contains an unsafe raw entry path segment')
      }
      segmentStart = index + 1
    }
  }
}

function isAsciiLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function parseXml(bytes: Uint8Array, limits: ParserLimits, signal: AbortSignal): OrderedNodes {
  const text = decodeXml(bytes)
  if (/<!DOCTYPE(?:\s|>)/iu.test(text)) invalidDocx('DOCX XML must not contain a DOCTYPE')
  inspectXmlBounds(text, limits, signal)
  try {
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      removeNSPrefix: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: {
        enabled: true,
        maxEntitySize: limits.maxXmlEntitySize,
        maxExpansionDepth: limits.maxXmlEntityExpansionDepth,
        maxTotalExpansions: limits.maxXmlEntityExpansions,
        maxExpandedLength: limits.maxXmlEntityExpandedUnits,
        maxEntityCount: limits.maxXmlEntityDefinitions,
      },
      maxNestedTags: limits.maxXmlNestingDepth,
    })
    const parsed: unknown = parser.parse(text, true)
    if (!Array.isArray(parsed)) invalidDocx('DOCX XML root is invalid')
    return parsed as OrderedNodes
  } catch (error) {
    if (error instanceof ParserError) throw error
    if (error instanceof Error && /(?:limit exceeded|max(?:imum)? (?:entity|nested))/iu.test(error.message)) {
      resourceLimit('DOCX XML exceeds the configured entity or nesting limit')
    }
    invalidDocx('DOCX XML is malformed')
  }
}

function decodeXml(bytes: Uint8Array): string {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be'
  let offset = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8'
    offset = 3
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le'
    offset = 2
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be'
    offset = 2
  } else if (bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) {
    encoding = 'utf-16le'
  } else if (bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) {
    encoding = 'utf-16be'
  } else {
    encoding = 'utf-8'
  }

  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset))
  } catch {
    invalidDocx('DOCX XML encoding is malformed')
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const declaration = /^<\?xml\s+([^?]*)\?>/iu.exec(text)
  const declaredEncoding = declaration?.[1]
    ? /\bencoding\s*=\s*(["'])([^"']+)\1/iu.exec(declaration[1])?.[2]?.toLowerCase()
    : undefined
  if (declaredEncoding !== undefined) {
    const compatible = encoding === 'utf-8'
      ? declaredEncoding === 'utf-8'
      : declaredEncoding === 'utf-16' || declaredEncoding === encoding
    if (!compatible) invalidDocx('DOCX XML declares an unsupported or mismatched encoding')
  }
  return text
}

function inspectXmlBounds(text: string, limits: ParserLimits, signal: AbortSignal): void {
  let entityExpansions = 0
  let expandedUnits = 0
  const inspectEntities = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if ((index - start) % 16_384 === 0) signal.throwIfAborted()
      if (text.charCodeAt(index) !== 0x26) continue
      const reference = entityReferenceAt(text, index, end)
      if (reference === null) continue
      entityExpansions += 1
      if (entityExpansions > limits.maxXmlEntityExpansions) {
        resourceLimit('DOCX XML exceeds the configured entity-expansion limit')
      }
      expandedUnits += reference.units
      if (expandedUnits > limits.maxXmlEntityExpandedUnits) {
        resourceLimit('DOCX XML exceeds the configured expanded-entity length')
      }
      index = reference.end - 1
    }
  }

  let depth = 0
  let index = 0
  while (index < text.length) {
    signal.throwIfAborted()
    const open = text.indexOf('<', index)
    if (open < 0) {
      inspectEntities(index, text.length)
      break
    }
    inspectEntities(index, open)
    if (text.startsWith('<!--', open)) {
      index = requiredEnd(text, '-->', open + 4)
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      index = requiredEnd(text, ']]>', open + 9)
      continue
    }
    if (text.startsWith('<?', open)) {
      index = requiredEnd(text, '?>', open + 2)
      continue
    }
    const end = tagEnd(text, open + 1)
    inspectEntities(open, end + 1)
    if (text[open + 1] === '/') {
      depth = Math.max(0, depth - 1)
    } else if (text[open + 1] !== '!' && text.slice(open, end).trimEnd().at(-1) !== '/') {
      depth += 1
      if (depth > limits.maxXmlNestingDepth) {
        resourceLimit('DOCX XML exceeds the configured nesting limit')
      }
    }
    index = end + 1
  }
}

function entityReferenceAt(
  text: string,
  ampersand: number,
  end: number,
): { end: number; units: number } | null {
  let index = ampersand + 1
  if (index >= end) return null
  let numeric = false
  let hexadecimal = false
  if (text.charCodeAt(index) === 0x23) {
    numeric = true
    index += 1
    if (index < end && (text.charCodeAt(index) === 0x78 || text.charCodeAt(index) === 0x58)) {
      hexadecimal = true
      index += 1
    }
  }
  const valueStart = index
  let numericValue = 0
  for (; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x3b) {
      if (index === valueStart) return null
      return { end: index + 1, units: numeric && numericValue > 0xffff ? 2 : 1 }
    }
    if (numeric) {
      const digit = hexadecimal ? hexadecimalDigit(code) : decimalDigit(code)
      if (digit < 0) return null
      numericValue = Math.min(0x110000, numericValue * (hexadecimal ? 16 : 10) + digit)
    } else if ((index === valueStart && !isEntityNameStart(code)) ||
        (index !== valueStart && !isEntityNamePart(code))) {
      return null
    }
  }
  return null
}

function decimalDigit(code: number): number {
  return code >= 0x30 && code <= 0x39 ? code - 0x30 : -1
}

function hexadecimalDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10
  return -1
}

function isEntityNameStart(code: number): boolean {
  return isAsciiLetter(code) || code === 0x5f || code === 0x3a
}

function isEntityNamePart(code: number): boolean {
  return isEntityNameStart(code) || decimalDigit(code) >= 0 ||
    code === 0x2e || code === 0x2d
}

function requiredEnd(text: string, marker: string, start: number): number {
  const end = text.indexOf(marker, start)
  if (end < 0) invalidDocx('DOCX XML contains an unterminated construct')
  return end + marker.length
}

function tagEnd(text: string, start: number): number {
  let quote: string | null = null
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  invalidDocx('DOCX XML contains an unterminated tag')
}

function buildParsedDocument(
  archive: ArchiveParts,
  limits: ParserLimits,
  signal: AbortSignal,
): ParsedDocument {
  validateContentTypes(requiredXml(archive, '[Content_Types].xml'))
  validateRootRelationships(requiredXml(archive, '_rels/.rels'))
  const document = wordXml(requiredXml(archive, 'word/document.xml'), 'document')
  const styles = parseStyles(archive.xml.get('word/styles.xml'))
  const numbering = parseNumbering(archive.xml.get('word/numbering.xml'))
  return extractWordDocument(document, styles, numbering, limits, signal)
}

function requiredXml(archive: ArchiveParts, path: string): OrderedNodes {
  const xml = archive.xml.get(path)
  if (xml === undefined) invalidDocx(`DOCX archive is missing parsed XML for ${path}`)
  return xml
}

function validateContentTypes(nodes: OrderedNodes): void {
  const root = packageRoot(nodes, 'Types', CONTENT_TYPES_NAMESPACE)
  const packageElements = packageChildren(root, CONTENT_TYPES_NAMESPACE)
  const overrides = packageElements.filter((element) => localName(element.name) === 'Override')
  const mainOverrides = overrides.filter((element) =>
    packageAttribute(element, 'PartName') === '/word/document.xml'
  )
  const xmlDefaults = packageElements.filter((element) =>
    localName(element.name) === 'Default' &&
    packageAttribute(element, 'Extension')?.toLowerCase() === 'xml'
  )
  const effectiveMainType = mainOverrides.length === 1
    ? packageAttribute(mainOverrides[0]!, 'ContentType')
    : mainOverrides.length === 0 && xmlDefaults.length === 1
      ? packageAttribute(xmlDefaults[0]!, 'ContentType')
      : undefined
  if (effectiveMainType !== DOCX_MAIN_CONTENT_TYPE) {
    invalidDocx('DOCX package must declare the standard document main content type')
  }
  for (const element of packageElements) {
    const contentType = packageAttribute(element, 'ContentType')?.toLowerCase()
    if (contentType !== undefined &&
        /(?:macroenabled|vbaproject|\.template\.|application\/msword)/u.test(contentType)) {
      invalidDocx('DOCX package declares a macro, template, or legacy Word content type')
    }
  }
}

function validateRootRelationships(nodes: OrderedNodes): void {
  const root = packageRoot(nodes, 'Relationships', PACKAGE_RELATIONSHIPS_NAMESPACE)
  const officeRelationships = packageChildren(root, PACKAGE_RELATIONSHIPS_NAMESPACE).filter((element) =>
    localName(element.name) === 'Relationship' &&
    OFFICE_DOCUMENT_RELATIONSHIPS.has(packageAttribute(element, 'Type') ?? '')
  )
  if (officeRelationships.length !== 1) {
    invalidDocx('DOCX package must contain one root officeDocument relationship')
  }
  const relationship = officeRelationships[0]!
  const targetMode = packageAttribute(relationship, 'TargetMode')
  if ((targetMode !== undefined && targetMode.toLowerCase() !== 'internal') ||
      packageAttribute(relationship, 'Target') !== 'word/document.xml') {
    invalidDocx('DOCX main-document relationship must be internal and target word/document.xml')
  }
}

function packageChildren(root: XmlElement, namespace: string): XmlElement[] {
  return childElements(root).filter((child) => namespaceFor(child, prefixOf(child.name)) === namespace)
}

function packageRoot(nodes: OrderedNodes, expectedName: string, namespace: string): XmlElement {
  const root = singleRoot(nodes)
  if (localName(root.name) !== expectedName || namespaceFor(root, prefixOf(root.name)) !== namespace) {
    invalidDocx(`DOCX XML must have a ${expectedName} root in the expected namespace`)
  }
  return root
}

function wordXml(nodes: OrderedNodes, expectedRoot: string): WordXml {
  const root = singleRoot(nodes)
  const namespaces = root.namespaces
  const rootPrefix = prefixOf(root.name)
  if (localName(root.name) !== expectedRoot ||
      !WORDPROCESSINGML_NAMESPACES.has(namespaces.get(rootPrefix) ?? '')) {
    invalidDocx(`DOCX WordprocessingML must have a ${expectedRoot} root in a supported namespace`)
  }
  const xml = { root }
  validateWordPrefixBindings(xml)
  return xml
}

function validateWordPrefixBindings(xml: WordXml): void {
  const pending = [xml.root]
  while (pending.length > 0) {
    const element = pending.pop()!
    for (const [name, value] of Object.entries(element.attributes)) {
      const prefix = name === 'xmlns'
        ? ''
        : name.startsWith('xmlns:') ? name.slice('xmlns:'.length) : null
      const previousNamespace = prefix === null ? undefined : element.parentNamespaces.get(prefix)
      if (prefix !== null && previousNamespace !== undefined &&
          WORDPROCESSINGML_NAMESPACES.has(previousNamespace) &&
          !WORDPROCESSINGML_NAMESPACES.has(value)) {
        invalidDocx('DOCX XML rebinds a WordprocessingML namespace prefix')
      }
      if (prefix !== null && previousNamespace === WORD_2010_NAMESPACE &&
          value !== WORD_2010_NAMESPACE) {
        invalidDocx('DOCX XML rebinds the Word 2010 paragraph namespace prefix')
      }
    }
    pending.push(...childElements(element))
  }
}

function singleRoot(nodes: OrderedNodes): XmlElement {
  const elements = elementsOf(nodes)
  if (elements.length !== 1) invalidDocx('DOCX XML must contain exactly one document element')
  return elements[0]!
}

function elementsOf(
  nodes: OrderedNodes,
  inheritedNamespaces: ReadonlyMap<string, string> = new Map(),
): XmlElement[] {
  const elements: XmlElement[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue
    for (const [name, value] of Object.entries(node)) {
      if (name === ':@' || name.startsWith('#') || name.startsWith('?')) continue
      if (!Array.isArray(value)) invalidDocx('DOCX XML contains a malformed element')
      const rawAttributes = node[':@']
      const attributes: Record<string, string> = {}
      if (typeof rawAttributes === 'object' && rawAttributes !== null && !Array.isArray(rawAttributes)) {
        for (const [key, attributeValue] of Object.entries(rawAttributes)) {
          if (typeof attributeValue !== 'string') invalidDocx('DOCX XML attribute is malformed')
          attributes[key.startsWith('@_') ? key.slice(2) : key] = attributeValue
        }
      }
      const namespaces = new Map(inheritedNamespaces)
      for (const [attributeName, attributeValue] of Object.entries(attributes)) {
        if (attributeName === 'xmlns') namespaces.set('', attributeValue)
        else if (attributeName.startsWith('xmlns:')) {
          namespaces.set(attributeName.slice('xmlns:'.length), attributeValue)
        }
      }
      elements.push({
        name,
        children: value as OrderedNodes,
        attributes,
        namespaces,
        parentNamespaces: inheritedNamespaces,
      })
    }
  }
  return elements
}

function childElements(element: XmlElement): XmlElement[] {
  return elementsOf(element.children, element.namespaces)
}

function wordChildren(xml: WordXml, element: XmlElement, expectedName?: string): XmlElement[] {
  return childElements(element).filter((child) =>
    isWordElement(child) &&
    (expectedName === undefined || localName(child.name) === expectedName)
  )
}

function firstWordChild(xml: WordXml, element: XmlElement, expectedName: string): XmlElement | undefined {
  return wordChildren(xml, element, expectedName)[0]
}

function wordAttribute(
  element: XmlElement,
  expectedName: string,
): string | undefined {
  for (const [name, value] of Object.entries(element.attributes)) {
    const prefix = prefixOf(name)
    if (prefix !== '' && WORDPROCESSINGML_NAMESPACES.has(element.namespaces.get(prefix) ?? '') &&
        localName(name) === expectedName) return value
  }
  return undefined
}

function packageAttribute(element: XmlElement, expectedName: string): string | undefined {
  return element.attributes[expectedName]
}

function namespaceFor(element: XmlElement, prefix: string): string | undefined {
  return element.namespaces.get(prefix)
}

function isWordElement(element: XmlElement): boolean {
  return WORDPROCESSINGML_NAMESPACES.has(namespaceFor(element, prefixOf(element.name)) ?? '')
}

function prefixOf(name: string): string {
  const separator = name.indexOf(':')
  return separator < 0 ? '' : name.slice(0, separator)
}

function localName(name: string): string {
  const separator = name.indexOf(':')
  return separator < 0 ? name : name.slice(separator + 1)
}

interface StyleDefinition {
  basedOn: string | null
  outlineLevel: number | 'body' | null
  name: string | null
  numbering: ParagraphNumberingProperties | null
}

interface ParagraphNumberingProperties {
  numId: string | null
  levelIndex: number | null
}

interface NumberingLevel {
  start: number
  format: string
  text: string
}

interface NumberingLevelOverride {
  start: number | null
  level: NumberingLevel | null
}

interface NumberingInstance {
  abstractId: string
  overrides: Map<number, NumberingLevelOverride>
}

interface NumberingDefinition {
  nums: Map<string, NumberingInstance>
  abstracts: Map<string, Map<number, NumberingLevel>>
  counters: Map<string, Map<number, number>>
}

interface ExtractionState {
  blocks: DocumentBlock[]
  canonicalParts: string[]
  canonicalLength: number
  paragraphIndex: number
  sectionPath: string[]
  sourceSpanCount: number
}

function parseStyles(nodes: OrderedNodes | undefined): Map<string, StyleDefinition> {
  const styles = new Map<string, StyleDefinition>()
  if (nodes === undefined) return styles
  const xml = wordXml(nodes, 'styles')
  for (const style of wordChildren(xml, xml.root, 'style')) {
    const styleId = wordAttribute(style, 'styleId')
    if (styleId === undefined || styleId.length === 0 || styles.has(styleId)) continue
    const properties = firstWordChild(xml, style, 'pPr')
    const outline = properties === undefined
      ? null
      : outlineLevel(firstWordChild(xml, properties, 'outlineLvl'))
    styles.set(styleId, {
      basedOn: valueOf(firstWordChild(xml, style, 'basedOn')),
      outlineLevel: outline,
      name: valueOf(firstWordChild(xml, style, 'name')),
      numbering: paragraphNumberingProperties(xml, properties),
    })
  }
  return styles
}

function parseNumbering(nodes: OrderedNodes | undefined): NumberingDefinition {
  const definition: NumberingDefinition = {
    nums: new Map(),
    abstracts: new Map(),
    counters: new Map(),
  }
  if (nodes === undefined) return definition
  const xml = wordXml(nodes, 'numbering')
  for (const abstract of wordChildren(xml, xml.root, 'abstractNum')) {
    const abstractId = wordAttribute(abstract, 'abstractNumId')
    if (abstractId === undefined || definition.abstracts.has(abstractId)) continue
    const levels = new Map<number, NumberingLevel>()
    for (const level of wordChildren(xml, abstract, 'lvl')) {
      const levelIndex = nonNegativeDecimal(wordAttribute(level, 'ilvl'))
      const parsedLevel = parseNumberingLevel(xml, level)
      if (levelIndex === null || parsedLevel === null || levels.has(levelIndex)) continue
      levels.set(levelIndex, parsedLevel)
    }
    definition.abstracts.set(abstractId, levels)
  }
  for (const num of wordChildren(xml, xml.root, 'num')) {
    const numId = wordAttribute(num, 'numId')
    const abstractId = valueOf(firstWordChild(xml, num, 'abstractNumId'))
    if (numId !== undefined && abstractId !== null && !definition.nums.has(numId)) {
      const overrides = new Map<number, NumberingLevelOverride>()
      for (const override of wordChildren(xml, num, 'lvlOverride')) {
        const levelIndex = nonNegativeDecimal(wordAttribute(override, 'ilvl'))
        if (levelIndex === null || overrides.has(levelIndex)) continue
        overrides.set(levelIndex, {
          start: nonNegativeDecimal(valueOf(firstWordChild(xml, override, 'startOverride'))),
          level: parseNumberingLevel(xml, firstWordChild(xml, override, 'lvl')),
        })
      }
      definition.nums.set(numId, { abstractId, overrides })
    }
  }
  return definition
}

function parseNumberingLevel(
  xml: WordXml,
  level: XmlElement | undefined,
): NumberingLevel | null {
  if (level === undefined) return null
  const format = valueOf(firstWordChild(xml, level, 'numFmt'))
  const text = valueOf(firstWordChild(xml, level, 'lvlText'))
  if (format === null || text === null) return null
  return {
    start: nonNegativeDecimal(valueOf(firstWordChild(xml, level, 'start'))) ?? 1,
    format,
    text,
  }
}

function extractWordDocument(
  document: WordXml,
  styles: Map<string, StyleDefinition>,
  numbering: NumberingDefinition,
  limits: ParserLimits,
  signal: AbortSignal,
): ParsedDocument {
  const bodies = wordChildren(document, document.root, 'body')
  if (bodies.length !== 1) invalidDocx('DOCX document must contain exactly one body')
  const state: ExtractionState = {
    blocks: [],
    canonicalParts: [],
    canonicalLength: 0,
    paragraphIndex: 0,
    sectionPath: [],
    sourceSpanCount: 0,
  }
  traverseContainer(
    document,
    bodies[0]!.children,
    bodies[0]!.namespaces,
    [],
    false,
    { value: 0 },
    styles,
    numbering,
    limits,
    state,
    signal,
  )
  const parsed: ParsedDocument = {
    format: 'docx',
    canonicalText: state.canonicalParts.join('\n'),
    blocks: state.blocks,
  }
  return validateParsedDocument(parsed, limits, signal)
}

function traverseContainer(
  xml: WordXml,
  nodes: OrderedNodes,
  inheritedNamespaces: ReadonlyMap<string, string>,
  tablePath: Array<{ tableIndex: number; rowIndex: number; cellIndex: number }>,
  inTable: boolean,
  tableCounter: { value: number },
  styles: Map<string, StyleDefinition>,
  numbering: NumberingDefinition,
  limits: ParserLimits,
  state: ExtractionState,
  signal: AbortSignal,
): void {
  for (const element of elementsOf(nodes, inheritedNamespaces)) {
    signal.throwIfAborted()
    if (!isWordElement(element)) continue
    const name = localName(element.name)
    if (name === 'p') {
      appendParagraph(xml, element, tablePath, inTable, styles, numbering, limits, state, signal)
    } else if (name === 'tbl') {
      const tableIndex = tableCounter.value
      tableCounter.value += 1
      traverseTable(
        xml, element, tablePath, tableIndex, styles, numbering, limits, state, signal,
      )
    } else if (name === 'sdt') {
      const content = firstWordChild(xml, element, 'sdtContent')
      if (content !== undefined) {
        traverseContainer(
          xml, content.children, content.namespaces, tablePath, inTable, tableCounter,
          styles, numbering, limits, state, signal,
        )
      }
    } else if (name === 'customXml') {
      traverseContainer(
        xml, element.children, element.namespaces, tablePath, inTable, tableCounter,
        styles, numbering, limits, state, signal,
      )
    }
  }
}

function traverseTable(
  xml: WordXml,
  table: XmlElement,
  parentPath: Array<{ tableIndex: number; rowIndex: number; cellIndex: number }>,
  tableIndex: number,
  styles: Map<string, StyleDefinition>,
  numbering: NumberingDefinition,
  limits: ParserLimits,
  state: ExtractionState,
  signal: AbortSignal,
): void {
  const rows = permittedWrappedChildren(xml, table.children, table.namespaces, 'tr')
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    signal.throwIfAborted()
    const cells = permittedWrappedChildren(
      xml, rows[rowIndex]!.children, rows[rowIndex]!.namespaces, 'tc',
    )
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const path = [...parentPath, { tableIndex, rowIndex, cellIndex }]
      traverseContainer(
        xml,
        cells[cellIndex]!.children,
        cells[cellIndex]!.namespaces,
        path,
        true,
        { value: 0 },
        styles,
        numbering,
        limits,
        state,
        signal,
      )
    }
  }
}

function permittedWrappedChildren(
  xml: WordXml,
  nodes: OrderedNodes,
  inheritedNamespaces: ReadonlyMap<string, string>,
  expectedName: string,
): XmlElement[] {
  const matches: XmlElement[] = []
  for (const element of elementsOf(nodes, inheritedNamespaces)) {
    if (!isWordElement(element)) continue
    const name = localName(element.name)
    if (name === expectedName) {
      matches.push(element)
    } else if (name === 'sdt') {
      const content = firstWordChild(xml, element, 'sdtContent')
      if (content !== undefined) {
        matches.push(...permittedWrappedChildren(
          xml, content.children, content.namespaces, expectedName,
        ))
      }
    } else if (name === 'customXml') {
      matches.push(...permittedWrappedChildren(
        xml, element.children, element.namespaces, expectedName,
      ))
    }
  }
  return matches
}

function appendParagraph(
  xml: WordXml,
  paragraph: XmlElement,
  tablePath: Array<{ tableIndex: number; rowIndex: number; cellIndex: number }>,
  inTable: boolean,
  styles: Map<string, StyleDefinition>,
  numbering: NumberingDefinition,
  limits: ParserLimits,
  state: ExtractionState,
  signal: AbortSignal,
): void {
  const paragraphIndex = state.paragraphIndex
  state.paragraphIndex += 1
  const bodyText = visibleParagraphText(xml, paragraph, signal)
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
  const marker = numberingMarker(xml, paragraph, styles, numbering)
  if (bodyText.length === 0) return
  const markerPrefix = marker === null ? '' : `${marker}${/\s$/u.test(marker) ? '' : ' '}`
  const text = `${markerPrefix}${bodyText}`.normalize('NFC')
  const level = paragraphHeadingLevel(xml, paragraph, styles)
  let sectionPath = [...state.sectionPath]
  let kind: DocumentBlock['kind'] = inTable ? 'table-cell' : 'paragraph'
  if (level !== null) {
    kind = 'heading'
    sectionPath = [...state.sectionPath.slice(0, level - 1), text]
    if (!inTable) state.sectionPath = [...sectionPath]
  }

  if (state.blocks.length >= limits.maxDocumentBlocks) {
    resourceLimit('DOCX document exceeds the configured block limit')
  }
  if (state.sourceSpanCount >= limits.maxSourceSpans) {
    resourceLimit('DOCX document exceeds the configured source-span limit')
  }
  const separatorUnits = state.blocks.length === 0 ? 0 : 1
  if (text.length > limits.maxCanonicalTextUnits - state.canonicalLength - separatorUnits) {
    resourceLimit('DOCX canonical text exceeds the configured UTF-16 limit')
  }
  const textStart = state.canonicalLength + separatorUnits
  const textEnd = textStart + text.length
  const sourceStart = textStart + markerPrefix.length
  state.blocks.push({
    kind,
    text,
    textStart,
    textEnd,
    sectionPath,
    sourceSpans: [{
      textStart: sourceStart,
      textEnd,
      source: {
        kind: 'docx',
        paragraphId: paragraphId(paragraph),
        paragraphIndex,
        tablePath: tablePath.map((entry) => ({ ...entry })),
        charStart: 0,
        charEnd: bodyText.length,
      },
    }],
  })
  state.canonicalParts.push(text)
  state.canonicalLength = textEnd
  state.sourceSpanCount += 1
}

function visibleParagraphText(
  xml: WordXml,
  paragraph: XmlElement,
  signal: AbortSignal,
): string {
  const parts: string[] = []
  const visit = (
    nodes: OrderedNodes,
    inheritedNamespaces: ReadonlyMap<string, string>,
  ): void => {
    for (const element of elementsOf(nodes, inheritedNamespaces)) {
      signal.throwIfAborted()
      if (!isWordElement(element)) continue
      const name = localName(element.name)
      if (name === 'del' || name === 'delText' || name === 'instrText' || name === 'pPr') continue
      if (name === 't') {
        parts.push(textNodes(element.children))
      } else if (name === 'tab') {
        parts.push('\t')
      } else if (name === 'br' || name === 'cr') {
        parts.push('\n')
      } else {
        visit(element.children, element.namespaces)
      }
    }
  }
  visit(paragraph.children, paragraph.namespaces)
  return parts.join('')
}

function textNodes(nodes: OrderedNodes): string {
  let text = ''
  for (const node of nodes) {
    const value = node['#text']
    if (typeof value === 'string') text += value
  }
  return text
}

function paragraphHeadingLevel(
  xml: WordXml,
  paragraph: XmlElement,
  styles: Map<string, StyleDefinition>,
): number | null {
  const properties = firstWordChild(xml, paragraph, 'pPr')
  if (properties === undefined) return null
  const direct = outlineLevel(firstWordChild(xml, properties, 'outlineLvl'))
  if (direct !== null) return direct === 'body' ? null : direct + 1
  const styleId = valueOf(firstWordChild(xml, properties, 'pStyle'))
  if (styleId === null) return null

  const visited = new Set<string>()
  let current: string | null = styleId
  let fallback = headingNameLevel(styleId)
  while (current !== null && !visited.has(current)) {
    visited.add(current)
    const style = styles.get(current)
    if (style === undefined) break
    if (style.outlineLevel !== null) {
      return style.outlineLevel === 'body' ? null : style.outlineLevel + 1
    }
    fallback ??= headingNameLevel(style.name)
    fallback ??= headingNameLevel(current)
    current = style.basedOn
  }
  return fallback
}

function outlineLevel(
  element: XmlElement | undefined,
): number | 'body' | null {
  const level = nonNegativeDecimal(valueOf(element))
  if (level !== null && level <= 8) return level
  return level === 9 ? 'body' : null
}

function headingNameLevel(value: string | null): number | null {
  const match = /^Heading\s*([1-9])$/iu.exec(value ?? '')
  return match ? Number(match[1]) : null
}

function paragraphId(paragraph: XmlElement): string | null {
  for (const [name, value] of Object.entries(paragraph.attributes)) {
    if (localName(name) !== 'paraId') continue
    const prefix = prefixOf(name)
    if (paragraph.namespaces.get(prefix) === WORD_2010_NAMESPACE && /^[0-9a-f]{8}$/iu.test(value)) {
      return value.toUpperCase()
    }
  }
  return null
}

function valueOf(element: XmlElement | undefined): string | null {
  return element === undefined ? null : (wordAttribute(element, 'val') ?? null)
}

function nonNegativeDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function numberingMarker(
  xml: WordXml,
  paragraph: XmlElement,
  styles: Map<string, StyleDefinition>,
  numbering: NumberingDefinition,
): string | null {
  const properties = firstWordChild(xml, paragraph, 'pPr')
  const resolved = resolveParagraphNumbering(xml, properties, styles)
  const numId = resolved?.numId ?? null
  const levelIndex = resolved?.levelIndex ?? null
  if (numId === null || levelIndex === null) return null
  const instance = numbering.nums.get(numId)
  const levels = instance === undefined ? undefined : numbering.abstracts.get(instance.abstractId)
  const level = instance === undefined || levels === undefined
    ? undefined
    : resolvedNumberingLevel(instance, levels, levelIndex)
  if (instance === undefined || levels === undefined || level === undefined) return null

  let counters = numbering.counters.get(numId)
  if (counters === undefined) {
    counters = new Map()
    numbering.counters.set(numId, counters)
  }
  const next = counters.has(levelIndex) ? counters.get(levelIndex)! + 1 : level.start
  counters.set(levelIndex, next)
  for (const existingLevel of [...counters.keys()]) {
    if (existingLevel > levelIndex) counters.delete(existingLevel)
  }

  let unresolved = false
  const marker = level.text.replace(/%([1-9])/gu, (_placeholder, rawLevel: string) => {
    const referencedLevel = Number(rawLevel) - 1
    const referencedDefinition = resolvedNumberingLevel(instance, levels, referencedLevel)
    const value = counters.get(referencedLevel)
    if (referencedDefinition === undefined || value === undefined) {
      unresolved = true
      return ''
    }
    const formatted = formatCounter(value, referencedDefinition.format)
    if (formatted === null) {
      unresolved = true
      return ''
    }
    return formatted
  }).normalize('NFC')
  if (unresolved || marker.length === 0 || level.format === 'none') return null
  return marker
}

function paragraphNumberingProperties(
  xml: WordXml,
  properties: XmlElement | undefined,
): ParagraphNumberingProperties | null {
  const numProperties = properties === undefined ? undefined : firstWordChild(xml, properties, 'numPr')
  if (numProperties === undefined) return null
  return {
    numId: valueOf(firstWordChild(xml, numProperties, 'numId')),
    levelIndex: nonNegativeDecimal(valueOf(firstWordChild(xml, numProperties, 'ilvl'))),
  }
}

function resolveParagraphNumbering(
  xml: WordXml,
  properties: XmlElement | undefined,
  styles: Map<string, StyleDefinition>,
): ParagraphNumberingProperties | null {
  const direct = paragraphNumberingProperties(xml, properties)
  let numId = direct?.numId ?? null
  let levelIndex = direct?.levelIndex ?? null
  let styleId = properties === undefined
    ? null
    : valueOf(firstWordChild(xml, properties, 'pStyle'))
  const visited = new Set<string>()
  while (styleId !== null && !visited.has(styleId) && (numId === null || levelIndex === null)) {
    visited.add(styleId)
    const style = styles.get(styleId)
    if (style === undefined) break
    numId ??= style.numbering?.numId ?? null
    levelIndex ??= style.numbering?.levelIndex ?? null
    styleId = style.basedOn
  }
  if (numId === null) return null
  return { numId, levelIndex: levelIndex ?? 0 }
}

function resolvedNumberingLevel(
  instance: NumberingInstance,
  abstractLevels: Map<number, NumberingLevel>,
  levelIndex: number,
): NumberingLevel | undefined {
  const override = instance.overrides.get(levelIndex)
  const level = override?.level ?? abstractLevels.get(levelIndex)
  if (level === undefined) return undefined
  return override?.start === null || override?.start === undefined
    ? level
    : { ...level, start: override.start }
}

function formatCounter(value: number, format: string): string | null {
  if (format === 'decimal') return String(value)
  if (format === 'lowerLetter') return alphabetic(value).toLowerCase()
  if (format === 'upperLetter') return alphabetic(value)
  if (format === 'lowerRoman') return roman(value)?.toLowerCase() ?? null
  if (format === 'upperRoman') return roman(value)
  if (format === 'bullet') return ''
  return null
}

function alphabetic(value: number): string {
  if (value <= 0) return ''
  let current = value
  let result = ''
  while (current > 0) {
    current -= 1
    result = String.fromCharCode(65 + current % 26) + result
    current = Math.floor(current / 26)
  }
  return result
}

function roman(value: number): string | null {
  if (value <= 0 || value > 3_999) return null
  const symbols: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let remaining = value
  let result = ''
  for (const [amount, symbol] of symbols) {
    while (remaining >= amount) {
      result += symbol
      remaining -= amount
    }
  }
  return result
}

function mapDocxError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return signal.reason
  if (error instanceof ParserError) return error
  return new ParserError('INVALID_DOCX', 'DOCX archive or XML is malformed')
}

function invalidDocx(message: string): never {
  throw new ParserError('INVALID_DOCX', message)
}

function resourceLimit(message: string): never {
  throw new ParserError('DOCUMENT_RESOURCE_LIMIT_EXCEEDED', message)
}
