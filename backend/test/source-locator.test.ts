import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeSourceText,
  createCanonicalSourceTextIndex,
  sha256Hex,
  validateRequirementEvidence,
  validateSourceLocator,
} from '../src/domain/source-locator.js'

const sourceFileId = '01FILESOURCELOCATOR00000000'
const sourceSha256 = 'a'.repeat(64)
const parserVersion = 'deterministic-rules-v1'

function realBase(
  canonicalText: string,
  quote: string,
  sourceFileName = 'requirements.txt',
) {
  const textStart = canonicalText.indexOf(quote)
  return {
    version: 1 as const,
    sourceFileId,
    sourceFileName,
    sourceRevision: 1 as const,
    sourceSha256,
    quote,
    quoteSha256: sha256Hex(quote),
    textStart,
    textEnd: textStart + quote.length,
    sectionPath: ['Scope', 'Hosting'],
    parserVersion,
  }
}

function txtLocator(canonicalText = 'Intro\nThe service must be available.\nTail') {
  const quote = 'The service must be available.'
  return {
    ...realBase(canonicalText, quote, 'requirements.txt'),
    kind: 'txt' as const,
    start: { line: 2, column: 0 },
    end: { line: 2, column: quote.length },
  }
}

function pdfLocator(canonicalText = 'The platform must encrypt data at rest.') {
  const quote = 'must encrypt data at rest'
  return {
    ...realBase(canonicalText, quote, 'requirements.pdf'),
    kind: 'pdf' as const,
    regions: [
      {
        page: 1,
        bbox: { x: 0.08, y: 0.31, width: 0.72, height: 0.05 },
      },
    ],
  }
}

function docxLocator(canonicalText = 'Heading\nSupplier must provide evidence.') {
  const quote = 'Supplier must provide evidence.'
  return {
    ...realBase(canonicalText, quote, 'requirements.docx'),
    kind: 'docx' as const,
    ranges: [
      {
        paragraphId: '00A1B2C3',
        paragraphIndex: 2,
        tablePath: [{ tableIndex: 0, rowIndex: 1, cellIndex: 2 }],
        charStart: 0,
        charEnd: quote.length,
      },
    ],
  }
}

describe('source locator contract', () => {
  it('canonicalizes newlines before NFC without collapsing whitespace', () => {
    expect(canonicalizeSourceText('Cafe\u0301\r\nA  B\rC\tD')).toBe('Caf\u00e9\nA  B\nC\tD')
  })

  it('accepts a quote whose hash and UTF-16 half-open offsets match canonical text', () => {
    const canonicalText = canonicalizeSourceText('Intro\r\nCafe\u0301 \ud83d\ude00 must comply\rTail')
    const quote = 'Caf\u00e9 \ud83d\ude00 must comply'
    const locator = {
      ...realBase(canonicalText, quote),
      kind: 'txt' as const,
      start: { line: 2, column: 0 },
      end: { line: 2, column: quote.length },
    }

    expect(validateSourceLocator(locator, { canonicalText })).toEqual(locator)
    expect(locator.quote).toBe(canonicalText.slice(locator.textStart, locator.textEnd))
  })

  it('validates exact slices and TXT positions through an unforgeable canonical text index', () => {
    const canonicalText = 'Intro\nCafe\u0301 must comply.\nTail'.normalize('NFC')
    const quote = 'Caf\u00e9 must comply.'
    const locator = {
      ...realBase(canonicalText, quote),
      kind: 'txt' as const,
      start: { line: 2, column: 0 },
      end: { line: 2, column: quote.length },
    }
    const canonicalTextIndex = createCanonicalSourceTextIndex(canonicalText)

    expect(validateSourceLocator(locator, { canonicalTextIndex })).toEqual(locator)
    expect(() => validateSourceLocator({
      ...locator,
      textStart: locator.textStart + 1,
      textEnd: locator.textEnd + 1,
    }, { canonicalTextIndex })).toThrow(/canonical text/i)
    expect(() => validateSourceLocator(locator, {
      canonicalTextIndex: {} as typeof canonicalTextIndex,
    })).toThrow(/canonical text index/i)
    expect(() => validateSourceLocator(locator, {
      canonicalText,
      canonicalTextIndex,
    })).toThrow(/canonical text.*either|either.*canonical text/i)
  })

  it('rejects non-LF or non-NFC input when building a canonical text index', () => {
    expect(() => createCanonicalSourceTextIndex('First\r\nSecond')).toThrow(/canonical/i)
    expect(() => createCanonicalSourceTextIndex('Cafe\u0301')).toThrow(/canonical/i)
  })

  it.each([
    ['carriage return', 'First line\rSecond line'],
    ['non-NFC text', 'Cafe\u0301 must comply'],
  ])('rejects a non-canonical %s quote without canonical-text context', (_label, quote) => {
    const locator = {
      ...realBase(quote, quote),
      kind: 'txt' as const,
      start: { line: 1, column: 0 },
      end: { line: 1, column: quote.length },
    }

    expect(() => validateSourceLocator(locator)).toThrow(/canonical/i)
  })

  it.each([
    ['quote hash', { quoteSha256: 'b'.repeat(64) }],
    ['uppercase hash', { quoteSha256: sha256Hex('The service must be available.').toUpperCase() }],
    ['file id', { sourceFileId: '01OTHERFILESOURCE000000000' }],
    ['file hash', { sourceSha256: 'b'.repeat(64) }],
  ])('rejects a mismatched %s', (_label, change) => {
    const canonicalText = 'Intro\nThe service must be available.\nTail'
    const locator = { ...txtLocator(canonicalText), ...change }

    expect(() =>
      validateSourceLocator(locator, {
        canonicalText,
        expectedSourceFileId: sourceFileId,
        expectedSourceSha256: sourceSha256,
      }),
    ).toThrow()
  })

  it('rejects quotes and offsets that do not match canonical text', () => {
    const canonicalText = 'A \ud83d\ude00 requirement'
    const valid = {
      ...realBase(canonicalText, '\ud83d\ude00 requirement'),
      kind: 'txt' as const,
      start: { line: 1, column: 2 },
      end: { line: 1, column: canonicalText.length },
    }

    expect(() => validateSourceLocator({ ...valid, quote: 'other' }, { canonicalText })).toThrow()
    expect(() => validateSourceLocator({ ...valid, textStart: 3 }, { canonicalText })).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, textEnd: valid.textStart, quote: '', quoteSha256: sha256Hex('') },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        {
          ...valid,
          textStart: 2,
          textEnd: 3,
          quote: canonicalText.slice(2, 3),
          quoteSha256: sha256Hex(canonicalText.slice(2, 3)),
        },
        { canonicalText },
      ),
    ).toThrow(/surrogate/i)
  })

  it('validates one-based PDF pages and finite normalized non-empty regions', () => {
    const canonicalText = 'The platform must encrypt data at rest.'
    const valid = pdfLocator(canonicalText)
    expect(validateSourceLocator(valid, { canonicalText })).toEqual(valid)

    expect(() => validateSourceLocator({ ...valid, regions: [] }, { canonicalText })).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, regions: [{ page: 0, bbox: valid.regions[0]!.bbox }] },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        {
          ...valid,
          regions: [{ page: 1, bbox: { x: 0.8, y: 0.1, width: 0.3, height: 0.2 } }],
        },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        {
          ...valid,
          regions: [{ page: 1, bbox: { x: Number.NaN, y: 0.1, width: 0.3, height: 0.2 } }],
        },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        {
          ...valid,
          regions: [{ page: 1, bbox: { x: 0.1, y: 0.1, width: 0, height: 0.2 } }],
        },
        { canonicalText },
      ),
    ).toThrow()
  })

  it('validates zero-based DOCX paragraph and table-cell ranges', () => {
    const canonicalText = 'Heading\nSupplier must provide evidence.'
    const valid = docxLocator(canonicalText)
    expect(validateSourceLocator(valid, { canonicalText })).toEqual(valid)
    expect(
      validateSourceLocator(
        {
          ...valid,
          ranges: [
            {
              paragraphId: null,
              paragraphIndex: 0,
              tablePath: [],
              charStart: 1,
              charEnd: 4,
            },
          ],
        },
        { canonicalText },
      ),
    ).toMatchObject({ kind: 'docx' })

    expect(() => validateSourceLocator({ ...valid, ranges: [] }, { canonicalText })).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, ranges: [{ ...valid.ranges[0]!, paragraphIndex: -1 }] },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        {
          ...valid,
          ranges: [
            {
              ...valid.ranges[0]!,
              tablePath: [{ tableIndex: 0, rowIndex: -1, cellIndex: 0 }],
            },
          ],
        },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, ranges: [{ ...valid.ranges[0]!, charEnd: 0 }] },
        { canonicalText },
      ),
    ).toThrow()
  })

  it('validates one-based TXT lines and zero-based UTF-16 columns', () => {
    const canonicalText = 'Intro\nThe service must be available.\nTail'
    const valid = txtLocator(canonicalText)
    expect(validateSourceLocator(valid, { canonicalText })).toEqual(valid)

    expect(() =>
      validateSourceLocator({ ...valid, start: { line: 0, column: 0 } }, { canonicalText }),
    ).toThrow()
    expect(() =>
      validateSourceLocator({ ...valid, start: { line: 2, column: -1 } }, { canonicalText }),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, end: { ...valid.start } },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator(
        { ...valid, start: { line: 3, column: 0 }, end: { line: 2, column: 1 } },
        { canonicalText },
      ),
    ).toThrow()
    expect(() =>
      validateSourceLocator({
        ...valid,
        end: { line: 2, column: valid.quote.length + 1 },
      }),
    ).toThrow()
  })

  it.each([
    null,
    [],
    {},
    { kind: 'pdf' },
    { ...pdfLocator(), version: 2 },
    { ...pdfLocator(), sourceRevision: 2 },
    { ...pdfLocator(), sectionPath: ['Scope', 2] },
    { ...pdfLocator(), parserVersion: '' },
    { ...pdfLocator(), kind: 'unknown' },
  ])('rejects malformed persisted locator JSON %#', (value) => {
    expect(() => validateSourceLocator(value)).toThrow()
  })

  it('rebuilds every locator variant and nested value into detached DTOs', () => {
    const fixture = {
      kind: 'development-fixture' as const,
      fileId: sourceFileId,
      fileName: 'requirements.txt',
      pageNumber: null,
      sectionPath: ['Fixture'],
      paragraphIndex: null,
      quote: 'Development fixture',
    }
    const pdf = pdfLocator()
    const docx = docxLocator()
    const txt = txtLocator()

    const rebuiltFixture = validateSourceLocator(fixture)
    const rebuiltPdf = validateSourceLocator(pdf)
    const rebuiltDocx = validateSourceLocator(docx)
    const rebuiltTxt = validateSourceLocator(txt)

    expect(rebuiltFixture).toEqual(fixture)
    expect(rebuiltFixture).not.toBe(fixture)
    expect(rebuiltFixture.sectionPath).not.toBe(fixture.sectionPath)
    expect(rebuiltPdf).toEqual(pdf)
    expect(rebuiltPdf).not.toBe(pdf)
    expect(rebuiltPdf.sectionPath).not.toBe(pdf.sectionPath)
    expect(rebuiltPdf.kind).toBe('pdf')
    if (rebuiltPdf.kind !== 'pdf') throw new Error('Expected rebuilt PDF locator')
    expect(rebuiltPdf.regions).not.toBe(pdf.regions)
    expect(rebuiltPdf.regions[0]).not.toBe(pdf.regions[0])
    expect(rebuiltPdf.regions[0]!.bbox).not.toBe(pdf.regions[0]!.bbox)
    expect(rebuiltDocx).toEqual(docx)
    expect(rebuiltDocx).not.toBe(docx)
    expect(rebuiltDocx.kind).toBe('docx')
    if (rebuiltDocx.kind !== 'docx') throw new Error('Expected rebuilt DOCX locator')
    expect(rebuiltDocx.ranges).not.toBe(docx.ranges)
    expect(rebuiltDocx.ranges[0]).not.toBe(docx.ranges[0])
    expect(rebuiltDocx.ranges[0]!.tablePath).not.toBe(docx.ranges[0]!.tablePath)
    expect(rebuiltDocx.ranges[0]!.tablePath[0]).not.toBe(docx.ranges[0]!.tablePath[0])
    expect(rebuiltTxt).toEqual(txt)
    expect(rebuiltTxt).not.toBe(txt)
    expect(rebuiltTxt.kind).toBe('txt')
    if (rebuiltTxt.kind !== 'txt') throw new Error('Expected rebuilt TXT locator')
    expect(rebuiltTxt.start).not.toBe(txt.start)
    expect(rebuiltTxt.end).not.toBe(txt.end)
  })

  it.each([
    ['extra top-level key', { ...txtLocator(), unexpected: true }],
    ['cross-kind key', { ...txtLocator(), regions: pdfLocator().regions }],
    ['own toJSON', { ...txtLocator(), toJSON: () => ({ kind: 'txt', version: 1 }) }],
    [
      'inherited kind',
      (() => {
        const locator = { ...txtLocator() } as Record<string, unknown>
        delete locator.kind
        return Object.assign(Object.create({ kind: 'txt' }) as object, locator)
      })(),
    ],
  ])('rejects a locator with %s', (_label, locator) => {
    expect(() => validateSourceLocator(locator)).toThrow()
  })

  it.each([
    [
      'PDF region',
      {
        ...pdfLocator(),
        regions: [{ ...pdfLocator().regions[0]!, unexpected: true }],
      },
    ],
    [
      'PDF bounding box',
      {
        ...pdfLocator(),
        regions: [
          {
            ...pdfLocator().regions[0]!,
            bbox: { ...pdfLocator().regions[0]!.bbox, unexpected: true },
          },
        ],
      },
    ],
    [
      'DOCX range',
      {
        ...docxLocator(),
        ranges: [{ ...docxLocator().ranges[0]!, unexpected: true }],
      },
    ],
    [
      'DOCX table path',
      {
        ...docxLocator(),
        ranges: [
          {
            ...docxLocator().ranges[0]!,
            tablePath: [{ ...docxLocator().ranges[0]!.tablePath[0]!, unexpected: true }],
          },
        ],
      },
    ],
    ['TXT position', { ...txtLocator(), start: { ...txtLocator().start, unexpected: true } }],
  ])('rejects an extra key in a nested %s object', (_label, locator) => {
    expect(() => validateSourceLocator(locator)).toThrow()
  })

  it('rejects inherited nested fields and sparse arrays', () => {
    const inheritedStart = Object.assign(Object.create({ line: 2 }) as object, { column: 0 })
    const sparseSectionPath = new Array<string>(2)
    sparseSectionPath[0] = 'Scope'

    expect(() => validateSourceLocator({ ...txtLocator(), start: inheritedStart })).toThrow()
    expect(() =>
      validateSourceLocator({ ...txtLocator(), sectionPath: sparseSectionPath }),
    ).toThrow(/dense/i)
  })

  it('keeps fixture evidence readable and enforces method, kind, and confidence consistency', () => {
    const fixture = {
      kind: 'development-fixture' as const,
      fileId: sourceFileId,
      fileName: 'requirements.txt',
      pageNumber: null,
      sectionPath: ['Fixture'],
      paragraphIndex: null,
      quote: 'Development fixture',
    }
    expect(
      validateRequirementEvidence({
        extractionMethod: 'development-fixture',
        confidence: null,
        sourceLocator: fixture,
      }),
    ).toEqual({ extractionMethod: 'development-fixture', confidence: null, sourceLocator: fixture })

    const real = txtLocator()
    for (const confidence of [0, 0.875, 0.1234, 1]) {
      expect(
        validateRequirementEvidence(
          {
            extractionMethod: 'deterministic-rules-v1',
            confidence,
            sourceLocator: real,
          },
          { expectedSourceFileId: sourceFileId, expectedSourceSha256: sourceSha256 },
        ),
      ).toMatchObject({ confidence })
    }

    for (const confidence of [
      null,
      -0.0001,
      0.12345,
      0.12340000000005,
      1.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() =>
        validateRequirementEvidence({
          extractionMethod: 'deterministic-rules-v1',
          confidence,
          sourceLocator: real,
        }),
      ).toThrow()
    }
    expect(() =>
      validateRequirementEvidence({
        extractionMethod: 'development-fixture',
        confidence: 0.5,
        sourceLocator: fixture,
      }),
    ).toThrow()
    expect(() =>
      validateRequirementEvidence({
        extractionMethod: 'development-fixture',
        confidence: null,
        sourceLocator: real,
      }),
    ).toThrow()
    expect(() =>
      validateRequirementEvidence({
        extractionMethod: 'deterministic-rules-v1',
        confidence: 0.5,
        sourceLocator: fixture,
      }),
    ).toThrow()
  })

  it('requires an exact extraction-method mapping when task type context is provided', () => {
    const fixture = {
      kind: 'development-fixture' as const,
      fileId: sourceFileId,
      fileName: 'requirements.txt',
      pageNumber: null,
      sectionPath: ['Fixture'],
      paragraphIndex: null,
      quote: 'Development fixture',
    }
    const real = txtLocator()

    expect(
      validateRequirementEvidence(
        {
          extractionMethod: 'development-fixture',
          confidence: null,
          sourceLocator: fixture,
        },
        { expectedTaskType: 'development-document-parse' },
      ),
    ).toMatchObject({ extractionMethod: 'development-fixture' })
    expect(
      validateRequirementEvidence(
        {
          extractionMethod: 'deterministic-rules-v1',
          confidence: 0.875,
          sourceLocator: real,
        },
        { expectedTaskType: 'document-parse-v1' },
      ),
    ).toMatchObject({ extractionMethod: 'deterministic-rules-v1' })

    for (const expectedTaskType of ['unknown-task-type', null, 42]) {
      expect(() =>
        validateRequirementEvidence(
          {
            extractionMethod: 'development-fixture',
            confidence: null,
            sourceLocator: fixture,
          },
          { expectedTaskType },
        ),
      ).toThrow(/inconsistent/i)
      expect(() =>
        validateRequirementEvidence(
          {
            extractionMethod: 'deterministic-rules-v1',
            confidence: 0.875,
            sourceLocator: real,
          },
          { expectedTaskType },
        ),
      ).toThrow(/inconsistent/i)
    }
  })

  it('ships a backward-compatible migration for task and evidence versions', async () => {
    const migration = await readFile(
      new URL('../migrations/0004_real_document_parser.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain('document-parse-v1')
    expect(migration).toContain('deterministic-rules-v1')
    expect(migration).toMatch(/DROP\s+CONSTRAINT\s+parse_tasks_type_check/i)
    expect(migration).toMatch(/DROP\s+CONSTRAINT\s+requirements_extraction_method_check/i)
    expect(migration).toMatch(/confidence\s+numeric\(5,4\)/i)
    expect(migration).toMatch(/confidence[^;]+(?:between\s+0\s+and\s+1|>=\s*0)[^;]+/is)
    expect(migration).toContain('development-fixture')
    expect(migration).toMatch(/source_locator\s*->>\s*'kind'/)
    expect(migration).toMatch(/source_locator\s*->\s*'version'\s*=\s*'1'::jsonb/)
  })
})
