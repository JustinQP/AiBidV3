import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  destroy: vi.fn(),
  getDocument: vi.fn(),
  transform: vi.fn((left: number[], right: number[]) => [
    left[0]! * right[0]! + left[2]! * right[1]!,
    left[1]! * right[0]! + left[3]! * right[1]!,
    left[0]! * right[2]! + left[2]! * right[3]!,
    left[1]! * right[2]! + left[3]! * right[3]!,
    left[0]! * right[4]! + left[2]! * right[5]! + left[4]!,
    left[1]! * right[4]! + left[3]! * right[5]! + left[5]!,
  ]),
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: pdfMocks.getDocument,
  Util: {
    transform: pdfMocks.transform,
  },
}))

import { PdfDocumentExtractor } from '../src/infrastructure/parser/pdf-document-extractor.js'
import { DEFAULT_PARSER_LIMITS } from '../src/infrastructure/parser/parser-types.js'

interface FakeTextItem {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL: boolean
}

function item(
  str: string,
  x: number,
  options: { fontSize?: number; hasEOL?: boolean; width?: number; y?: number } = {},
): FakeTextItem {
  const fontSize = options.fontSize ?? 12
  return {
    str,
    dir: 'ltr',
    width: options.width ?? 100,
    height: str.length === 0 ? 0 : fontSize,
    transform: [fontSize, 0, 0, fontSize, x, options.y ?? 700],
    fontName: 'fixture-font',
    hasEOL: options.hasEOL ?? false,
  }
}

function configurePdf(items: FakeTextItem[]): void {
  pdfMocks.destroy.mockResolvedValue(undefined)
  pdfMocks.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          transform: [1, 0, 0, -1, 0, 800],
        }),
        getTextContent: async () => ({
          items,
          styles: {
            'fixture-font': {
              fontFamily: 'sans-serif',
              ascent: 0.9,
              descent: -0.2,
              vertical: false,
            },
          },
          lang: null,
        }),
        cleanup: pdfMocks.cleanup,
      }),
    }),
    destroy: pdfMocks.destroy,
  })
}

describe('PDF layout hints and loading-task cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['non-empty hasEOL', [
      item('Supplier must sign.', 72, { hasEOL: true }),
      item('Vendor shall seal.', 175, { width: 95 }),
    ]],
    ['blank hasEOL', [
      item('Supplier must sign.', 72),
      item('', 172, { hasEOL: true, width: 0 }),
      item('Vendor shall seal.', 175, { width: 95 }),
    ]],
  ])('uses %s only as a line-break hint', async (_label, items) => {
    configurePdf(items)

    const document = await new PdfDocumentExtractor().extract(
      Buffer.from('%PDF mocked input'),
      new AbortController().signal,
    )

    expect(document.canonicalText).toBe('Supplier must sign.\nVendor shall seal.')
    expect(document.blocks).toHaveLength(2)
    expect(document.blocks.map((block) => block.sourceSpans.length)).toEqual([1, 1])
  })

  it('keeps a same-baseline EOL heading in its own layout line and section', async () => {
    configurePdf([
      item('1. Scope', 72, { fontSize: 20, hasEOL: true, width: 80 }),
      item('Supplier must comply.', 175, { width: 120 }),
    ])

    const document = await new PdfDocumentExtractor().extract(
      Buffer.from('%PDF mocked input'),
      new AbortController().signal,
    )

    expect(document.blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph'])
    expect(document.blocks[0]?.sectionPath).toEqual(['Scope'])
    expect(document.blocks[1]?.sectionPath).toEqual(['Scope'])
  })

  it.each([
    ['block', { maxDocumentBlocks: 1, maxSourceSpans: 2 }],
    ['source-span', { maxDocumentBlocks: 2, maxSourceSpans: 1 }],
    ['canonical-text', {
      maxCanonicalTextUnits: 'Supplier must comply.'.length + 1,
      maxDocumentBlocks: 2,
      maxSourceSpans: 2,
    }],
  ])('ignores a trailing unlocatable combining hint after the exact %s cap', async (
    _label,
    limits,
  ) => {
    configurePdf([
      item('Supplier must comply.', 72, { hasEOL: true, width: 120 }),
      item('\u0301', 700, { width: 0 }),
    ])

    const document = await new PdfDocumentExtractor({
      ...DEFAULT_PARSER_LIMITS,
      ...limits,
    }).extract(Buffer.from('%PDF mocked input'), new AbortController().signal)

    expect(document.canonicalText).toBe('Supplier must comply.')
    expect(document.blocks).toHaveLength(1)
    expect(document.blocks[0]?.sourceSpans).toHaveLength(1)
  })

  it('cooperatively aborts a single huge text item before projecting its geometry', async () => {
    configurePdf([item('a'.repeat(250_000), 72, { width: 120 })])
    const reason = new Error('cancel huge PDF text item')
    let checks = 0
    let aborted = false
    const cooperativeSignal = {
      get aborted() { return aborted },
      get reason() { return reason },
      throwIfAborted: () => {
        checks += 1
        if (checks >= 20) {
          aborted = true
          throw reason
        }
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal

    await expect(new PdfDocumentExtractor().extract(
      Buffer.from('%PDF mocked input'),
      cooperativeSignal,
    )).rejects.toBe(reason)
    expect(pdfMocks.transform).not.toHaveBeenCalled()
  })

  it('destroys the loading task when abort wins immediately after listener registration', async () => {
    configurePdf([item('Supplier must sign.', 72)])
    const reason = new Error('abort registration race')
    let checks = 0
    let aborted = false
    const removeEventListener = vi.fn()
    const racingSignal = {
      get aborted() { return aborted },
      get reason() { return reason },
      throwIfAborted: () => {
        checks += 1
        if (checks === 3) {
          aborted = true
          throw reason
        }
      },
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal

    await expect(new PdfDocumentExtractor().extract(
      Buffer.from('%PDF mocked input'),
      racingSignal,
    )).rejects.toBe(reason)
    expect(pdfMocks.destroy).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  })
})
