import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as sourceLocatorModule from '../src/domain/source-locator.js'
import type { RealSourceLocatorV1, SourceLocator } from '../src/domain/source-locator.js'
import { DeterministicRequirementExtractor } from '../src/infrastructure/parser/deterministic-requirement-extractor.js'
import { DigitalDocumentParser } from '../src/infrastructure/parser/digital-document-parser.js'
import { DocxDocumentExtractor } from '../src/infrastructure/parser/docx-document-extractor.js'
import {
  DEFAULT_PARSER_LIMITS,
  ParserError,
  validateParsedDocument,
  type ParsedDocument,
  type ParserLimits,
} from '../src/infrastructure/parser/parser-types.js'
import { TextDocumentExtractor } from '../src/infrastructure/parser/text-document-extractor.js'
import {
  DOCX_MEDIA_TYPE,
  FIXED_NOW,
  OFFICE_DOCUMENT_STRICT_RELATIONSHIP,
  WORDPROCESSINGML_NAMESPACE,
  WORDPROCESSINGML_STRICT_NAMESPACE,
  combiningRunPdfBuffer,
  corruptFirstPdfStream,
  encryptedPdfBuffer,
  orderedTwoPagePdfBuffer,
  docxBuffer,
  pdfBuffer,
  pdfFile,
  parseTask,
  parseDocx,
  parsePdf,
  parseText,
  textFile,
} from './helpers/document-fixtures.js'

const signal = () => new AbortController().signal

function expectParserCode(code: string) {
  return expect.objectContaining({ code, retryable: false })
}

function realLocator(locator: SourceLocator): RealSourceLocatorV1 {
  if (locator.kind === 'development-fixture') throw new Error('Expected real source evidence')
  return locator
}

function docxLocator(locator: SourceLocator) {
  const real = realLocator(locator)
  if (real.kind !== 'docx') throw new Error('Expected DOCX source evidence')
  return real
}

function pdfLocator(locator: SourceLocator) {
  const real = realLocator(locator)
  if (real.kind !== 'pdf') throw new Error('Expected PDF source evidence')
  return real
}

function injectedDocxLimits(overrides: Record<string, number>): Partial<ParserLimits> {
  return overrides as Partial<ParserLimits>
}

function injectedPdfLimits(overrides: Record<string, number>): Partial<ParserLimits> {
  return overrides as Partial<ParserLimits>
}

async function extractPdfDocument(
  content: Buffer,
  limits: Partial<ParserLimits> = {},
) {
  const { PdfDocumentExtractor } = await import(
    '../src/infrastructure/parser/pdf-document-extractor.js'
  )
  return new PdfDocumentExtractor({ ...DEFAULT_PARSER_LIMITS, ...limits }).extract(
    content,
    signal(),
  )
}

function wordDocumentXml(
  bodyXml: string,
  options: { namespace?: string; encoding?: string } = {},
): string {
  const namespace = options.namespace ?? WORDPROCESSINGML_NAMESPACE
  return `<?xml version="1.0" encoding="${options.encoding ?? 'UTF-8'}" standalone="yes"?>` +
    `<w:document xmlns:w="${namespace}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">` +
    `<w:body>${bodyXml}</w:body></w:document>`
}

function utf16Xml(bodyXml: string, endian: 'le' | 'be'): Buffer {
  return utf16Encoded(wordDocumentXml(bodyXml, { encoding: 'UTF-16' }), endian)
}

function utf16Encoded(xml: string, endian: 'le' | 'be'): Buffer {
  const littleEndian = Buffer.from(xml.replace(/encoding="UTF-8"/u, 'encoding="UTF-16"'), 'utf16le')
  if (endian === 'le') return Buffer.concat([Buffer.from([0xff, 0xfe]), littleEndian])
  const bigEndian = Buffer.from(littleEndian)
  for (let index = 0; index < bigEndian.length; index += 2) {
    const first = bigEndian[index]!
    bigEndian[index] = bigEndian[index + 1]!
    bigEndian[index + 1] = first
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])
}

describe('A. TXT extraction and the normative document IR', () => {
  it('strictly decodes one leading UTF-8 BOM and preserves canonical source whitespace and physical lines', () => {
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Cafe\u0301\r\n\r\n  \rTail\ufeff', 'utf8'),
    ])

    const document = new TextDocumentExtractor().extract(raw, signal())

    expect(document.canonicalText).toBe('Caf\u00e9\n\n  \nTail\ufeff')
    expect(document.blocks).toEqual([
      {
        kind: 'paragraph',
        text: 'Caf\u00e9',
        textStart: 0,
        textEnd: 4,
        sectionPath: [],
        sourceSpans: [{
          textStart: 0,
          textEnd: 4,
          source: { kind: 'txt', start: { line: 1, column: 0 }, end: { line: 1, column: 4 } },
        }],
      },
      {
        kind: 'paragraph',
        text: '  ',
        textStart: 6,
        textEnd: 8,
        sectionPath: [],
        sourceSpans: [{
          textStart: 6,
          textEnd: 8,
          source: { kind: 'txt', start: { line: 3, column: 0 }, end: { line: 3, column: 2 } },
        }],
      },
      {
        kind: 'paragraph',
        text: 'Tail\ufeff',
        textStart: 9,
        textEnd: 14,
        sectionPath: [],
        sourceSpans: [{
          textStart: 9,
          textEnd: 14,
          source: { kind: 'txt', start: { line: 4, column: 0 }, end: { line: 4, column: 5 } },
        }],
      },
    ])
  })

  it.each([
    ['UTF-16 little-endian BOM', Buffer.from([0xff, 0xfe, 0x41, 0x00])],
    ['UTF-16 big-endian BOM', Buffer.from([0xfe, 0xff, 0x00, 0x41])],
    ['malformed UTF-8', Buffer.from([0x61, 0xc3, 0x28])],
  ])('rejects %s with the stable encoding code', (_label, content) => {
    expect(() => new TextDocumentExtractor().extract(content, signal())).toThrowError(
      expectParserCode('INVALID_TEXT_ENCODING'),
    )
  })

  it('removes only heading markers, applies the declared levels, and truncates peers and ancestors', () => {
    const source = [
      '# Root',
      'body',
      '### Deep',
      'body 2',
      '## Peer',
      'body 3',
      '第十二章 合规',
      '第3节 证书',
      '1.12.3 技术',
      'body 4',
      '2 商务',
      'body 5',
      '一、中文标题',
      'body 6',
    ].join('\n')

    const document = new TextDocumentExtractor().extract(Buffer.from(source), signal())
    const headings = document.blocks.filter((block) => block.kind === 'heading')
    const bodies = document.blocks.filter((block) => block.kind === 'paragraph')

    expect(headings.map((block) => [block.text, block.sectionPath])).toEqual([
      ['# Root', ['Root']],
      ['### Deep', ['Root', 'Deep']],
      ['## Peer', ['Root', 'Peer']],
      ['第十二章 合规', ['合规']],
      ['第3节 证书', ['合规', '证书']],
      ['1.12.3 技术', ['合规', '证书', '技术']],
      ['2 商务', ['商务']],
      ['一、中文标题', ['中文标题']],
    ])
    expect(bodies.map((block) => block.sectionPath)).toEqual([
      ['Root'],
      ['Root', 'Deep'],
      ['Root', 'Peer'],
      ['合规', '证书', '技术'],
      ['商务'],
      ['中文标题'],
    ])
    expect(document.canonicalText).toBe(source)
  })

  it('requires all heading safety conditions: no signal, at most 120 units, and no sentence delimiter', () => {
    const long = `# ${'x'.repeat(119)}`
    const source = [
      '# Safe heading',
      '# Supplier must comply',
      '## Evaluation worth 5 points',
      '# Sentence.',
      long,
    ].join('\n')

    const document = new TextDocumentExtractor().extract(Buffer.from(source), signal())

    expect(document.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ])
  })

  it('counts offsets and TXT columns in UTF-16 units without splitting surrogate pairs', () => {
    const document = new TextDocumentExtractor().extract(
      Buffer.from('\ud83d\ude00 must comply\n尾行'),
      signal(),
    )

    expect(document.blocks[0]).toMatchObject({ textStart: 0, textEnd: 14 })
    expect(document.blocks[0]?.sourceSpans[0]?.source).toEqual({
      kind: 'txt',
      start: { line: 1, column: 0 },
      end: { line: 1, column: 14 },
    })
    expect(document.blocks[1]).toMatchObject({ textStart: 15, textEnd: 17 })
  })

  it('retains indexed physical lines across many blank-line gaps', () => {
    const source = Array.from({ length: 300 }, (_, index) =>
      index % 3 === 0 ? '' : `line ${index}`
    ).join('\n')

    const document = new TextDocumentExtractor().extract(Buffer.from(source), signal())
    const last = document.blocks.at(-1)

    expect(last?.sourceSpans[0]?.source).toMatchObject({
      kind: 'txt',
      start: { line: 300, column: 0 },
    })
  })
})

describe('B. deterministic-rules-v1 extraction and evidence', () => {
  it.each([
    'The supplier MUST encrypt data.',
    'The supplier shall encrypt data.',
    '供应商必须加密数据。',
    '供应商不得泄露数据。',
    '供应商应当提交方案。',
    '供应商须提供证明。',
  ])('recognizes hard modal signal: %s', async (quote) => {
    const requirements = await parseText(quote)
    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toMatchObject({
      title: quote,
      description: quote,
      priority: 'mandatory',
      confidence: 0.95,
    })
  })

  it.each([
    '最高得10分。',
    '最高可得 9 分。',
    '最高为8分。',
    '满分7分。',
    '满分为 6 分。',
    '得5分。',
    '计4分。',
    '赋3分。',
    '分值2分。',
    '分值为 1.5 分。',
    'This item is worth 10 points.',
    'This item is awarded 9 points.',
    'This item scores 8 points.',
    'The maximum of 7 points applies.',
    'The max 6 points applies.',
    'The response receives 5 points.',
  ])('recognizes only explicit scoring phrase: %s', async (quote) => {
    const requirements = await parseText(quote)
    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toMatchObject({ priority: 'important', confidence: 0.9 })
  })

  it.each([
    'Mustard is yellow and shallots are vegetables.',
    '本事项无需办理，也无须办理，请阅读投标须知。',
    'See page 10, version 2.1, and allow 5 days.',
    'The supplier provides documentation.',
    '本项说明服务内容。',
    'The maximum response length is 10 pages.',
    '合计10分钟。',
    '最高为8分贝。',
    '计10分米。',
    'The supplier says émust comply.',
    'The supplier shallé comply.',
    'The item is worth 5 pointsé.',
  ])('does not produce a false positive for: %s', async (source) => {
    await expect(parseText(source)).resolves.toEqual([])
  })

  it.each([
    'Certificates must remain valid.',
    'Licenses shall remain valid.',
  ])('classifies common compliance keyword stems: %s', async (source) => {
    const [requirement] = await parseText(source)
    expect(requirement?.category).toBe('compliance')
  })

  it.each([
    'Payments must be traceable.',
    'Fees shall be disclosed.',
    'Invoices must be itemized.',
    'Taxes shall be included.',
    'Deposits must be refundable.',
  ])('classifies common commercial keyword stems: %s', async (source) => {
    const [requirement] = await parseText(source)
    expect(requirement?.category).toBe('commercial')
  })

  it('does not classify coffee as commercial merely because it contains fee', async () => {
    const [requirement] = await parseText('Coffee must remain hot.')
    expect(requirement?.category).toBe('technical')
  })

  it('splits sentences at the specified delimiters, preserves delimiters/internal text, and trims only edges', async () => {
    const source = '  Supplier must support version 1.2.  Vendor shall sign；  报价最高得 10 分。  '
    const requirements = await parseText(source)

    expect(requirements.map((item) => item.description)).toEqual([
      'Supplier must support version 1.2.',
      'Vendor shall sign；',
      '报价最高得 10 分。',
    ])
    expect(requirements.map((item) => realLocator(item.sourceLocator).textStart)).toEqual([
      source.indexOf('Supplier'),
      source.indexOf('Vendor'),
      source.indexOf('报价'),
    ])
  })

  it('merges hard and score hits and applies compliance over commercial over technical', async () => {
    const source = [
      '# Pricing',
      'Supplier must provide signature and pricing worth 10 points.',
      '# Commercial',
      '方案最高得8分。',
      '# Technical',
      'Supplier shall encrypt data.',
    ].join('\n')
    const requirements = await parseText(source)

    expect(requirements.map(({ category, priority, confidence }) => ({
      category,
      priority,
      confidence,
    }))).toEqual([
      { category: 'compliance', priority: 'mandatory', confidence: 0.98 },
      { category: 'commercial', priority: 'important', confidence: 0.9 },
      { category: 'technical', priority: 'mandatory', confidence: 0.95 },
    ])
  })

  it('keeps the earliest exact NFC quote, preserves document order, and assigns stable codes afterward', async () => {
    const source = [
      'Zulu must work.',
      'Alpha shall work.',
      'Zulu must work.',
      'Beta最高得5分。',
    ].join('\n')
    const requirements = await parseText(source)

    expect(requirements.map((item) => [
      item.code,
      item.description,
      realLocator(item.sourceLocator).textStart,
    ])).toEqual([
      ['REQ-0001', 'Zulu must work.', 0],
      ['REQ-0002', 'Alpha shall work.', source.indexOf('Alpha')],
      ['REQ-0003', 'Beta最高得5分。', source.indexOf('Beta')],
    ])
  })

  it('maps exact domain fields and clipped, verified TXT evidence from stored-file metadata', async () => {
    const raw = '  Supplier must submit a signed certificate.  '
    const file = textFile(raw, {
      id: 'stored-file',
      tenantId: 'tenant-source',
      projectId: 'project-source',
      fileName: 'BID.TXT',
      mediaType: ' Text/Plain ; charset=UTF-8 ',
    })
    const task = parseTask(file, { id: 'parse-task' })
    const [requirement] = await new DigitalDocumentParser().parse(file, task, FIXED_NOW, signal())
    const quote = 'Supplier must submit a signed certificate.'

    expect(requirement).toEqual({
      id: expect.any(String),
      tenantId: file.tenantId,
      projectId: file.projectId,
      fileId: file.id,
      taskId: task.id,
      code: 'REQ-0001',
      title: quote,
      description: quote,
      category: 'compliance',
      priority: 'mandatory',
      confirmationStatus: 'pending',
      confirmationNote: null,
      confirmedAt: null,
      extractionMethod: 'deterministic-rules-v1',
      confidence: 0.95,
      sourceLocator: {
        kind: 'txt',
        version: 1,
        sourceFileId: file.id,
        sourceFileName: file.fileName,
        sourceRevision: 1,
        sourceSha256: file.sha256,
        quote,
        quoteSha256: sourceLocatorModule.sha256Hex(quote),
        textStart: 2,
        textEnd: 2 + quote.length,
        sectionPath: [],
        parserVersion: 'deterministic-rules-v1',
        start: { line: 1, column: 2 },
        end: { line: 1, column: 2 + quote.length },
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
  })

  it('returns zero requirements for a valid document without signals', async () => {
    await expect(parseText('# Scope\nThe platform provides reporting.\n普通说明。')).resolves.toEqual([])
  })

  it('does not allocate a canonical text index when the document has no candidates', async () => {
    const createIndexSpy = vi.spyOn(sourceLocatorModule, 'createCanonicalSourceTextIndex')
    try {
      await expect(parseText('The platform provides reporting.')).resolves.toEqual([])
      expect(createIndexSpy).not.toHaveBeenCalled()
    } finally {
      createIndexSpy.mockRestore()
    }
  })

  it('maps clipped DOCX ranges and complete contributing PDF regions from the neutral IR', () => {
    const extractor = new DeterministicRequirementExtractor()
    const docxText = '  Supplier must comply.  '
    const docxFile = textFile(Buffer.from('docx source'), {
      fileName: 'requirements.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const docxTask = parseTask(docxFile)
    const docxDocument: ParsedDocument = {
      format: 'docx',
      canonicalText: docxText,
      blocks: [{
        kind: 'paragraph',
        text: docxText,
        textStart: 0,
        textEnd: docxText.length,
        sectionPath: [],
        sourceSpans: [{
          textStart: 0,
          textEnd: docxText.length,
          source: {
            kind: 'docx',
            paragraphId: '00A1B2C3',
            paragraphIndex: 2,
            tablePath: [],
            charStart: 5,
            charEnd: 5 + docxText.length,
          },
        }],
      }],
    }

    const [docxRequirement] = extractor.extract(
      docxDocument,
      docxFile,
      docxTask,
      FIXED_NOW,
      signal(),
    )
    expect(docxRequirement?.sourceLocator).toMatchObject({
      kind: 'docx',
      ranges: [{ charStart: 7, charEnd: 28 }],
    })

    const pdfText = 'Supplier must comply.'
    const pdfFile = textFile(Buffer.from('pdf source'), {
      fileName: 'requirements.pdf',
      mediaType: 'application/pdf',
    })
    const pdfDocument: ParsedDocument = {
      format: 'pdf',
      canonicalText: pdfText,
      blocks: [{
        kind: 'paragraph',
        text: pdfText,
        textStart: 0,
        textEnd: pdfText.length,
        sectionPath: [],
        sourceSpans: [{
          textStart: 9,
          textEnd: 13,
          source: { kind: 'pdf', page: 2, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
        }],
      }],
    }
    const [pdfRequirement] = extractor.extract(
      pdfDocument,
      pdfFile,
      parseTask(pdfFile),
      FIXED_NOW,
      signal(),
    )
    expect(pdfRequirement?.sourceLocator).toMatchObject({
      kind: 'pdf',
      regions: [{ page: 2, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }],
    })
  })

  it('finds candidate span overlap without filtering or scanning every span', () => {
    const canonicalText = `${'x'.repeat(32)}. Supplier must comply.`
    const candidateStart = canonicalText.indexOf('Supplier')
    const sourceSpans = Array.from({ length: 32 }, (_, index) => ({
      textStart: index,
      textEnd: index + 1,
      source: {
        kind: 'pdf' as const,
        page: 1,
        bbox: { x: index / 100, y: 0, width: 0.005, height: 0.01 },
      },
    }))
    sourceSpans.push({
      textStart: candidateStart,
      textEnd: canonicalText.length,
      source: {
        kind: 'pdf',
        page: 2,
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      },
    })
    const document: ParsedDocument = {
      format: 'pdf',
      canonicalText,
      blocks: [{
        kind: 'paragraph',
        text: canonicalText,
        textStart: 0,
        textEnd: canonicalText.length,
        sectionPath: [],
        sourceSpans,
      }],
    }
    const file = textFile(Buffer.from('pdf source'), {
      fileName: 'requirements.pdf',
      mediaType: 'application/pdf',
    })
    const filterSpy = vi.spyOn(Array.prototype, 'filter')
    const someSpy = vi.spyOn(Array.prototype, 'some')
    let filteredSourceSpans = false
    let scannedSourceSpans = false
    let requirementCount = 0
    try {
      requirementCount = new DeterministicRequirementExtractor().extract(
        document,
        file,
        parseTask(file),
        FIXED_NOW,
        signal(),
      ).length
      filteredSourceSpans = filterSpy.mock.contexts.includes(sourceSpans)
      scannedSourceSpans = someSpy.mock.contexts.includes(sourceSpans)
    } finally {
      filterSpy.mockRestore()
      someSpy.mockRestore()
    }

    expect(requirementCount).toBe(1)
    expect(filteredSourceSpans).toBe(false)
    expect(scannedSourceSpans).toBe(false)
  })

  it('clips TXT columns by UTF-16 offset deltas without rescanning span text', () => {
    const canonicalText = '    Supplier must comply.'
    const sourceSpans = [{
      textStart: 2,
      textEnd: canonicalText.length,
      source: {
        kind: 'txt' as const,
        start: { line: 1, column: 2 },
        end: { line: 1, column: canonicalText.length },
      },
    }]
    const document: ParsedDocument = {
      format: 'txt',
      canonicalText,
      blocks: [{
        kind: 'paragraph',
        text: canonicalText,
        textStart: 0,
        textEnd: canonicalText.length,
        sectionPath: [],
        sourceSpans,
      }],
    }
    const file = textFile(Buffer.from(canonicalText))
    const sliceSpy = vi.spyOn(String.prototype, 'slice')
    let sourceLocator: SourceLocator | undefined
    let rescannedFromSpanStart = false
    try {
      sourceLocator = new DeterministicRequirementExtractor().extract(
        document,
        file,
        parseTask(file),
        FIXED_NOW,
        signal(),
      )[0]?.sourceLocator
      rescannedFromSpanStart = sliceSpy.mock.calls.some(
        ([start, end]) => start === 2 && end === 4,
      )
    } finally {
      sliceSpy.mockRestore()
    }

    expect(sourceLocator).toMatchObject({
      kind: 'txt',
      start: { line: 1, column: 4 },
      end: { line: 1, column: canonicalText.length },
    })
    expect(rescannedFromSpanStart).toBe(false)
  })
})

describe('C. parser boundaries, IR validation, and resource limits', () => {
  it.each([
    ['task type', { type: 'development-document-parse' as const }],
    ['tenant lineage', { tenantId: 'other-tenant' }],
    ['project lineage', { projectId: 'other-project' }],
    ['file lineage', { fileId: 'other-file' }],
  ])('rejects mismatched %s before dispatch', async (_label, taskChange) => {
    await expect(parseText('Supplier must comply.', { task: taskChange })).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
  })

  it.each([
    ['wrong MIME for TXT', { fileName: 'requirements.txt', mediaType: 'application/pdf' }],
    ['wrong extension for TXT MIME', { fileName: 'requirements.pdf', mediaType: 'text/plain' }],
  ])('rejects %s with FORMAT_MISMATCH', async (_label, fileChange) => {
    await expect(parseText('Supplier must comply.', { file: fileChange })).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
  })

  it('dispatches a consistently labeled but malformed PDF to INVALID_PDF', async () => {
    await expect(parseText('pdf bytes', {
      file: { fileName: 'requirements.pdf', mediaType: 'application/pdf' },
    })).rejects.toEqual(expectParserCode('INVALID_PDF'))
  })

  it('rejects a declared byte size that differs from direct parser content', async () => {
    await expect(parseText('must', { file: { sizeBytes: 99 } })).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
  })

  it('keeps all production parser work caps explicit', () => {
    expect(DEFAULT_PARSER_LIMITS).toEqual({
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
  })

  it('allows the exact byte/text boundary and rejects the next unit', async () => {
    await expect(parseText('must ', {
      limits: { maxInputBytes: 5, maxCanonicalTextUnits: 5 },
    })).resolves.toHaveLength(1)
    await expect(parseText('must x', {
      limits: { maxInputBytes: 6, maxCanonicalTextUnits: 5 },
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
    await expect(parseText('must!', {
      limits: { maxInputBytes: 4, maxCanonicalTextUnits: 100 },
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('allows exactly the configured unique candidate count, ignores duplicates, and fails on the next unique quote', async () => {
    await expect(parseText('A must work.\nB shall work.\nA must work.', {
      limits: { maxRequirements: 2 },
    })).resolves.toHaveLength(2)
    await expect(parseText('A must work.\nB shall work.\nC must work.', {
      limits: { maxRequirements: 2 },
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('allows the exact configured block boundary and rejects the next block while scanning TXT', () => {
    const limits = { ...DEFAULT_PARSER_LIMITS, maxDocumentBlocks: 2 }
    expect(new TextDocumentExtractor(limits).extract(Buffer.from('one\ntwo'), signal()).blocks)
      .toHaveLength(2)
    expect(() => new TextDocumentExtractor(limits).extract(Buffer.from('one\ntwo\nthree'), signal()))
      .toThrowError(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('allows the exact configured source-span boundary and rejects the next span while scanning TXT', () => {
    const limits = { ...DEFAULT_PARSER_LIMITS, maxSourceSpans: 2 }
    expect(new TextDocumentExtractor(limits).extract(Buffer.from('one\ntwo'), signal()).blocks)
      .toHaveLength(2)
    expect(() => new TextDocumentExtractor(limits).extract(Buffer.from('one\ntwo\nthree'), signal()))
      .toThrowError(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('checks an already-aborted signal at parse start', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop parsing'))
    await expect(parseText('Supplier must comply.', { signal: controller.signal })).rejects.toThrow(
      'stop parsing',
    )
  })

  it('checks abort state while validating the format-neutral IR', () => {
    const controller = new AbortController()
    controller.abort(new Error('stop IR validation'))

    expect(() => validateParsedDocument(
      { format: 'txt', canonicalText: '', blocks: [] },
      { ...DEFAULT_PARSER_LIMITS },
      controller.signal,
    )).toThrow('stop IR validation')
  })

  it('rejects unordered/overlapping blocks and block or span surrogate splits', () => {
    const base: ParsedDocument = {
      format: 'txt',
      canonicalText: '\ud83d\ude00 must',
      blocks: [{
        kind: 'paragraph',
        text: '\ud83d\ude00 must',
        textStart: 0,
        textEnd: 7,
        sectionPath: [],
        sourceSpans: [{
          textStart: 0,
          textEnd: 7,
          source: { kind: 'txt', start: { line: 1, column: 0 }, end: { line: 1, column: 7 } },
        }],
      }],
    }
    expect(() => validateParsedDocument({
      ...base,
      blocks: [{ ...base.blocks[0]!, textStart: 1, text: '\ude00 must' }],
    })).toThrow(/surrogate/i)
    expect(() => validateParsedDocument({
      ...base,
      blocks: [{
        ...base.blocks[0]!,
        sourceSpans: [{
          ...base.blocks[0]!.sourceSpans[0]!,
          textEnd: 1,
          source: { kind: 'txt', start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        }],
      }],
    })).toThrow(/surrogate/i)
    expect(() => validateParsedDocument({
      format: 'txt',
      canonicalText: 'abcd',
      blocks: [
        { ...base.blocks[0]!, text: 'bc', textStart: 1, textEnd: 3, sourceSpans: [] },
        { ...base.blocks[0]!, text: 'ab', textStart: 0, textEnd: 2, sourceSpans: [] },
      ],
    })).toThrow(/ordered|overlap/i)
  })

  it('rejects TXT/DOCX span length mismatches and candidates without a contributing span', () => {
    const mismatch: ParsedDocument = {
      format: 'txt',
      canonicalText: 'must',
      blocks: [{
        kind: 'paragraph',
        text: 'must',
        textStart: 0,
        textEnd: 4,
        sectionPath: [],
        sourceSpans: [{
          textStart: 0,
          textEnd: 4,
          source: { kind: 'txt', start: { line: 1, column: 0 }, end: { line: 1, column: 3 } },
        }],
      }],
    }
    expect(() => validateParsedDocument(mismatch)).toThrow(/length/i)

    const canonicalText = 'Intro. Supplier must comply.'
    const pdfDocument: ParsedDocument = {
      format: 'pdf',
      canonicalText,
      blocks: [{
        kind: 'paragraph',
        text: canonicalText,
        textStart: 0,
        textEnd: canonicalText.length,
        sectionPath: [],
        sourceSpans: [{
          textStart: 0,
          textEnd: 6,
          source: { kind: 'pdf', page: 1, bbox: { x: 0, y: 0, width: 0.2, height: 0.1 } },
        }],
      }],
    }
    const file = textFile(Buffer.from('pdf'), {
      fileName: 'requirements.pdf',
      mediaType: 'application/pdf',
    })
    expect(() => new DeterministicRequirementExtractor().extract(
      pdfDocument,
      file,
      parseTask(file),
      FIXED_NOW,
      signal(),
    )).toThrow(/source span/i)
  })

  it('rejects TXT IR that hides non-newline canonical characters between emitted blocks', () => {
    const document: ParsedDocument = {
      format: 'txt',
      canonicalText: 'visible\nhidden\nnext',
      blocks: [
        {
          kind: 'paragraph',
          text: 'visible',
          textStart: 0,
          textEnd: 7,
          sectionPath: [],
          sourceSpans: [{
            textStart: 0,
            textEnd: 7,
            source: { kind: 'txt', start: { line: 1, column: 0 }, end: { line: 1, column: 7 } },
          }],
        },
        {
          kind: 'paragraph',
          text: 'next',
          textStart: 15,
          textEnd: 19,
          sectionPath: [],
          sourceSpans: [{
            textStart: 15,
            textEnd: 19,
            source: { kind: 'txt', start: { line: 3, column: 0 }, end: { line: 3, column: 4 } },
          }],
        },
      ],
    }

    expect(() => validateParsedDocument(document)).toThrow(/TXT.*newline|hidden/i)
  })

  it('rejects two TXT blocks that split one physical line', () => {
    const document: ParsedDocument = {
      format: 'txt',
      canonicalText: 'abcd',
      blocks: [
        {
          kind: 'paragraph',
          text: 'ab',
          textStart: 0,
          textEnd: 2,
          sectionPath: [],
          sourceSpans: [],
        },
        {
          kind: 'paragraph',
          text: 'cd',
          textStart: 2,
          textEnd: 4,
          sectionPath: [],
          sourceSpans: [],
        },
      ],
    }

    expect(() => validateParsedDocument(document)).toThrowError(
      expectParserCode('PARSER_WORKER_FAILED'),
    )
  })

  it('applies block and total-span caps before dereferencing nested IR entries', () => {
    const oversizedSparseBlocks = new Array(2)
    const tooManyBlocks = {
      format: 'txt',
      canonicalText: '',
      blocks: oversizedSparseBlocks,
    } as unknown as ParsedDocument
    expect(() => validateParsedDocument(tooManyBlocks, {
      ...DEFAULT_PARSER_LIMITS,
      maxDocumentBlocks: 1,
    })).toThrowError(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))

    const oversizedSparseSpans = new Array(2)
    const tooManySpans = {
      format: 'txt',
      canonicalText: 'x',
      blocks: [{
        kind: 'paragraph',
        text: 'x',
        textStart: 0,
        textEnd: 1,
        sectionPath: [],
        sourceSpans: oversizedSparseSpans,
      }],
    } as unknown as ParsedDocument
    expect(() => validateParsedDocument(tooManySpans, {
      ...DEFAULT_PARSER_LIMITS,
      maxSourceSpans: 1,
    })).toThrowError(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('normalizes malformed nested IR shapes to permanent parser failures', () => {
    const sparseSourceSpans = new Array(1)
    const malformedDocuments: Array<[string, ParsedDocument]> = [
      ['null source span', {
        format: 'txt',
        canonicalText: 'must',
        blocks: [{
          kind: 'paragraph',
          text: 'must',
          textStart: 0,
          textEnd: 4,
          sectionPath: [],
          sourceSpans: [null],
        }],
      } as unknown as ParsedDocument],
      ['sparse source span array', {
        format: 'txt',
        canonicalText: 'must',
        blocks: [{
          kind: 'paragraph',
          text: 'must',
          textStart: 0,
          textEnd: 4,
          sectionPath: [],
          sourceSpans: sparseSourceSpans,
        }],
      } as ParsedDocument],
      ['null DOCX table path entry', {
        format: 'docx',
        canonicalText: 'must',
        blocks: [{
          kind: 'paragraph',
          text: 'must',
          textStart: 0,
          textEnd: 4,
          sectionPath: [],
          sourceSpans: [{
            textStart: 0,
            textEnd: 4,
            source: {
              kind: 'docx',
              paragraphId: null,
              paragraphIndex: 0,
              tablePath: [null],
              charStart: 0,
              charEnd: 4,
            },
          }],
        }],
      } as unknown as ParsedDocument],
      ['missing PDF bounding box', {
        format: 'pdf',
        canonicalText: 'must',
        blocks: [{
          kind: 'paragraph',
          text: 'must',
          textStart: 0,
          textEnd: 4,
          sectionPath: [],
          sourceSpans: [{
            textStart: 0,
            textEnd: 4,
            source: { kind: 'pdf', page: 1 },
          }],
        }],
      } as unknown as ParsedDocument],
    ]

    for (const [label, document] of malformedDocuments) {
      expect(
        () => validateParsedDocument(document),
        label,
      ).toThrowError(expectParserCode('PARSER_WORKER_FAILED'))
    }
  })

  it('defines the complete stable parser error protocol as permanent', () => {
    const codes = [
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
    for (const code of codes) {
      const error = new ParserError(code, 'message')
      expect(error).toMatchObject({ name: 'ParserError', code, retryable: false, message: 'message' })
    }
  })

  it('uses the original byte digest rather than a canonical-text digest', async () => {
    const raw = Buffer.from('Supplier must comply.\r\n')
    const [requirement] = await parseText(raw)
    const rawDigest = createHash('sha256').update(raw).digest('hex')
    expect(requirement && realLocator(requirement.sourceLocator).sourceSha256).toBe(rawDigest)
    expect(requirement && realLocator(requirement.sourceLocator).sourceSha256).not.toBe(
      sourceLocatorModule.sha256Hex('Supplier must comply.\n'),
    )
  })
})

describe('D. bounded DOCX extraction', () => {
  it('builds the exact joined-block IR with NFC text, preserved whitespace, and absolute DOCX spans', async () => {
    const paragraph = '  Café must work. Vendor shall sign.  '
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <x:document xmlns:x="${WORDPROCESSINGML_NAMESPACE}">
        <x:body>
          <x:p><x:pPr><x:outlineLvl x:val="0"/></x:pPr><x:r><x:t>Scope</x:t></x:r></x:p>
          <x:p><x:r><x:t xml:space="preserve">  Café must work. Vendor shall sign.  </x:t></x:r></x:p>
        </x:body>
      </x:document>`
    const content = docxBuffer({ documentXml })

    const document = await new DocxDocumentExtractor().extract(content, signal())

    expect(document.canonicalText).toBe(`Scope\n${paragraph}`)
    expect(document.blocks).toEqual([
      {
        kind: 'heading',
        text: 'Scope',
        textStart: 0,
        textEnd: 5,
        sectionPath: ['Scope'],
        sourceSpans: [{
          textStart: 0,
          textEnd: 5,
          source: {
            kind: 'docx', paragraphId: null, paragraphIndex: 0, tablePath: [],
            charStart: 0, charEnd: 5,
          },
        }],
      },
      {
        kind: 'paragraph',
        text: paragraph,
        textStart: 6,
        textEnd: 6 + paragraph.length,
        sectionPath: ['Scope'],
        sourceSpans: [{
          textStart: 6,
          textEnd: 6 + paragraph.length,
          source: {
            kind: 'docx', paragraphId: null, paragraphIndex: 1, tablePath: [],
            charStart: 0, charEnd: paragraph.length,
          },
        }],
      },
    ])

    const requirements = await parseDocx({ documentXml })
    expect(requirements.map((item) => [
      item.description,
      docxLocator(item.sourceLocator).ranges[0]?.charStart,
      docxLocator(item.sourceLocator).ranges[0]?.charEnd,
    ])).toEqual([
      ['Café must work.', 2, 17],
      ['Vendor shall sign.', 18, 36],
    ])
  })

  it('resolves direct Heading 1, basedOn Heading 2, and Heading-name fallback in section order', async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
        <w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style>
        <w:style w:type="paragraph" w:styleId="NamedThree"><w:name w:val="Heading 3"/></w:style>
      </w:styles>`
    const bodyXml = [
      '<w:p><w:pPr><w:pStyle w:val="NamedThree"/><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Direct</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Supplier must provide direct evidence.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:t>Based</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Vendor shall provide based evidence.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="NamedThree"/></w:pPr><w:r><w:t>Fallback</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Bidder must provide fallback evidence.</w:t></w:r></w:p>',
    ].join('')

    const requirements = await parseDocx({ bodyXml, stylesXml })

    expect(requirements.map((item) => [item.description, docxLocator(item.sourceLocator).sectionPath]))
      .toEqual([
        ['Supplier must provide direct evidence.', ['Direct']],
        ['Vendor shall provide based evidence.', ['Direct', 'Based']],
        ['Bidder must provide fallback evidence.', ['Direct', 'Based', 'Fallback']],
      ])
  })

  it('preserves hyperlinks, tabs, breaks, and insertions while skipping deletions and fields', async () => {
    const visible = 'Supplier must\tcomply\n\nnow.'
    const bodyXml = `<w:p w14:paraId="deadbeef">
      <w:r><w:t>Supplier</w:t></w:r>
      <w:hyperlink><w:r><w:t xml:space="preserve"> must</w:t></w:r></w:hyperlink>
      <w:r><w:tab/><w:t>comply</w:t><w:br/><w:cr/></w:r>
      <w:ins><w:r><w:t>now.</w:t></w:r></w:ins>
      <w:del><w:r><w:delText> Deleted must not appear.</w:delText></w:r></w:del>
      <w:r><w:instrText> HIDDEN shall not appear.</w:instrText></w:r>
    </w:p>`

    const [requirement] = await parseDocx({ bodyXml })
    const locator = docxLocator(requirement!.sourceLocator)

    expect(requirement?.description).toBe(visible)
    expect(locator.ranges).toEqual([{
      paragraphId: 'DEADBEEF',
      paragraphIndex: 0,
      tablePath: [],
      charStart: 0,
      charEnd: visible.length,
    }])
  })

  it('normalizes only valid paragraph IDs and counts empty paragraphs globally', async () => {
    const bodyXml = [
      '<w:p/>',
      '<w:p w14:paraId="a1b2c3d4"><w:r><w:t>Alpha must work.</w:t></w:r></w:p>',
      '<w:p w14:paraId="XYZ"><w:r><w:t>Beta shall work.</w:t></w:r></w:p>',
    ].join('')

    const requirements = await parseDocx({ bodyXml })

    expect(requirements.map((item) => docxLocator(item.sourceLocator).ranges[0])).toEqual([
      expect.objectContaining({ paragraphId: 'A1B2C3D4', paragraphIndex: 1 }),
      expect.objectContaining({ paragraphId: null, paragraphIndex: 2 }),
    ])
  })

  it('preserves body, content-control, table, nested-table, and trailing paragraph order', async () => {
    const bodyXml = [
      '<w:p><w:r><w:t>Alpha must work.</w:t></w:r></w:p>',
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>Beta shall work.</w:t></w:r></w:p></w:sdtContent></w:sdt>',
      '<w:tbl><w:tr><w:tc>',
      '<w:p><w:r><w:t>Gamma must work.</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:customXml><w:p><w:r><w:t>Delta shall work.</w:t></w:r></w:p></w:customXml></w:tc></w:tr></w:tbl>',
      '</w:tc></w:tr></w:tbl>',
      '<w:p><w:r><w:t>Epsilon must work.</w:t></w:r></w:p>',
    ].join('')

    const requirements = await parseDocx({ bodyXml })
    const ranges = requirements.map((item) => docxLocator(item.sourceLocator).ranges[0])

    expect(requirements.map((item) => item.description)).toEqual([
      'Alpha must work.', 'Beta shall work.', 'Gamma must work.',
      'Delta shall work.', 'Epsilon must work.',
    ])
    expect(ranges.map((range) => [range?.paragraphIndex, range?.tablePath])).toEqual([
      [0, []],
      [1, []],
      [2, [{ tableIndex: 0, rowIndex: 0, cellIndex: 0 }]],
      [3, [
        { tableIndex: 0, rowIndex: 0, cellIndex: 0 },
        { tableIndex: 0, rowIndex: 0, cellIndex: 0 },
      ]],
      [4, []],
    ])
  })

  it('does not let a table heading mutate the global section path', async () => {
    const bodyXml = [
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc>',
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Table heading</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Table supplier must comply.</w:t></w:r></w:p>',
      '</w:tc></w:tr></w:tbl>',
      '<w:p><w:r><w:t>Trailing supplier shall comply.</w:t></w:r></w:p>',
    ].join('')

    const requirements = await parseDocx({ bodyXml })

    expect(requirements.map((item) => docxLocator(item.sourceLocator).sectionPath))
      .toEqual([['Scope'], ['Scope']])
  })

  it('resolves numbering definitions and keeps derived markers outside DOCX source ranges', async () => {
    const numberingXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:numbering xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
        <w:num w:numId="42"><w:abstractNumId w:val="7"/></w:num>
      </w:numbering>`
    const numbered = (numId: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
    const texts = ['Supplier must comply.', 'Vendor shall sign.', 'Other bidder must attest.']

    const requirements = await parseDocx({
      numberingXml,
      bodyXml: numbered(42, texts[0]!) + numbered(42, texts[1]!) + numbered(99, texts[2]!),
    })

    expect(requirements.map((item) => item.description)).toEqual([
      `C) ${texts[0]}`, `D) ${texts[1]}`, texts[2],
    ])
    expect(requirements.map((item) => docxLocator(item.sourceLocator).ranges[0])).toEqual([
      expect.objectContaining({ paragraphIndex: 0, charStart: 0, charEnd: texts[0]!.length }),
      expect.objectContaining({ paragraphIndex: 1, charStart: 0, charEnd: texts[1]!.length }),
      expect.objectContaining({ paragraphIndex: 2, charStart: 0, charEnd: texts[2]!.length }),
    ])
  })

  it.each([
    ['UTF-8 BOM', Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(wordDocumentXml('<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>')),
    ])],
    ['UTF-16LE', utf16Xml('<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>', 'le')],
    ['UTF-16BE', utf16Xml('<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>', 'be')],
  ])('explicitly decodes supported %s OPC XML', async (_label, documentXml) => {
    await expect(parseDocx({ documentXml })).resolves.toHaveLength(1)
  })

  it('accepts Strict WordprocessingML with the Strict officeDocument relationship', async () => {
    await expect(parseDocx({
      namespace: WORDPROCESSINGML_STRICT_NAMESPACE,
      relationshipType: OFFICE_DOCUMENT_STRICT_RELATIONSHIP,
    })).resolves.toHaveLength(1)
  })

  it('honors an already-aborted signal before archive work', async () => {
    const controller = new AbortController()
    const reason = new Error('stop DOCX parsing')
    controller.abort(reason)

    await expect(parseDocx(docxBuffer(), { signal: controller.signal })).rejects.toBe(reason)
  })

  it('enforces the input byte cap when the DOCX extractor is called directly', async () => {
    const content = docxBuffer()
    const extractor = new DocxDocumentExtractor({
      ...DEFAULT_PARSER_LIMITS,
      maxInputBytes: content.length - 1,
    })

    await expect(extractor.extract(content, signal())).rejects.toEqual(
      expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'),
    )
  })

  it('tracks nonzero table, row, cell, and nested-table indexes', async () => {
    const context = '<w:p><w:r><w:t>Context only.</w:t></w:r></w:p>'
    const bodyXml = [
      `<w:tbl><w:tr><w:tc>${context}</w:tc></w:tr></w:tbl>`,
      '<w:tbl>',
      `<w:tr><w:tc>${context}</w:tc><w:tc>${context}</w:tc></w:tr>`,
      `<w:tr><w:tc>${context}</w:tc><w:tc>`,
      '<w:p><w:r><w:t>Outer supplier must comply.</w:t></w:r></w:p>',
      `<w:tbl><w:tr><w:tc>${context}</w:tc></w:tr></w:tbl>`,
      '<w:tbl>',
      `<w:tr><w:tc>${context}</w:tc><w:tc>${context}</w:tc></w:tr>`,
      `<w:tr><w:tc>${context}</w:tc><w:tc><w:p><w:r><w:t>Nested vendor shall sign.</w:t></w:r></w:p></w:tc></w:tr>`,
      '</w:tbl>',
      '</w:tc></w:tr>',
      '</w:tbl>',
    ].join('')

    const requirements = await parseDocx({ bodyXml })

    expect(requirements.map((item) => docxLocator(item.sourceLocator).ranges[0]?.tablePath))
      .toEqual([
        [{ tableIndex: 1, rowIndex: 1, cellIndex: 1 }],
        [
          { tableIndex: 1, rowIndex: 1, cellIndex: 1 },
          { tableIndex: 1, rowIndex: 1, cellIndex: 1 },
        ],
      ])
  })

  it('handles cyclic basedOn styles and contracts the heading stack on a new Heading 1', async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:style w:type="paragraph" w:styleId="CycleA"><w:name w:val="Heading 2"/><w:basedOn w:val="CycleB"/></w:style>
        <w:style w:type="paragraph" w:styleId="CycleB"><w:basedOn w:val="CycleA"/></w:style>
      </w:styles>`
    const bodyXml = [
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Root</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="CycleA"/></w:pPr><w:r><w:t>Cycle</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Reset</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>Vendor shall sign.</w:t></w:r></w:p>',
    ].join('')

    const requirements = await parseDocx({ bodyXml, stylesXml })

    expect(requirements.map((item) => docxLocator(item.sourceLocator).sectionPath))
      .toEqual([['Root', 'Cycle'], ['Reset']])
  })

  it('decodes auxiliary UTF-16 XML before resolving styles', async () => {
    const styles = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:style w:type="paragraph" w:styleId="Second"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
      </w:styles>`
    const bodyXml = '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Root</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:pStyle w:val="Second"/></w:pPr><w:r><w:t>Second</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>'

    const [requirement] = await parseDocx({
      bodyXml,
      stylesXml: utf16Encoded(styles, 'le'),
    })

    expect(docxLocator(requirement!.sourceLocator).sectionPath).toEqual(['Root', 'Second'])
  })

  it('ignores spoofed non-Word attributes on WordprocessingML properties', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}" xmlns:evil="urn:evil">
        <w:body><w:p><w:pPr><w:outlineLvl evil:val="0"/></w:pPr>
          <w:r><w:t>Supplier must comply.</w:t></w:r>
        </w:p></w:body>
      </w:document>`

    await expect(parseDocx({ documentXml })).resolves.toHaveLength(1)
  })

  it('resolves locally declared WordprocessingML and paragraph-ID prefixes in scope', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}"><w:body>
        <x:p xmlns:x="${WORDPROCESSINGML_NAMESPACE}" xmlns:id="http://schemas.microsoft.com/office/word/2010/wordml" id:paraId="a1b2c3d4">
          <x:r><x:t>Supplier must comply.</x:t></x:r>
        </x:p>
      </w:body></w:document>`

    const [requirement] = await parseDocx({ documentXml })

    expect(docxLocator(requirement!.sourceLocator).ranges[0]?.paragraphId).toBe('A1B2C3D4')
  })

  it('does not apply a default element namespace to unprefixed Word attributes', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <document xmlns="${WORDPROCESSINGML_NAMESPACE}"><body><p><pPr><outlineLvl val="0"/></pPr>
        <r><t>Supplier must comply.</t></r>
      </p></body></document>`

    await expect(parseDocx({ documentXml })).resolves.toHaveLength(1)
  })

  it('traverses permitted content-control wrappers around table rows and cells', async () => {
    const bodyXml = '<w:tbl><w:sdt><w:sdtContent><w:tr><w:customXml><w:tc>' +
      '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>' +
      '</w:tc></w:customXml></w:tr></w:sdtContent></w:sdt></w:tbl>'

    const [requirement] = await parseDocx({ bodyXml })

    expect(docxLocator(requirement!.sourceLocator).ranges[0]?.tablePath).toEqual([
      { tableIndex: 0, rowIndex: 0, cellIndex: 0 },
    ])
  })

  it('advances counters for empty numbered paragraphs and honors startOverride', async () => {
    const numberingXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:numbering xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
        <w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num>
        <w:num w:numId="20"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="7"/></w:lvlOverride></w:num>
      </w:numbering>`
    const numbered = (numId: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${text}</w:p>`
    const bodyXml = numbered(10, '') +
      numbered(10, '<w:r><w:t>Supplier must comply.</w:t></w:r>') +
      numbered(20, '<w:r><w:t>Vendor shall sign.</w:t></w:r>')

    const requirements = await parseDocx({ bodyXml, numberingXml })

    expect(requirements.map((item) => item.description)).toEqual([
      '2) Supplier must comply.',
      '7) Vendor shall sign.',
    ])
  })

  it('inherits numbering properties through the paragraph-style basedOn chain', async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:style w:type="paragraph" w:styleId="ListBase"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="30"/></w:numPr></w:pPr></w:style>
        <w:style w:type="paragraph" w:styleId="ListChild"><w:basedOn w:val="ListBase"/></w:style>
      </w:styles>`
    const numberingXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:numbering xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/></w:lvl></w:abstractNum>
        <w:num w:numId="30"><w:abstractNumId w:val="3"/></w:num>
      </w:numbering>`
    const bodyXml = '<w:p><w:pPr><w:pStyle w:val="ListChild"/></w:pPr>' +
      '<w:r><w:t>Supplier must comply.</w:t></w:r></w:p>'

    const [requirement] = await parseDocx({ bodyXml, stylesXml, numberingXml })

    expect(requirement?.description).toBe('1) Supplier must comply.')
  })

  it('treats explicit outline level 9 as Body Text before Heading-name fallback', async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}">
        <w:style w:type="paragraph" w:styleId="Named"><w:name w:val="Heading 1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>
      </w:styles>`
    const bodyXml = '<w:p><w:pPr><w:pStyle w:val="Named"/><w:outlineLvl w:val="9"/></w:pPr>' +
      '<w:r><w:t>Supplier must comply.</w:t></w:r></w:p>'

    await expect(parseDocx({ bodyXml, stylesXml })).resolves.toHaveLength(1)
  })
})

describe('E. DOCX ZIP, OOXML, and XML safety envelope', () => {
  it.each([
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
  ])('rejects a package missing required OPC part %s', async (missingPart) => {
    await expect(parseDocx({ omitEntries: [missingPart] })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it.each([
    ['broken ZIP', Buffer.from('not a ZIP archive')],
    ['wrong main content type', { mainContentType: 'application/xml' }],
    ['template main type', {
      mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
    }],
    ['macro main type', {
      mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml',
    }],
    ['VBA payload', { additionalEntries: [{ name: 'word/vbaProject.bin', content: 'vba' }] }],
    ['external main relationship', { relationshipTargetMode: 'External' }],
    ['wrong main relationship target', { relationshipTarget: 'word/other.xml' }],
    ['wrong WordprocessingML namespace', { namespace: 'urn:not-wordprocessingml' }],
  ])('maps %s to permanent INVALID_DOCX', async (_label, value) => {
    await expect(parseDocx(value)).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('uses FORMAT_MISMATCH only for an obvious conflicting known magic signature', async () => {
    await expect(parseDocx(Buffer.from('%PDF-1.7\n'))).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
  })

  it('requires DOCX extension and MIME metadata before ZIP parsing', async () => {
    await expect(parseDocx({}, { file: { mediaType: 'application/pdf' } })).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
    await expect(parseDocx({}, { file: { fileName: 'requirements.txt', mediaType: DOCX_MEDIA_TYPE } }))
      .rejects.toEqual(expectParserCode('FORMAT_MISMATCH'))
  })

  it('rejects encrypted entries before extraction', async () => {
    await expect(parseDocx({
      additionalEntries: [{ name: 'encrypted.bin', content: 'secret', encrypted: true }],
    })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('checks the selected XML CRC during extraction', async () => {
    await expect(parseDocx({ documentEntry: { declaredCrc32: 0 } })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it.each([
    '../escape.bin',
    '/absolute.bin',
    'C:/drive.bin',
    'word\\backslash.bin',
    'word//empty.bin',
    'word/./dot.bin',
    'word/../parent.bin',
    'word/\u0000nul.bin',
    'word/\u0001control.bin',
  ])('rejects unsafe ZIP entry path %j', async (name) => {
    await expect(parseDocx({ additionalEntries: [{ name, content: 'x' }] })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it.each([
    ['exact duplicate', [
      { name: 'word/document.xml', content: '<duplicate/>' },
    ]],
    ['NFC-canonical duplicate', [
      { name: 'word/e\u0301.xml', content: 'one' },
      { name: 'word/é.xml', content: 'two' },
    ]],
  ])('rejects %s ZIP entry names', async (_label, additionalEntries) => {
    await expect(parseDocx({ additionalEntries })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it('rejects physically overlapping entries during preflight', async () => {
    await expect(parseDocx({
      additionalEntries: [{ name: 'overlap.bin', content: 'x', localHeaderOffset: 0 }],
    })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('rejects reverse-central-order overlaps during sorted preflight', async () => {
    await expect(parseDocx({
      additionalEntries: [
        {
          name: 'overlap-first.bin',
          content: 'a',
          declaredCompressedSize: 200,
          centralOrder: 10,
        },
        { name: 'overlap-second.bin', content: 'b', centralOrder: 9 },
      ],
    })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it.each([
    ['local-only encryption', {
      name: 'safe.bin', content: 'x', localEncrypted: true,
    }],
    ['local path mismatch', {
      name: 'safe.bin', localName: '../escape.bin', content: 'x',
    }],
  ])('rejects %s hidden from central ZIP metadata', async (_label, entry) => {
    await expect(parseDocx({ additionalEntries: [entry] })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it('rejects an unsafe raw path masked by a Unicode Path extra field', async () => {
    await expect(parseDocx({
      additionalEntries: [{
        name: '../masked.bin',
        unicodePath: 'safe.bin',
        utf8Filename: false,
        content: 'x',
      }],
    })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('accepts a safe raw path with a valid Unicode Path extra field', async () => {
    await expect(parseDocx({
      additionalEntries: [{
        name: 'legacy-name.bin',
        unicodePath: 'renamed.bin',
        utf8Filename: false,
        content: 'x',
      }],
    })).resolves.toHaveLength(1)
  })

  it('rejects prepended archive data by requiring the minimum entry offset to be zero', async () => {
    await expect(parseDocx({ prefix: Buffer.from('SFX!') })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it('counts a declared oversized unselected entry toward total expansion', async () => {
    await expect(parseDocx({
      additionalEntries: [{
        name: 'media/unselected.bin',
        content: 'x',
        declaredUncompressedSize: 400,
      }],
    }, {
      limits: injectedDocxLimits({ maxDocxExpandedBytes: 1_200 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it.each([
    ['entry count', {}, { maxDocxEntries: 2 }],
    ['total declared expansion', {}, { maxDocxExpandedBytes: 600 }],
    ['selected XML expansion', {}, { maxDocxSelectedXmlBytes: 600 }],
    ['raw filename bytes', {
      additionalEntries: [{ name: `word/${'é'.repeat(8)}.bin`, content: 'x' }],
    }, { maxDocxRawFilenameBytes: 20 }],
    ['zero compressed bytes with output', {
      additionalEntries: [{ name: 'zero.bin', content: 'x', declaredCompressedSize: 0 }],
    }, {}],
    ['compression ratio', {
      additionalEntries: [{
        name: 'ratio.bin', content: 'A'.repeat(512), compression: 'deflate' as const,
      }],
    }, { minDocxCompressionRatioBytes: 64, maxDocxCompressionRatio: 2 }],
  ])('maps the %s limit to permanent DOCUMENT_RESOURCE_LIMIT_EXCEEDED', async (
    _label,
    fixture,
    limits,
  ) => {
    await expect(parseDocx(fixture, { limits: injectedDocxLimits(limits) })).rejects.toEqual(
      expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'),
    )
  })

  it.each([
    ['canonical text units', { maxCanonicalTextUnits: 20 }],
    ['document blocks', { maxDocumentBlocks: 1 }],
    ['source spans', { maxSourceSpans: 1 }],
  ])('enforces the shared %s cap for DOCX output', async (_label, limits) => {
    const bodyXml = '<w:p><w:r><w:t>Alpha must comply.</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Beta shall comply.</w:t></w:r></w:p>'
    await expect(parseDocx({ bodyXml }, { limits })).rejects.toEqual(
      expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'),
    )
  })

  it('rejects DOCTYPE and unsupported XML encodings as INVALID_DOCX', async () => {
    const doctype = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<!DOCTYPE w:document [<!ENTITY x "must">]>' +
      `<w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`
    const unknownEncoding = wordDocumentXml(
      '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>',
      { encoding: 'ISO-8859-1' },
    )

    await expect(parseDocx({ documentXml: doctype })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
    await expect(parseDocx({ documentXml: unknownEncoding })).rejects.toEqual(
      expectParserCode('INVALID_DOCX'),
    )
  })

  it.each([
    ['malformed document XML', { documentXml: '<w:document' }],
    ['malformed styles XML', { stylesXml: '<w:styles' }],
    ['malformed numbering XML', { numberingXml: '<w:numbering' }],
    ['DOCTYPE in UTF-16 auxiliary XML', {
      stylesXml: utf16Encoded(
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE w:styles><w:styles xmlns:w="${WORDPROCESSINGML_NAMESPACE}"/>`,
        'le',
      ),
    }],
  ])('rejects %s', async (_label, fixture) => {
    await expect(parseDocx(fixture)).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('rejects a VBA content type declaration without a VBA payload entry', async () => {
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>
      </Types>`

    await expect(parseDocx({ contentTypesXml })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('resolves the main part content type through an OPC Default when no Override exists', async () => {
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`

    await expect(parseDocx({ contentTypesXml })).resolves.toHaveLength(1)
  })

  it('rejects rebinding the recognized WordprocessingML prefix in a descendant', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}"><w:body>
        <w:p xmlns:w="urn:evil"><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>
      </w:body></w:document>`

    await expect(parseDocx({ documentXml })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it('rejects rebinding the recognized Word 2010 paragraph-ID prefix', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="${WORDPROCESSINGML_NAMESPACE}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
        <w:body><w:p xmlns:w14="urn:evil" w14:paraId="DEADBEEF">
          <w:r><w:t>Supplier must comply.</w:t></w:r>
        </w:p></w:body>
      </w:document>`

    await expect(parseDocx({ documentXml })).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it.each([
    ['content-type Override', {
      contentTypesXml: `<?xml version="1.0" encoding="UTF-8"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" xmlns:evil="urn:evil">
          <evil:Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>`,
    }],
    ['root Relationship', {
      relationshipsXml: `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:evil="urn:evil">
          <evil:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`,
    }],
  ])('rejects a namespace-spoofed package %s element', async (_label, fixture) => {
    await expect(parseDocx(fixture)).rejects.toEqual(expectParserCode('INVALID_DOCX'))
  })

  it.each([
    ['entity expansion',
      '<w:p><w:r><w:t>Supplier must &amp;&amp;&amp; comply.</w:t></w:r></w:p>',
      { maxXmlEntityExpansions: 2 }],
    ['nested tags',
      '<w:customXml>'.repeat(8) +
        '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>' +
        '</w:customXml>'.repeat(8),
      { maxXmlNestingDepth: 8 }],
  ])('maps the %s XML bound to DOCUMENT_RESOURCE_LIMIT_EXCEEDED', async (
    _label,
    bodyXml,
    limits,
  ) => {
    await expect(parseDocx({ bodyXml }, { limits: injectedDocxLimits(limits) })).rejects.toEqual(
      expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'),
    )
  })

  it('does not count literal entity text inside comments or CDATA toward expansion limits', async () => {
    const literals = '&amp;'.repeat(1_001)
    const bodyXml = `<!--${literals}--><w:p><w:r><w:t><![CDATA[${literals}]]></w:t>` +
      '<w:t>Supplier must comply.</w:t></w:r></w:p>'

    await expect(parseDocx({ bodyXml }, {
      limits: injectedDocxLimits({ maxXmlEntityExpansions: 2 }),
    })).resolves.toHaveLength(1)
  })
})

describe('F. bounded digital PDF extraction', () => {
  it('maps syntactically invalid PDF bytes after format dispatch', async () => {
    await expect(parsePdf(Buffer.from('not a PDF document'))).rejects.toEqual(
      expectParserCode('INVALID_PDF'),
    )
  })

  it('uses fixed fixture metadata and produces byte-identical PDF builds', async () => {
    const first = await orderedTwoPagePdfBuffer()
    const second = await orderedTwoPagePdfBuffer()

    expect(first.equals(second)).toBe(true)
  })

  it('orders pages and visual lines, joins split runs, carries sections, and preserves input ownership', async () => {
    const content = await orderedTwoPagePdfBuffer()
    const file = pdfFile(content)
    const original = Buffer.from(file.content)
    const originalSha = file.sha256
    const parser = new DigitalDocumentParser()
    const task = parseTask(file)

    const first = await parser.parse(file, task, FIXED_NOW, signal())
    const second = await parser.parse(file, task, FIXED_NOW, signal())

    expect(first.map((item) => [item.code, item.description])).toEqual([
      ['REQ-0001', 'Supplier must comply.'],
      ['REQ-0002', 'Lower shall remain second.'],
      ['REQ-0003', 'Left column must be first.'],
      ['REQ-0004', 'Right column shall be second.'],
    ])
    expect(first.map((item) => pdfLocator(item.sourceLocator).regions[0]?.page)).toEqual([
      1, 1, 2, 2,
    ])
    expect(first.map((item) => pdfLocator(item.sourceLocator).sectionPath)).toEqual([
      ['Scope'], ['Scope'], ['Scope'], ['Scope'],
    ])
    expect(pdfLocator(first[0]!.sourceLocator).regions).toHaveLength(2)
    expect(first.map((item) => item.description)).toEqual(
      second.map((item) => item.description),
    )
    expect(file.content.equals(original)).toBe(true)
    expect(file.content.length).toBe(original.length)
    expect(file.sha256).toBe(originalSha)
  })

  it('serializes canonical PDF blocks and leaves inserted spaces outside physical source spans', async () => {
    const document = await extractPdfDocument(await orderedTwoPagePdfBuffer())

    expect(document.canonicalText).toBe([
      '1. Scope',
      'Supplier must comply.',
      'Lower shall remain second.',
      'Left column must be first.',
      'Right column shall be second.',
      'Left continuation.',
      'Right continuation.',
    ].join('\n'))
    expect(document.blocks.slice(0, 3).map((block) => ({
      kind: block.kind,
      text: block.text,
      textStart: block.textStart,
      textEnd: block.textEnd,
    }))).toEqual([
      { kind: 'heading', text: '1. Scope', textStart: 0, textEnd: 8 },
      { kind: 'paragraph', text: 'Supplier must comply.', textStart: 9, textEnd: 30 },
      { kind: 'paragraph', text: 'Lower shall remain second.', textStart: 31, textEnd: 57 },
    ])
    expect(document.blocks[1]!.sourceSpans.map((span) => [span.textStart, span.textEnd]))
      .toEqual([[9, 17], [18, 30]])
  })

  it('requires multiple safe heading signals and never classifies requirement text as a heading', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Large weak title', x: 72, y: 740, size: 20, font: 'bold' },
      { text: 'Supplier must remain body.', x: 72, y: 700, size: 20, font: 'bold' },
      { text: 'Vendor shall follow.', x: 72, y: 660, size: 12 },
    ] }] })

    const requirements = await parsePdf(content)

    expect(requirements.map((item) => item.description)).toEqual([
      'Supplier must remain body.',
      'Vendor shall follow.',
    ])
    expect(requirements.map((item) => pdfLocator(item.sourceLocator).sectionPath)).toEqual([
      [], [],
    ])
  })

  it('derives non-numbered heading levels from deterministic font-size ranks', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Major', x: 265, y: 760, size: 24, font: 'bold' },
      { text: 'Supplier must comply.', x: 72, y: 680 },
      { text: 'Context one', x: 72, y: 660 },
      { text: 'Context two', x: 72, y: 640 },
      { text: 'Context three', x: 72, y: 620 },
      { text: 'Subsection', x: 255, y: 540, size: 18, font: 'bold' },
      { text: 'Vendor shall comply.', x: 72, y: 460 },
      { text: 'Context four', x: 72, y: 440 },
      { text: 'Context five', x: 72, y: 420 },
      { text: 'Context six', x: 72, y: 400 },
    ] }] })

    const [document, requirements] = await Promise.all([
      extractPdfDocument(content),
      parsePdf(content),
    ])

    expect(document.blocks.filter((block) => block.kind === 'heading').map((block) => block.text))
      .toEqual(['Major', 'Subsection'])
    expect(requirements.map((item) => pdfLocator(item.sourceLocator).sectionPath)).toEqual([
      ['Major'],
      ['Major', 'Subsection'],
    ])
  })

  it('buckets negligible font-size drift into one stable non-numbered heading rank', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: '1. Root', x: 72, y: 780, size: 20, font: 'bold' },
      { text: 'Root supplier must comply.', x: 72, y: 720 },
      { text: 'Root context one', x: 72, y: 700 },
      { text: 'Root context two', x: 72, y: 680 },
      { text: 'Root context three', x: 72, y: 660 },
      { text: 'First Area', x: 255, y: 580, size: 18.00001, font: 'bold' },
      { text: 'First vendor shall comply.', x: 72, y: 500 },
      { text: 'First context one', x: 72, y: 480 },
      { text: 'First context two', x: 72, y: 460 },
      { text: 'First context three', x: 72, y: 440 },
      { text: 'Second Area', x: 250, y: 360, size: 18, font: 'bold' },
      { text: 'Second bidder must comply.', x: 72, y: 280 },
      { text: 'Second context one', x: 72, y: 260 },
      { text: 'Second context two', x: 72, y: 240 },
      { text: 'Second context three', x: 72, y: 220 },
    ] }] })

    const requirements = await parsePdf(content)

    expect(requirements.map((item) => pdfLocator(item.sourceLocator).sectionPath)).toEqual([
      ['Root'],
      ['Root', 'First Area'],
      ['Root', 'Second Area'],
    ])
  })

  it('recognizes three stable aligned rows as row-major table cells', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Criterion', x: 72, y: 720, font: 'bold' },
      { text: 'Response', x: 330, y: 720, font: 'bold' },
      { text: 'Supplier must sign.', x: 72, y: 690 },
      { text: 'Evidence A', x: 330, y: 690 },
      { text: 'Evidence B', x: 72, y: 660 },
      { text: 'Vendor shall seal.', x: 330, y: 660 },
    ] }] })

    const [requirements, document] = await Promise.all([
      parsePdf(content),
      extractPdfDocument(content),
    ])

    expect(requirements.map((item) => item.description)).toEqual([
      'Supplier must sign.',
      'Vendor shall seal.',
    ])
    expect(document.blocks.map((block) => block.kind)).toEqual([
      'table-cell', 'table-cell', 'table-cell',
      'table-cell', 'table-cell', 'table-cell',
    ])
    expect(document.blocks.map((block) => block.text)).toEqual([
      'Criterion', 'Response', 'Supplier must sign.',
      'Evidence A', 'Evidence B', 'Vendor shall seal.',
    ])
  })

  it('recognizes a stable table band between a heading and trailing paragraph', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: '1. Evaluation', x: 72, y: 760, size: 20, font: 'bold' },
      { text: 'Criterion', x: 72, y: 710, font: 'bold' },
      { text: 'Response', x: 330, y: 710, font: 'bold' },
      { text: 'Supplier must sign.', x: 72, y: 680 },
      { text: 'Evidence A', x: 330, y: 680 },
      { text: 'Evidence B', x: 72, y: 650 },
      { text: 'Vendor shall seal.', x: 330, y: 650 },
      { text: 'Trailing supplier must comply.', x: 72, y: 600 },
    ] }] })

    const [document, requirements] = await Promise.all([
      extractPdfDocument(content),
      parsePdf(content),
    ])

    expect(document.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'table-cell', 'table-cell', 'table-cell',
      'table-cell', 'table-cell', 'table-cell',
      'paragraph',
    ])
    expect(requirements.map((item) => pdfLocator(item.sourceLocator).sectionPath)).toEqual([
      ['Evaluation'], ['Evaluation'], ['Evaluation'],
    ])
  })

  it('falls back from a two-row alignment and lets a safe paragraph heading update sections', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: '1. Scope', x: 72, y: 740, size: 20, font: 'bold' },
      { text: 'Context left', x: 72, y: 700 },
      { text: 'Context right', x: 330, y: 700 },
      { text: 'Other', x: 72, y: 660 },
      { text: 'Supplier must comply.', x: 330, y: 660 },
    ] }] })

    const [[requirement], document] = await Promise.all([
      parsePdf(content),
      extractPdfDocument(content),
    ])

    expect(pdfLocator(requirement!.sourceLocator).sectionPath).toEqual(['Scope'])
    expect(document.blocks.every((block) => block.kind !== 'table-cell')).toBe(true)
  })

  it('uses column-major reading order only after a persistent wide gutter', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Right must be upper.', x: 340, y: 720 },
      { text: 'Left context one.', x: 72, y: 705 },
      { text: 'Right shall be lower.', x: 340, y: 680 },
      { text: 'Left must be upper.', x: 72, y: 665 },
      { text: 'Right context two.', x: 340, y: 640 },
      { text: 'Left shall be lower.', x: 72, y: 625 },
    ] }] })

    const requirements = await parsePdf(content)

    expect(requirements.map((item) => item.description)).toEqual([
      'Left must be upper.',
      'Left shall be lower.',
      'Right must be upper.',
      'Right shall be lower.',
    ])
  })

  it('limits column-major ordering to a band bounded by full-width paragraphs', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: '1. Evaluation', x: 72, y: 760, size: 20, font: 'bold' },
      { text: 'Right must be upper.', x: 340, y: 710 },
      { text: 'Left context one.', x: 72, y: 695 },
      { text: 'Right shall be lower.', x: 340, y: 670 },
      { text: 'Left must be upper.', x: 72, y: 655 },
      { text: 'Right context two.', x: 340, y: 630 },
      { text: 'Left shall be lower.', x: 72, y: 615 },
      { text: 'Trailing vendor must comply.', x: 72, y: 560 },
    ] }] })

    const [document, requirements] = await Promise.all([
      extractPdfDocument(content),
      parsePdf(content),
    ])

    expect(document.blocks[0]?.kind).toBe('heading')
    expect(requirements.map((item) => item.description)).toEqual([
      'Left must be upper.',
      'Left shall be lower.',
      'Right must be upper.',
      'Right shall be lower.',
      'Trailing vendor must comply.',
    ])
    expect(requirements.every((item) =>
      pdfLocator(item.sourceLocator).sectionPath.join('/') === 'Evaluation'
    )).toBe(true)
  })

  it('composes NFC across adjacent items and unions the unsafe item boundary', async () => {
    const content = combiningRunPdfBuffer()
    const [document, [requirement]] = await Promise.all([
      extractPdfDocument(content),
      parsePdf(content),
    ])

    expect(document.canonicalText).toBe('Café must comply.')
    expect(document.canonicalText).toBe(document.canonicalText.normalize('NFC'))
    expect(document.blocks[0]!.sourceSpans.map((span) => [span.textStart, span.textEnd]))
      .toEqual([[0, 4], [5, 17]])
    expect(requirement!.description).toBe('Café must comply.')
    expect(pdfLocator(requirement!.sourceLocator).regions).toHaveLength(2)
  })

  it('does not let fully clipped text borrow a neighboring visible region', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'A', x: 590, y: 700 },
      { text: 'Supplier must comply.', x: 600, y: 700, font: 'bold' },
    ] }] })

    const [document, requirements] = await Promise.all([
      extractPdfDocument(content),
      parsePdf(content),
    ])

    expect(document.canonicalText).toBe('A')
    expect(requirements).toEqual([])
  })

  it('retains the complete contributing item region for a partial sentence overlap', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Context. Supplier must comply.', x: 72, y: 700 },
    ] }] })

    const [requirement] = await parsePdf(content)
    const [region] = pdfLocator(requirement!.sourceLocator).regions

    expect(requirement!.description).toBe('Supplier must comply.')
    expect(region!.bbox.x).toBe(0.12)
  })

  it('normalizes a CropBox, rotation, and UserUnit bbox with a top-left viewport origin', async () => {
    const content = await pdfBuffer({ pages: [{
      cropBox: { x: 50, y: 100, width: 500, height: 600 },
      rotation: 90,
      userUnit: 2,
      runs: [{ text: 'Rotated must comply.', x: 100, y: 650, size: 12 }],
    }] })

    const [requirement] = await parsePdf(content)
    const [region] = pdfLocator(requirement!.sourceLocator).regions

    expect(region).toEqual({
      page: 1,
      bbox: { x: 0.912428, y: 0.1, width: 0.022344, height: 0.23208 },
    })
  })

  it('clips partially out-of-viewport glyph boxes before six-place normalization', async () => {
    const content = await pdfBuffer({ pages: [{
      cropBox: { x: 50, y: 100, width: 500, height: 600 },
      rotation: 90,
      userUnit: 2,
      runs: [{ text: 'Supplier must comply.', x: 100, y: 695, size: 12 }],
    }] })

    const [requirement] = await parsePdf(content)
    const bbox = pdfLocator(requirement!.sourceLocator).regions[0]!.bbox

    expect(bbox).toEqual({ x: 0.987428, y: 0.1, width: 0.012572, height: 0.236064 })
    expect(Object.values(bbox).every(Number.isFinite)).toBe(true)
    expect(Object.is(bbox.x, -0)).toBe(false)
    expect(bbox.x + bbox.width).toBeLessThanOrEqual(1)
    expect(bbox.y + bbox.height).toBeLessThanOrEqual(1)
  })

  it.each([
    ['empty bytes', Buffer.alloc(0)],
    ['garbage bytes', Buffer.from('not a PDF document')],
  ])('maps %s to permanent INVALID_PDF', async (_label, content) => {
    await expect(parsePdf(content)).rejects.toEqual(expectParserCode('INVALID_PDF'))
  })

  it('maps truncated input and a damaged content stream to permanent INVALID_PDF', async () => {
    const valid = await orderedTwoPagePdfBuffer()
    const truncated = valid.subarray(0, Math.floor(valid.length / 2))
    const corrupted = corruptFirstPdfStream(valid)

    await expect(parsePdf(truncated)).rejects.toEqual(expectParserCode('INVALID_PDF'))
    await expect(parsePdf(corrupted)).rejects.toEqual(expectParserCode('INVALID_PDF'))
  })

  it('rejects inaccessible encrypted documents without accepting a password channel', async () => {
    await expect(parsePdf(encryptedPdfBuffer())).rejects.toEqual(
      expectParserCode('PDF_ENCRYPTED'),
    )
  })

  it.each([
    ['vector-only', { vectorOnly: true }],
    ['image-only', { imageOnly: true }],
  ])('maps a zero-text %s document to OCR_REQUIRED', async (_label, page) => {
    const content = await pdfBuffer({ pages: [page] })

    await expect(parsePdf(content)).rejects.toEqual(expectParserCode('OCR_REQUIRED'))
  })

  it('succeeds when an image-only page is followed by extractable digital text', async () => {
    const content = await pdfBuffer({ pages: [
      { imageOnly: true },
      { runs: [{ text: 'Supplier must comply.', x: 72, y: 700 }] },
    ] })

    const [requirement] = await parsePdf(content)

    expect(requirement!.description).toBe('Supplier must comply.')
    expect(pdfLocator(requirement!.sourceLocator).regions[0]?.page).toBe(2)
  })

  it('validates PDF extension and MIME metadata before invoking PDF.js', async () => {
    const content = await orderedTwoPagePdfBuffer()

    await expect(parsePdf(content, { file: { mediaType: 'text/plain' } })).rejects.toEqual(
      expectParserCode('FORMAT_MISMATCH'),
    )
    await expect(parsePdf(content, {
      file: { fileName: 'requirements.docx', mediaType: 'application/pdf' },
    })).rejects.toEqual(expectParserCode('FORMAT_MISMATCH'))
  })

  it('validates the stored source digest before handing owned bytes to PDF.js', async () => {
    const content = await orderedTwoPagePdfBuffer()

    await expect(parsePdf(content, {
      file: { sha256: '0'.repeat(64) },
    })).rejects.toEqual(expectParserCode('FORMAT_MISMATCH'))
  })

  it('snapshots validated bytes before the dynamic PDF import can yield', async () => {
    const original = await pdfBuffer({ pages: [{ runs: [
      { text: 'Supplier must comply.', x: 72, y: 700 },
    ] }] })
    const replacement = await pdfBuffer({ pages: [{ runs: [
      { text: 'Provider must comply.', x: 72, y: 700 },
    ] }] })
    expect(replacement.length).toBe(original.length)
    const file = pdfFile(original)
    const task = parseTask(file)
    const originalFileId = file.id
    const originalFileName = file.fileName
    const originalSha = file.sha256
    const originalTaskId = task.id
    const pending = new DigitalDocumentParser().parse(
      file,
      task,
      FIXED_NOW,
      signal(),
    )

    file.content.set(replacement)
    file.id = 'mutated-file-id'
    file.fileName = 'mutated.txt'
    file.mediaType = 'text/plain'
    file.sha256 = 'f'.repeat(64)
    task.id = 'mutated-task-id'
    task.fileId = file.id
    const [requirement] = await pending

    expect(requirement!.description).toBe('Supplier must comply.')
    expect(requirement!.fileId).toBe(originalFileId)
    expect(requirement!.taskId).toBe(originalTaskId)
    expect(pdfLocator(requirement!.sourceLocator)).toMatchObject({
      sourceFileName: originalFileName,
      sourceSha256: originalSha,
    })
  })

  it('preserves a pre-aborted signal reason before PDF.js loading', async () => {
    const controller = new AbortController()
    const reason = new Error('stop PDF parsing')
    controller.abort(reason)

    await expect(parsePdf(await orderedTwoPagePdfBuffer(), {
      signal: controller.signal,
    })).rejects.toBe(reason)
  })

  it('defensively enforces the input byte cap in the PDF extractor itself', async () => {
    const content = await orderedTwoPagePdfBuffer()

    await expect(extractPdfDocument(content, {
      maxInputBytes: content.length - 1,
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
    await expect(extractPdfDocument(content, {
      maxInputBytes: content.length,
    })).resolves.toMatchObject({ format: 'pdf' })
  })

  it('enforces the injectable PDF page limit before page extraction', async () => {
    const content = await pdfBuffer({ pages: [
      { runs: [{ text: 'First page context', x: 72, y: 700 }] },
      { runs: [{ text: 'Second page context', x: 72, y: 700 }] },
    ] })

    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxPdfPages: 2 }),
    })).resolves.toEqual([])
    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxPdfPages: 1 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('exports the production PDF page cap of one thousand pages', () => {
    expect((DEFAULT_PARSER_LIMITS as ParserLimits & { maxPdfPages: number }).maxPdfPages).toBe(1_000)
  })

  it('allows the exact canonical text limit and rejects the next UTF-16 unit', async () => {
    const quote = 'Supplier must comply.'
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: quote, x: 72, y: 700 },
    ] }] })

    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxCanonicalTextUnits: quote.length }),
    })).resolves.toHaveLength(1)
    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxCanonicalTextUnits: quote.length - 1 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('bounds all decoded TextItem units before NFC/layout allocation', async () => {
    const content = combiningRunPdfBuffer()

    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxCanonicalTextUnits: 18 }),
    })).resolves.toHaveLength(1)
    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxCanonicalTextUnits: 17 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('allows the exact PDF block limit and rejects the next block without truncation', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'First context line', x: 72, y: 700 },
      { text: 'Second context line', x: 72, y: 660 },
    ] }] })

    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxDocumentBlocks: 2 }),
    })).resolves.toEqual([])
    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxDocumentBlocks: 1 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })

  it('allows the exact PDF source-span limit and rejects the next span without truncation', async () => {
    const content = await pdfBuffer({ pages: [{ runs: [
      { text: 'Supplier ', x: 72, y: 700 },
      { text: 'must comply.', x: 119.352, y: 700, font: 'bold' },
    ] }] })

    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxSourceSpans: 2 }),
    })).resolves.toHaveLength(1)
    await expect(parsePdf(content, {
      limits: injectedPdfLimits({ maxSourceSpans: 1 }),
    })).rejects.toEqual(expectParserCode('DOCUMENT_RESOURCE_LIMIT_EXCEEDED'))
  })
})
