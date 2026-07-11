import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  degrees,
  PDFDocument,
  PDFName,
  PDFNumber,
  StandardFonts,
} from 'pdf-lib'
import type { ParseTask, StoredProjectFile } from '../../src/domain/models.js'
import {
  DEFAULT_PARSER_LIMITS,
  type ParserLimits,
} from '../../src/infrastructure/parser/parser-types.js'
import { DigitalDocumentParser } from '../../src/infrastructure/parser/digital-document-parser.js'

export const FIXED_NOW = '2026-07-10T12:00:00.000Z'

export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PDF_MEDIA_TYPE = 'application/pdf'
export const WORDPROCESSINGML_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const WORDPROCESSINGML_STRICT_NAMESPACE =
  'http://purl.oclc.org/ooxml/wordprocessingml/main'
export const OFFICE_DOCUMENT_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
export const OFFICE_DOCUMENT_STRICT_RELATIONSHIP =
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'

const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = 0x5021

export interface ZipFixtureEntry {
  name: string | Buffer
  localName?: string | Buffer
  content: string | Buffer
  compression?: 'store' | 'deflate'
  encrypted?: boolean
  localEncrypted?: boolean
  utf8Filename?: boolean
  unicodePath?: string
  declaredCompressedSize?: number
  declaredUncompressedSize?: number
  declaredCrc32?: number
  localHeaderOffset?: number
  centralOrder?: number
}

export interface ZipFixtureOptions {
  prefix?: Buffer
}

export interface DocxFixtureOptions extends ZipFixtureOptions {
  bodyXml?: string
  documentXml?: string | Buffer
  contentTypesXml?: string | Buffer
  relationshipsXml?: string | Buffer
  stylesXml?: string | Buffer
  numberingXml?: string | Buffer
  namespace?: string
  relationshipType?: string
  relationshipTarget?: string
  relationshipTargetMode?: string
  mainContentType?: string
  documentEntry?: Omit<Partial<ZipFixtureEntry>, 'name' | 'content'>
  omitEntries?: string[]
  additionalEntries?: ZipFixtureEntry[]
}

export interface PdfTextRunFixture {
  text: string
  x: number
  y: number
  size?: number
  font?: 'regular' | 'bold'
}

export interface PdfPageFixture {
  width?: number
  height?: number
  cropBox?: { x: number; y: number; width: number; height: number }
  rotation?: 0 | 90 | 180 | 270
  userUnit?: number
  runs?: PdfTextRunFixture[]
  vectorOnly?: boolean
  imageOnly?: boolean
}

export interface PdfFixtureOptions {
  pages: PdfPageFixture[]
}

const PDF_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const ENCRYPTED_PDF_BASE64 =
  'JVBERi0xLjcKJcfsj6IKJSVJbnZvY2F0aW9uOiBncyAtcSAtZE5PUEFVU0UgLWRCQVRDSCAtc0RFVklDRT1wZGZ3cml0ZSAtZENvbXBhdGliaWxpdHlMZXZlbD0xLjcgLXNPd25lclBhc3N3b3JkPT8gLXNVc2VyUGFzc3dvcmQ9PyAtc091dHB1dEZpbGU9PyA/CjUgMCBvYmoKPDwvTGVuZ3RoIDYgMCBSL0ZpbHRlciAvRmxhdGVEZWNvZGU+PgpzdHJlYW0KC5wCnxfVR3SQmVwC2hGd9akpOKQ6NVI+uyaEz8RnCYbNt6sKH66jGZ4md52asiWbl63rBnBBMdcwmfznlQzHBAdCUBQT9xXdlHV6El54DmGikls00IwXK7WJ2kxWeoK5eBMcdNgxs5eK2GMknFUDLxncKpk4A//6EMim2ld2QRdQ9LuN2uyZw1Mc1uyONMYzlzIoGbaDZ++N3KD0wlrFllbxxt2HEoFlbmRzdHJlYW0KZW5kb2JqCjYgMCBvYmoKMTY3CmVuZG9iagoxMCAwIG9iago8PC9MZW5ndGggMTEgMCBSL0ZpbHRlciAvRmxhdGVEZWNvZGU+PgpzdHJlYW0Kwhc8wUA09eyzDC8M1MO0xsR7VbZmTPzTu1oovXNvJJEy7KmfGJRagXIzuUkLItATTgXBxiT/ffbBwDFVko0hLBro533aRWprfDNeEqKZc5LeeSp1jjlFcANGqKc0Ezq1Y4/ZiuyLzLR0uzQdJd3iQLNSYkn/VyTa5eoAZZxi618xZW5kc3RyZWFtCmVuZG9iagoxMSAwIG9iagoxMjkKZW5kb2JqCjE0IDAgb2JqCjw8L0xlbmd0aCAxNSAwIFIvRmlsdGVyIC9GbGF0ZURlY29kZT4+CnN0cmVhbQoAj3DoXC3psq9UDGlPnDf+2rsPJAw4OdB+nfd7v5i1oOSBZh2pG8h6Pu87ZW5kc3RyZWFtCmVuZG9iagoxNSAwIG9iago0MwplbmRvYmoKNCAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3ggWzAgMCA2MDAgODAwXQovUm90YXRlIDAvUGFyZW50IDMgMCBSCi9SZXNvdXJjZXM8PC9Qcm9jU2V0Wy9QREYgL1RleHRdCi9Gb250IDggMCBSCj4+Ci9Db250ZW50cyA1IDAgUgovQ3JvcEJveCBbNTAgMTAwIDU1MCA3MDBdCj4+CmVuZG9iago5IDAgb2JqCjw8L1R5cGUvUGFnZS9NZWRpYUJveCBbMCAwIDgwMCA2MDBdCi9Sb3RhdGUgMjcwL1BhcmVudCAzIDAgUgovUmVzb3VyY2VzPDwvUHJvY1NldFsvUERGIC9UZXh0XQovRm9udCAxMiAwIFIKPj4KL0NvbnRlbnRzIDEwIDAgUgovQ3JvcEJveCBbMTAwIDUwIDcwMCA1NTBdCj4+CmVuZG9iagoxMyAwIG9iago8PC9UeXBlL1BhZ2UvTWVkaWFCb3ggWzAgMCAzMDAgNDAwXQovUGFyZW50IDMgMCBSCi9SZXNvdXJjZXM8PC9Qcm9jU2V0Wy9QREZdCj4+Ci9Db250ZW50cyAxNCAwIFIKPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFsKNCAwIFIKOSAwIFIKMTMgMCBSCl0gL0NvdW50IDMKPj4KZW5kb2JqCjEgMCBvYmoKPDwvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMyAwIFIKL01ldGFkYXRhIDE2IDAgUgo+PgplbmRvYmoKOCAwIG9iago8PC9SNwo3IDAgUj4+CmVuZG9iagoxMiAwIG9iago8PC9SNwo3IDAgUj4+CmVuZG9iago3IDAgb2JqCjw8L0Jhc2VGb250L0hlbHZldGljYS9UeXBlL0ZvbnQKL0VuY29kaW5nL1dpbkFuc2lFbmNvZGluZy9TdWJ0eXBlL1R5cGUxPj4KZW5kb2JqCjE2IDAgb2JqCjw8L1R5cGUvTWV0YWRhdGEKL1N1YnR5cGUvWE1ML0xlbmd0aCAxMjA5Pj5zdHJlYW0KPD94cGFja2V0IGJlZ2luPSfvu78nIGlkPSdXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQnPz4KPD9hZG9iZS14YXAtZmlsdGVycyBlc2M9IkNSTEYiPz4KPHg6eG1wbWV0YSB4bWxuczp4PSdhZG9iZTpuczptZXRhLycgeDp4bXB0az0nWE1QIHRvb2xraXQgMi45LjEtMTMsIGZyYW1ld29yayAxLjYnPgo8cmRmOlJERiB4bWxuczpyZGY9J2h0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMnIHhtbG5zOmlYPSdodHRwOi8vbnMuYWRvYmUuY29tL2lYLzEuMC8nPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczpwZGY9J2h0dHA6Ly9ucy5hZG9iZS5jb20vcGRmLzEuMy8nIHBkZjpQcm9kdWNlcj0nR1BMIEdob3N0c2NyaXB0IDEwLjAyLjEnLz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSdodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvJz48eG1wOk1vZGlmeURhdGU+MjAyNi0wNy0xMVQwMDoxMTozMC0wNDowMDwveG1wOk1vZGlmeURhdGU+Cjx4bXA6Q3JlYXRlRGF0ZT4yMDI2LTA3LTExVDAwOjExOjMwLTA0OjAwPC94bXA6Q3JlYXRlRGF0ZT4KPHhtcDpDcmVhdG9yVG9vbD5wZGYtbGliIChodHRwczovL2dpdGh1Yi5jb20vSG9wZGluZy9wZGYtbGliKTwveG1wOkNyZWF0b3JUb29sPjwvcmRmOkRlc2NyaXB0aW9uPgo8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4YXBNTT0naHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLycgeGFwTU06RG9jdW1lbnRJRD0ndXVpZDoyNGU1YjI3Ni1iNGZiLTExZmMtMDAwMC1kNzZmYjU5ODg5NTAnLz4KPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6ZGM9J2h0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvJyBkYzpmb3JtYXQ9J2FwcGxpY2F0aW9uL3BkZic+PGRjOnRpdGxlPjxyZGY6QWx0PjxyZGY6bGkgeG1sOmxhbmc9J3gtZGVmYXVsdCc+VW50aXRsZWQ8L3JkZjpsaT48L3JkZjpBbHQ+PC9kYzp0aXRsZT48L3JkZjpEZXNjcmlwdGlvbj4KPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSd3Jz8+CmVuZHN0cmVhbQplbmRvYmoKMiAwIG9iago8PC9Qcm9kdWNlcihCUXI8XDMzNFwyNTZcMjUxXDIzNlwyMjRcMDIzXDI0M1wpNlwwMDZcMzMxXDI2NlwyMDZNXDIwMlwyNzJIXDMzM1wzMDcpCi9DcmVhdGlvbkRhdGUoQTtcZixcMjUxXDM2MFwzNjZcMzMyXDMyMVFcMzYwa25HXDIzNlwyNDZcMjMyTVwyMzBcMjU1SlwzMDVcMzIxKQovTW9kRGF0ZShBO1xmLFwyNTFcMzYwXDM2NlwzMzJcMzIxUVwzNjBrbkdcMjM2XDI0NlwyMzJNXDIzMFwyNTVKXDMwNVwzMjEpCi9DcmVhdG9yKFwzNzNcMzc2PmxcMjMzXDI0MlwzMDZcMjEzXDM0ME1cMzAwN19cMDM3XDI1NVwzNjRcMjY3XVwyNTRcMjQyelwyMzVcMzY2XDI0NFwzMDZcMzMxbD5oXDAwNnJMXDI3N1wzNDZcXGVOXDAyMlwyNTJcMjMwXDI1MVwzMTNcMjE3XG5cMzcyXDMwMztcMjc3LFwzNDBcMDI2XDM2NlwwMzdcMzAxeC1cMzcxLVwzMjNcMjA2U1wyMTN9WVwyMzdcMjEwXGItOnJJQFpTZzBbXDI1N1wzNzZcMjMyXDMyMVwyNDcgXDAxNywhXDMyM1wwMjJcMjM3XDI2NSk+PmVuZG9iagoxNyAwIG9iago8PC9GaWx0ZXIgL1N0YW5kYXJkIC9WIDEgL0xlbmd0aCA0MCAvUiAyIC9QIC00IC9PICiS/g9EVK1MlkRpPzPAfLVPWH3OHiaC/p7OphB6HvYw3SkKL1UgKHBMuVpYhwtwe8mDnF6aJT3/oFR1QcDeCGhcXDA/1904oyk+PgplbmRvYmoKeHJlZgowIDE4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMTI4NSAwMDAwMCBuIAowMDAwMDAyNzg0IDAwMDAwIG4gCjAwMDAwMDEyMTMgMDAwMDAgbiAKMDAwMDAwMDc1OSAwMDAwMCBuIAowMDAwMDAwMTQ4IDAwMDAwIG4gCjAwMDAwMDAzODUgMDAwMDAgbiAKMDAwMDAwMTQwOSAwMDAwMCBuIAowMDAwMDAxMzUwIDAwMDAwIG4gCjAwMDAwMDA5MjYgMDAwMDAgbiAKMDAwMDAwMDQwNCAwMDAwMCBuIAowMDAwMDAwNjA1IDAwMDAwIG4gCjAwMDAwMDEzNzkgMDAwMDAgbiAKMDAwMDAwMTA5NyAwMDAwMCBuIAowMDAwMDAwNjI1IDAwMDAwIG4gCjAwMDAwMDA3NDAgMDAwMDAgbiAKMDAwMDAwMTQ5OCAwMDAwMCBuIAowMDAwMDAzMjk2IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgMTggL1Jvb3QgMSAwIFIgL0luZm8gMiAwIFIKL0lEIFs8MDBGMDMyNDQwNkJFQUFERkQ0QkI2RTI3NTExOTI0Mzk+PDAwRjAzMjQ0MDZCRUFBREZENEJCNkUyNzUxMTkyNDM5Pl0KL0VuY3J5cHQgMTcgMCBSID4+CnN0YXJ0eHJlZgozNDM4CiUlRU9GCg=='

export function textFile(
  value: string | Buffer,
  overrides: Partial<StoredProjectFile> = {},
): StoredProjectFile {
  const content = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  return {
    id: 'file-txt-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileName: 'requirements.txt',
    mediaType: 'text/plain',
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'parsing',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content,
    ...overrides,
  }
}

export function docxFile(
  value: Buffer | DocxFixtureOptions = {},
  overrides: Partial<StoredProjectFile> = {},
): StoredProjectFile {
  const content = Buffer.isBuffer(value) ? Buffer.from(value) : docxBuffer(value)
  return {
    id: 'file-docx-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileName: 'requirements.docx',
    mediaType: DOCX_MEDIA_TYPE,
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'parsing',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content,
    ...overrides,
  }
}

export function pdfFile(
  value: Buffer,
  overrides: Partial<StoredProjectFile> = {},
): StoredProjectFile {
  const content = Buffer.from(value)
  return {
    id: 'file-pdf-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    fileName: 'requirements.pdf',
    mediaType: PDF_MEDIA_TYPE,
    sizeBytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parseStatus: 'parsing',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    content,
    ...overrides,
  }
}

export async function pdfBuffer(options: PdfFixtureOptions): Promise<Buffer> {
  const document = await PDFDocument.create()
  const fixedDate = new Date('2024-01-02T03:04:05.000Z')
  document.setTitle('C2 deterministic fixture')
  document.setAuthor('AiBidV3')
  document.setSubject('PDF parser contract fixture')
  document.setKeywords(['C2', 'fixture'])
  document.setProducer('AiBidV3 fixture')
  document.setCreator('AiBidV3 fixture')
  document.setCreationDate(fixedDate)
  document.setModificationDate(fixedDate)
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  let pixel: Awaited<ReturnType<PDFDocument['embedPng']>> | undefined

  for (const fixture of options.pages) {
    const width = fixture.width ?? 600
    const height = fixture.height ?? 800
    const page = document.addPage([width, height])
    if (fixture.cropBox !== undefined) {
      page.setCropBox(
        fixture.cropBox.x,
        fixture.cropBox.y,
        fixture.cropBox.width,
        fixture.cropBox.height,
      )
    }
    if (fixture.rotation !== undefined) page.setRotation(degrees(fixture.rotation))
    if (fixture.userUnit !== undefined) {
      page.node.set(PDFName.of('UserUnit'), PDFNumber.of(fixture.userUnit))
    }
    if (fixture.vectorOnly) {
      page.drawRectangle({ x: 20, y: 20, width: 100, height: 100 })
    }
    if (fixture.imageOnly) {
      pixel ??= await document.embedPng(PDF_PIXEL_PNG)
      page.drawImage(pixel, { x: 0, y: 0, width, height })
    }
    for (const run of fixture.runs ?? []) {
      page.drawText(run.text, {
        x: run.x,
        y: run.y,
        size: run.size ?? 12,
        font: run.font === 'bold' ? bold : regular,
      })
    }
  }

  return Buffer.from(await document.save({ useObjectStreams: false }))
}

export async function orderedTwoPagePdfBuffer(): Promise<Buffer> {
  const document = await PDFDocument.create()
  const fixedDate = new Date('2024-01-02T03:04:05.000Z')
  document.setTitle('C2 deterministic fixture')
  document.setAuthor('AiBidV3')
  document.setSubject('PDF parser contract fixture')
  document.setKeywords(['C2', 'fixture'])
  document.setProducer('AiBidV3 fixture')
  document.setCreator('AiBidV3 fixture')
  document.setCreationDate(fixedDate)
  document.setModificationDate(fixedDate)
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const first = document.addPage([600, 800])
  first.drawText('Lower shall remain second.', { x: 72, y: 640, size: 12, font: regular })
  first.drawText('1. Scope', { x: 72, y: 730, size: 20, font: bold })
  const prefix = 'Supplier '
  const suffixX = 72 + regular.widthOfTextAtSize(prefix, 12)
  first.drawText(prefix, { x: 72, y: 680, size: 12, font: regular })
  first.drawText('must comply.', { x: suffixX, y: 680, size: 12, font: bold })
  const second = document.addPage([600, 800])
  second.drawText('Right column shall be second.', { x: 330, y: 700, size: 12, font: regular })
  second.drawText('Left column must be first.', { x: 72, y: 700, size: 12, font: regular })
  second.drawText('Left continuation.', { x: 72, y: 675, size: 12, font: regular })
  second.drawText('Right continuation.', { x: 330, y: 675, size: 12, font: regular })
  return Buffer.from(await document.save({ useObjectStreams: false }))
}

export function corruptFirstPdfStream(content: Buffer): Buffer {
  const corrupted = Buffer.from(content)
  const marker = Buffer.from('stream\n')
  const start = corrupted.indexOf(marker)
  if (start < 0 || start + marker.length + 30 >= corrupted.length) {
    throw new Error('PDF fixture does not contain a corruptible stream')
  }
  corrupted[start + marker.length + 30] = corrupted[start + marker.length + 30]! ^ 0xff
  return corrupted
}

export function encryptedPdfBuffer(): Buffer {
  return Buffer.from(ENCRYPTED_PDF_BASE64, 'base64')
}

export function combiningRunPdfBuffer(): Buffer {
  const content = [
    'BT',
    '/F1 12 Tf',
    '1 0 0 1 72 700 Tm',
    '(Cafe) Tj',
    '/F2 12 Tf',
    '(A) Tj',
    '/F1 12 Tf',
    '( must comply.) Tj',
    'ET',
  ].join('\n')
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] ' +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier ' +
      '/Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ' +
      '/Differences [65 /acutecomb] >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ])
}

function rawPdf(objects: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\x80\x80\x80\x80\n', 'binary')]
  const offsets = [0]
  let length = chunks[0]!.length
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(length)
    const object = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'binary')
    chunks.push(object)
    length += object.length
  }
  const xrefOffset = length
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    `startxref\n${xrefOffset}`,
    '%%EOF',
    '',
  ].join('\n')
  chunks.push(Buffer.from(xref, 'binary'))
  return Buffer.concat(chunks)
}

export function docxBuffer(options: DocxFixtureOptions = {}): Buffer {
  const namespace = options.namespace ?? WORDPROCESSINGML_NAMESPACE
  const documentXml = options.documentXml ?? xmlDocument(
    `<w:document xmlns:w="${namespace}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${options.bodyXml ?? '<w:p><w:r><w:t>Supplier must comply.</w:t></w:r></w:p>'}</w:body></w:document>`,
  )
  const entries: ZipFixtureEntry[] = [
    {
      name: '[Content_Types].xml',
      content: options.contentTypesXml ?? contentTypesXml(
        options.mainContentType ?? DOCX_MAIN_CONTENT_TYPE,
      ),
    },
    {
      name: '_rels/.rels',
      content: options.relationshipsXml ?? rootRelationshipsXml({
        type: options.relationshipType ?? OFFICE_DOCUMENT_RELATIONSHIP,
        target: options.relationshipTarget ?? 'word/document.xml',
        targetMode: options.relationshipTargetMode,
      }),
    },
    { name: 'word/document.xml', content: documentXml, ...options.documentEntry },
  ]
  if (options.stylesXml !== undefined) {
    entries.push({ name: 'word/styles.xml', content: options.stylesXml })
  }
  if (options.numberingXml !== undefined) {
    entries.push({ name: 'word/numbering.xml', content: options.numberingXml })
  }
  entries.push(...(options.additionalEntries ?? []))
  const omitted = new Set(options.omitEntries ?? [])
  return buildZip(entries.filter((entry) =>
    Buffer.isBuffer(entry.name) || !omitted.has(entry.name)
  ), options)
}

export function buildZip(
  entries: ZipFixtureEntry[],
  options: ZipFixtureOptions = {},
): Buffer {
  const prefix = options.prefix ?? Buffer.alloc(0)
  const localParts: Buffer[] = [prefix]
  const centralEntries: Array<{ order: number; parts: Buffer[] }> = []
  let offset = prefix.length
  let entryIndex = 0

  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? Buffer.from(entry.name) : Buffer.from(entry.name, 'utf8')
    const localNameValue = entry.localName ?? entry.name
    const localName = Buffer.isBuffer(localNameValue)
      ? Buffer.from(localNameValue)
      : Buffer.from(localNameValue, 'utf8')
    const content = typeof entry.content === 'string'
      ? Buffer.from(entry.content, 'utf8')
      : Buffer.from(entry.content)
    const compressionMethod = entry.compression === 'deflate' ? 8 : 0
    const compressed = compressionMethod === 8 ? deflateRawSync(content, { level: 9 }) : content
    const utf8Flag = entry.utf8Filename === false ? 0 : 0x800
    const flags = utf8Flag | (entry.encrypted ? 1 : 0)
    const localFlags = utf8Flag | ((entry.localEncrypted ?? entry.encrypted) ? 1 : 0)
    const checksum = entry.declaredCrc32 ?? crc32(content)
    const extra = entry.unicodePath === undefined
      ? Buffer.alloc(0)
      : unicodePathExtra(name, entry.unicodePath)
    const declaredCompressedSize = entry.declaredCompressedSize ?? compressed.length
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? content.length
    const localOffset = offset

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(localFlags, 6)
    localHeader.writeUInt16LE(compressionMethod, 8)
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10)
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(declaredCompressedSize, 18)
    localHeader.writeUInt32LE(declaredUncompressedSize, 22)
    localHeader.writeUInt16LE(localName.length, 26)
    localHeader.writeUInt16LE(extra.length, 28)
    localParts.push(localHeader, localName, extra, compressed)
    offset += localHeader.length + localName.length + extra.length + compressed.length

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x033f, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(compressionMethod, 10)
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12)
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(declaredCompressedSize, 20)
    centralHeader.writeUInt32LE(declaredUncompressedSize, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(extra.length, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(entry.localHeaderOffset ?? localOffset, 42)
    centralEntries.push({ order: entry.centralOrder ?? entryIndex, parts: [centralHeader, name, extra] })
    entryIndex += 1
  }

  const centralOffset = offset
  centralEntries.sort((left, right) => left.order - right.order)
  const centralDirectory = Buffer.concat(centralEntries.flatMap((entry) => entry.parts))
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

export async function parseDocx(
  value: Buffer | DocxFixtureOptions = {},
  options: {
    file?: Partial<StoredProjectFile>
    task?: Partial<ParseTask>
    limits?: Partial<ParserLimits>
    signal?: AbortSignal
  } = {},
) {
  const file = docxFile(value, options.file)
  const task = parseTask(file, options.task)
  return new DigitalDocumentParser(parserLimits(options.limits)).parse(
    file,
    task,
    FIXED_NOW,
    options.signal ?? new AbortController().signal,
  )
}

export async function parsePdf(
  value: Buffer,
  options: {
    file?: Partial<StoredProjectFile>
    task?: Partial<ParseTask>
    limits?: Partial<ParserLimits>
    signal?: AbortSignal
  } = {},
) {
  const file = pdfFile(value, options.file)
  const task = parseTask(file, options.task)
  return new DigitalDocumentParser(parserLimits(options.limits)).parse(
    file,
    task,
    FIXED_NOW,
    options.signal ?? new AbortController().signal,
  )
}

function xmlDocument(root: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${root}`
}

function contentTypesXml(mainContentType: string): string {
  return xmlDocument(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${mainContentType}"/>` +
    '</Types>',
  )
}

function rootRelationshipsXml(options: {
  type: string
  target: string
  targetMode: string | undefined
}): string {
  const targetMode = options.targetMode === undefined
    ? ''
    : ` TargetMode="${options.targetMode}"`
  return xmlDocument(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${options.type}" Target="${options.target}"${targetMode}/>` +
    '</Relationships>',
  )
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff
  for (const byte of content) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function unicodePathExtra(rawName: Buffer, unicodeName: string): Buffer {
  const encodedName = Buffer.from(unicodeName, 'utf8')
  const extra = Buffer.alloc(4 + 1 + 4 + encodedName.length)
  extra.writeUInt16LE(0x7075, 0)
  extra.writeUInt16LE(1 + 4 + encodedName.length, 2)
  extra.writeUInt8(1, 4)
  extra.writeUInt32LE(crc32(rawName), 5)
  encodedName.copy(extra, 9)
  return extra
}

export function parseTask(
  file: StoredProjectFile,
  overrides: Partial<ParseTask> = {},
): ParseTask {
  return {
    id: 'task-parse-1',
    tenantId: file.tenantId,
    projectId: file.projectId,
    fileId: file.id,
    type: 'document-parse-v1',
    status: 'running',
    progress: 10,
    attempt: 1,
    error: null,
    createdAt: FIXED_NOW,
    startedAt: FIXED_NOW,
    finishedAt: null,
    updatedAt: FIXED_NOW,
    ...overrides,
  }
}

export function parserLimits(overrides: Partial<ParserLimits> = {}): ParserLimits {
  return { ...DEFAULT_PARSER_LIMITS, ...overrides }
}

export async function parseText(
  value: string | Buffer,
  options: {
    file?: Partial<StoredProjectFile>
    task?: Partial<ParseTask>
    limits?: Partial<ParserLimits>
    signal?: AbortSignal
  } = {},
) {
  const file = textFile(value, options.file)
  const task = parseTask(file, options.task)
  const signal = options.signal ?? new AbortController().signal
  return new DigitalDocumentParser(parserLimits(options.limits)).parse(
    file,
    task,
    FIXED_NOW,
    signal,
  )
}
