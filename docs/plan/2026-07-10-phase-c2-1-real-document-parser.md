# Phase C2.1 Real Document Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Every production behavior starts with a failing test.

**Goal:** Replace the Phase C1 fixture path for new PostgreSQL tasks with real digital PDF, DOCX, and TXT parsing that produces deterministic requirements and verifiable source locators, without changing the durable task-delivery protocol.

**Architecture:** New PostgreSQL uploads use `document-parse-v1`; historical `development-document-parse` tasks and `development-fixture` results remain readable and route to the old adapter. A parser router runs real parsing in a bounded Node worker thread, where format-specific extractors produce an ordered intermediate document and deterministic rules produce requirement candidates. The durable worker keeps ownership of leases, persistence, and acknowledgement.

**Tech Stack:** Node.js 24, TypeScript/ESM, `pdfjs-dist@6.1.200`, `@zip.js/zip.js@2.8.26`, `fast-xml-parser@5.9.3`, PostgreSQL 16, Vitest, OpenAPI 3.1.

## Global Constraints

- C2.1 supports digital PDF, DOCX, and UTF text only. OCR, scanned-PDF recognition, password submission, legacy `.doc`, AI/LLM adjudication, and production corpus thresholds are deferred.
- Existing API paths, PostgreSQL outbox, Redis Streams, lease heartbeat, fencing, retry, and acknowledgement semantics must not change.
- Existing `development-document-parse` tasks and `development-fixture` requirements remain readable; new PostgreSQL uploads use `document-parse-v1` and `deterministic-rules-v1`.
- Memory mode remains the explicit zero-dependency development-fixture path; the production PostgreSQL worker uses the real parser.
- Locator canonical text is CRLF/CR → LF, then Unicode NFC, with no whitespace collapsing. `textStart`/`textEnd` are zero-based UTF-16 half-open offsets and must not split surrogate pairs.
- Every real locator contains `version=1`, `sourceFileId`, `sourceFileName`, `sourceRevision=1`, `sourceSha256`, `quote`, `quoteSha256`, `textStart`, `textEnd`, `sectionPath`, and `parserVersion`.
- `quote` must equal `canonicalText.slice(textStart, textEnd)`; `quoteSha256` is lowercase SHA-256 of the UTF-8 bytes of the exact quote.
- PDF pages are one-based; bboxes use top-left origin and normalized 0–1 coordinates. DOCX indices are zero-based and include paragraph/table-cell paths. TXT lines are one-based and columns are zero-based UTF-16 offsets.
- `textEnd - textStart` must equal `quote.length` in UTF-16 units. DOCX `charStart`/`charEnd` are non-empty half-open offsets within the referenced normalized paragraph or table-cell text; an empty `tablePath` identifies a body paragraph. TXT `end` is exclusive.
- Parser confidence is a deterministic rule score stored as 0–1, not an AI probability; clients render it as an integer percentage and still require human confirmation.
- The worker main thread must remain free to renew the task lease while parsing; timeout or parser-thread termination is permanent, never automatically retried.
- Input remains capped at 25 MiB. Defaults: 60-second parser timeout, 256 MiB worker old-generation heap, 1,000 PDF pages, 2,048 DOCX entries, 100 MiB expanded ZIP metadata, 32 MiB selected XML, 10 million UTF-16 text units, 100,000 document blocks, 250,000 source spans, and 2,000 requirements.
- The frontend must display only persisted quote/locator metadata. It must not fabricate surrounding source text, a verified highlight, or an “open original page” action before a viewer/download endpoint exists.

---

## File Structure

### New files

- `backend/migrations/0004_real_document_parser.sql` — backward-compatible task/evidence schema extension and database checks.
- `backend/src/domain/source-locator.ts` — locator unions, canonicalization, hashing, and runtime integrity validation.
- `backend/src/application/document-parser.ts` — parser port plus historical/real task router.
- `backend/src/infrastructure/parser/parser-types.ts` — ordered document IR, source spans, limits, worker request/reply types.
- `backend/src/infrastructure/parser/deterministic-requirement-extractor.ts` — versioned Chinese/English deterministic candidate rules.
- `backend/src/infrastructure/parser/text-document-extractor.ts` — UTF text extraction and line locators.
- `backend/src/infrastructure/parser/docx-document-extractor.ts` — bounded OOXML paragraph/table extraction.
- `backend/src/infrastructure/parser/pdf-document-extractor.ts` — PDF.js text/layout extraction and normalized regions.
- `backend/src/infrastructure/parser/digital-document-parser.ts` — format validation, extractor dispatch, candidate-to-domain mapping.
- `backend/src/infrastructure/parser/parser-worker.ts` — worker-thread entrypoint.
- `backend/src/infrastructure/parser/isolated-document-parser.ts` — timeout/resource-limited worker-thread adapter.
- `backend/test/helpers/document-fixtures.ts` — deterministic in-memory PDF/DOCX/TXT fixtures.
- `backend/test/source-locator.test.ts` — locator contract and tamper tests.
- `backend/test/document-parser.test.ts` — format, layout, table, error, and limit tests.
- `backend/test/parser-isolation.test.ts` — worker-thread success/timeout/termination tests.
- `backend/test/parser-benchmark.test.ts` — synthetic hard-term and scoring-point recall gates, explicitly not a production accuracy claim.

### Modified files

- Backend domain/repositories: `backend/src/domain/models.ts`, memory/PostgreSQL repositories.
- Runtime composition: `backend/src/app.ts`, `backend/src/worker.ts`, both processing services, worker smoke.
- Upload/contract: `backend/src/api/routes.ts`, presenters, `docs/api/openapi.yaml`.
- Tests/smokes: existing backend API/repository/worker tests and `deploy/full-stack-smoke.mjs`.
- Frontend API presentation: contracts, adapters/tests, Files and Analysis pages.
- Documentation: root/backend/deploy READMEs, MVP technical design and docs index.

---

### Task 1: Versioned evidence contract and persistence

**Files:**
- Create: `backend/migrations/0004_real_document_parser.sql`
- Create: `backend/src/domain/source-locator.ts`
- Modify: `backend/src/domain/models.ts`
- Modify: `backend/src/infrastructure/memory/in-memory-repository.ts`
- Modify: `backend/src/infrastructure/postgres/postgres-repository.ts`
- Test: `backend/test/source-locator.test.ts`
- Test: `backend/test/durable-repository.test.ts`

**Interfaces:**

```ts
export type ParseTaskType = 'development-document-parse' | 'document-parse-v1'
export type ExtractionMethod = 'development-fixture' | 'deterministic-rules-v1'

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

export interface PdfSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'pdf'
  regions: Array<{
    page: number
    bbox: { x: number; y: number; width: number; height: number }
  }>
}

export interface DocxSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'docx'
  ranges: Array<{
    paragraphId: string | null
    paragraphIndex: number
    tablePath: Array<{ tableIndex: number; rowIndex: number; cellIndex: number }>
    charStart: number
    charEnd: number
  }>
}

export interface TxtSourceLocatorV1 extends RealLocatorBaseV1 {
  kind: 'txt'
  start: { line: number; column: number }
  end: { line: number; column: number }
}

export type SourceLocator =
  | DevelopmentSourceLocator
  | PdfSourceLocatorV1
  | DocxSourceLocatorV1
  | TxtSourceLocatorV1
```

- [ ] Write failing tests for canonical text, quote/hash invariants, PDF region bounds, DOCX paths, TXT positions, malformed persisted JSON, and confidence bounds.
- [ ] Run `npm test -- test/source-locator.test.ts test/durable-repository.test.ts` and confirm failures are caused by the missing contract/migration behavior.
- [ ] Implement locator types and runtime validators. Real evidence must reject mismatched file ID/SHA, invalid hashes, invalid offsets, empty regions/ranges, non-finite bbox values, and inconsistent extraction-method/kind pairs.
- [ ] Add migration `0004`: replace the named `parse_tasks_type_check` and `requirements_extraction_method_check` text constraints, add nullable `confidence numeric(5,4)` with 0–1 check, and add an evidence-kind/locator-v1 database constraint while preserving fixture rows.
- [ ] Persist/read `confidence` and validate source-locator JSON before returning or completing a task. Completion must use the locked task/file rows and enforce: task type ↔ extraction method, extraction method ↔ locator kind, real confidence non-null, fixture confidence null, exact source file ID/name/SHA/revision, and locator kind ↔ the validated file extension/media type.
- [ ] Extend the PostgreSQL migration/smoke coverage to upgrade a schema containing `0001`–`0003` fixture rows, preserve/read them, insert valid real evidence, and reject invalid pairings, over-precise/out-of-bounds confidence at the runtime boundary, malformed locator JSON shapes, and real evidence whose source metadata does not match the locked file row.
- [ ] Re-run targeted tests; then run `npm run typecheck && npm run lint`.
- [ ] Commit: `feat: add versioned parsing evidence contract`.

### Task 2: Document IR, TXT parsing, and deterministic extraction

**Files:**
- Create: `backend/src/application/document-parser.ts`
- Create: `backend/src/infrastructure/parser/parser-types.ts`
- Create: `backend/src/infrastructure/parser/text-document-extractor.ts`
- Create: `backend/src/infrastructure/parser/deterministic-requirement-extractor.ts`
- Create: `backend/src/infrastructure/parser/digital-document-parser.ts`
- Create: `backend/test/helpers/document-fixtures.ts`
- Create: `backend/test/document-parser.test.ts`
- Create: `backend/test/parser-benchmark.test.ts`

**Interfaces:**

```ts
export interface DocumentParser {
  parse(file: StoredProjectFile, task: ParseTask, now: string, signal: AbortSignal): Promise<Requirement[]>
}

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

export interface DocumentBlock {
  kind: 'heading' | 'paragraph' | 'table-cell'
  text: string
  textStart: number
  textEnd: number
  sectionPath: string[]
  sourceSpans: Array<{
    textStart: number
    textEnd: number
    source: PdfBlockSource | DocxBlockSource | TxtBlockSource
  }>
}

export interface ParsedDocument {
  format: 'pdf' | 'docx' | 'txt'
  canonicalText: string
  blocks: DocumentBlock[]
}
```

`ParsedDocument` serialization is normative. TXT `canonicalText` is the complete strictly decoded source after removing one optional leading UTF-8 BOM, converting CRLF/CR → LF, and applying NFC; blank lines and all other whitespace remain intact. PDF/DOCX `canonicalText` is their ordered, non-empty normalized block strings joined with one literal `\n`. Block `textStart`/`textEnd` are absolute UTF-16 half-open offsets whose slice exactly equals `block.text`; TXT blocks may have newline/blank-line gaps, while PDF/DOCX adjacent blocks have one separator unit. Each `sourceSpan` is ordered, non-overlapping, non-empty, contained by one block, and maps an absolute canonical slice to its physical PDF/DOCX/TXT anchor. Spans need not cover PDF-inserted spaces, but every candidate must overlap at least one span. TXT/DOCX span canonical lengths must match their physical UTF-16 range lengths so partial overlaps can be clipped; PDF partial overlaps retain the complete contributing region. C2.1 requirement candidates are contiguous slices of one non-heading block; locator regions/ranges are the ordered, structurally deduplicated physical spans overlapping that slice. The parser must validate the IR and verify the canonical slice and quote hash before returning a requirement. Persisted reads cannot reconstruct canonical text, so repositories validate locator shape, self-consistent quote/hash/offsets, task/method/source metadata, and file format; a future original-file viewer must reparse the pinned revision before claiming a verified highlight.

**Task 2 deterministic-rules-v1 contract:**

- TXT accepts only strict UTF-8 plus one optional leading UTF-8 BOM. UTF-16 BOMs and malformed UTF-8 fail with `INVALID_TEXT_ENCODING`; an interior U+FEFF is retained. Emit one non-empty block per physical normalized line, including whitespace-only lines, and retain the original one-based physical line in its anchor.
- A heading is a line of at most 120 UTF-16 units that has no requirement signal, has no sentence-ending punctuation, and matches Markdown `#{1,6}`, Chinese `第…章/节`, a hierarchical decimal heading, or Chinese-list `一、` syntax. Remove only the heading marker for `sectionPath`; heading text remains in `canonicalText`, updates the section stack, and never emits a requirement.
- Split a non-heading block on `。！？；!?;` or a non-decimal `.` followed by whitespace/end. Include the delimiter in the candidate quote, trim only candidate-edge Unicode whitespace, and keep all internal text unchanged. No delimiter means the whole block is one sentence.
- Hard signals are English whole-word, case-insensitive `must|shall`, or Chinese `必须|不得|应当|(?<!无)须(?!知)`. Scoring signals require an explicit numeric point phrase: Chinese `最高得|最高可得|最高为|满分|满分为|得|计|赋|分值|分值为` followed by a number and `分`; or English `worth|award(?:ed)?|score(?:s)?|maximum|max` (optionally `of`) followed by a number and `points?`, plus explicit `<number> points`. Do not match `mustard`, `shallot`, `无需/无须`, `须知`, page/version/day numbers, or ordinary declarative text.
- Hard-only maps to `mandatory/0.9500`; score-only to `important/0.9000`; hard+score to `mandatory/0.9800`; v1 does not produce `normal`. Category is derived from `sectionPath + quote` with case-insensitive keyword precedence compliance > commercial > technical. Compliance keywords: `资格/资质/证书/证照/截止/提交/签字/签章/盖章/密封/废标/无效/合规/license/certificate/certification/deadline/submission/signature/seal/compliance`. Commercial keywords: `报价/价格/价款/费用/付款/支付/结算/税/保证金/预算/price/pricing/payment/cost/fee/invoice/tax/deposit/commercial`.
- Merge multiple rule hits on the same sentence, then deduplicate exact NFC quotes across the document by keeping the earliest range. Sort by `textStart,textEnd` and assign `REQ-0001` onward. Exactly 2,000 unique candidates and 10,000,000 canonical UTF-16 units are allowed; the next unit/candidate fails the whole parse with `DOCUMENT_RESOURCE_LIMIT_EXCEEDED` rather than truncating.
- Exactly 100,000 blocks and 250,000 total source spans are allowed; the next block/span fails with `DOCUMENT_RESOURCE_LIMIT_EXCEEDED`. TXT extraction must scan lines without first materializing an unbounded split array, and TXT IR validation requires each block to cover exactly one complete non-empty physical line.
- Requirement `title` and `description` are the exact quote (no generated summary); confirmation starts pending; method is `deterministic-rules-v1`; confidence is the deterministic score; timestamps use `now`; locator source metadata comes only from the stored file; `parserVersion` is `deterministic-rules-v1`. Random requirement IDs may differ, but document order, codes, evidence, and scores are stable.
- The Task 2 CPU kernel is synchronous: it must reject a signal already aborted and check the signal inside major loops, but it does not claim event-loop-preemptive cancellation. Task 5's parent thread deadline/lease-loss path must call `Worker.terminate()` and is the authoritative in-flight hard-cancellation mechanism.

Define this shared error surface in `parser-types.ts` during Task 2; later format extractors and the isolated worker must reuse it:

```ts
export type ParserFailureCode =
  | 'FORMAT_MISMATCH'
  | 'UNSUPPORTED_DOCUMENT_FORMAT'
  | 'INVALID_PDF'
  | 'PDF_ENCRYPTED'
  | 'OCR_REQUIRED'
  | 'INVALID_DOCX'
  | 'DOCUMENT_RESOURCE_LIMIT_EXCEEDED'
  | 'DOCUMENT_PARSE_TIMEOUT'
  | 'INVALID_TEXT_ENCODING'
  | 'PARSER_WORKER_FAILED'

export class ParserError extends Error {
  readonly retryable = false
  constructor(readonly code: ParserFailureCode, message: string) { super(message) }
}
```

- [ ] Write failing tests for UTF-8/BOM handling, canonical offsets, headings excluded from requirements, Chinese/English modal terms, scoring phrases, category/priority mapping, stable document order, duplicate suppression, zero matches, and 2,000-result/text limits.
- [ ] Run the two new test files and confirm expected RED failures.
- [ ] Implement the format-neutral IR, TXT extractor, ordered deterministic rules, confidence mapping, stable `REQ-0001` codes, and real Requirement mapping.
- [ ] Reject a block, source span, or candidate that splits a UTF-16 surrogate pair; require ordered non-overlapping block/source ranges and verify every candidate against `ParsedDocument.canonicalText` before domain mapping.
- [ ] Define `ParserFailureCode`/`ParserError` in `parser-types.ts` now because TXT encoding and resource limits need stable errors; Task 5 must reuse the same protocol for worker serialization.
- [ ] Validate `document-parse-v1` task/file tenant-project-file lineage plus `.txt`/`text/plain` pairing before TXT dispatch. Keep limits injectable for boundary tests while exporting production defaults of 10,000,000 UTF-16 units, 100,000 blocks, 250,000 source spans, and 2,000 unique requirements.
- [ ] Add a synthetic benchmark with labeled hard terms and scoring points; assert hard-term recall ≥ 0.98 and scoring-point recall ≥ 0.95 while labeling the dataset as a contract fixture rather than production accuracy evidence.
- [ ] Run targeted tests, typecheck, and lint.
- [ ] Commit: `feat: extract deterministic requirements from text`.

### Task 3: Bounded DOCX parsing

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`
- Create: `backend/src/infrastructure/parser/docx-document-extractor.ts`
- Modify: `backend/src/infrastructure/parser/digital-document-parser.ts`
- Modify: `backend/test/helpers/document-fixtures.ts`
- Modify: `backend/test/document-parser.test.ts`

- [ ] Add failing DOCX tests generated in memory with fixed metadata: Heading 1/2, multi-run paragraphs, tables, `w14:paraId`, list markers, broken ZIP, wrong content type, encrypted entry, duplicate/path-traversal entry, oversized metadata, and high compression ratio.
- [ ] Run DOCX-focused tests and confirm RED.
- [ ] Pin `@zip.js/zip.js@2.8.26` and `fast-xml-parser@5.9.3`.
- [ ] Read with `ZipReader(new Uint8ArrayReader(content), { checkSignature:true, checkOverlappingEntry:true,useWebWorkers:false,signal })`, count through `getEntriesGenerator()`, and always close the reader. Preflight each non-directory entry with `checkOverlappingEntryOnly:true`; extract only selected XML with `checkSignature/checkOverlappingEntry`. Do not use `extractPrependedData` (it produces false positives in 2.8.26).
- [ ] Before extraction reject: more than 2,048 entries; unsafe/negative offsets or sizes; encrypted entries; NUL/control/backslash/absolute/drive/empty/dot/dot-dot path segments; NFC-canonical duplicate paths; raw filenames over 4 KiB; total declared expansion over 100 MiB; selected XML over 32 MiB; zero compressed bytes with nonzero output; entries at least 1 MiB above 200:1 compression; or a minimum entry offset other than zero.
- [ ] Require `[Content_Types].xml`, `_rels/.rels`, and `word/document.xml`; the exact standard DOCX main+xml content type; an internal root `officeDocument` relationship targeting `word/document.xml`; and a Transitional or Strict WordprocessingML namespace. Reject legacy, template, macro-enabled/VBA content and external main-document relationships.
- [ ] Decode selected XML explicitly as declared UTF-8/UTF-16 (never pass zip.js `Uint8Array` directly to fast-xml-parser), reject unsupported encodings and `DOCTYPE`, then parse in strict validation/preserve-order mode with bounded entities (`32` definitions, depth `4`, `1,000` expansions, `100,000` expanded units) and at most `256` nested tags.
- [ ] Parse body children and permitted content controls in document order. Recurse visible `w:t`, map tab/breaks, include hyperlinks/insertions, and skip deleted/instruction text. Traverse tables row/cell/paragraph order; use a global zero-based paragraph index including table paragraphs, nested zero-based `tablePath`, and only an 8-hex uppercase `w14:paraId` (otherwise `null`).
- [ ] Resolve headings from direct outline level, then the style `basedOn` chain/outline level, then a Heading-name fallback; levels 0–8 map to Heading 1–9 and table headings do not mutate the global section path. Resolve visible list markers through `numbering.xml` (`numId → abstractNum → lvl/numFmt/lvlText`) and counters; omit an unresolved marker rather than inventing one.
- [ ] Build the normative joined-block canonical text/source spans, enforce all DOCX/text limits, and map corrupt/XML/resource failures to stable permanent `INVALID_DOCX` or `DOCUMENT_RESOURCE_LIMIT_EXCEEDED` errors.
- [ ] Run targeted tests, package audit, typecheck, and lint.
- [ ] Commit: `feat: parse docx paragraphs and tables`.

### Task 4: Digital PDF parsing and normalized regions

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`
- Create: `backend/src/infrastructure/parser/pdf-document-extractor.ts`
- Modify: `backend/src/infrastructure/parser/digital-document-parser.ts`
- Modify: `backend/test/helpers/document-fixtures.ts`
- Modify: `backend/test/document-parser.test.ts`

- [ ] Add failing PDF tests generated with fixed metadata: two pages, split runs, heading/body text, table-like columns, rotation/crop behavior, corrupted PDF, password protection, image-only/no-text PDF, and page/text limits.
- [ ] Run PDF-focused tests and confirm RED.
- [ ] Pin `pdfjs-dist@6.1.200` and test-only `pdf-lib@1.17.1`.
- [ ] Import Node APIs from `pdfjs-dist/legacy/build/pdf.mjs`; the bare package requires browser `DOMMatrix`. Copy the Buffer with `Uint8Array.from` after metadata/hash checks because PDF.js rejects Buffer and detaches the supplied ArrayBuffer. Resolve `standard_fonts`, `cmaps`, and `wasm` from the package root; always destroy the loading task.
- [ ] Load with `stopAtErrors:true`, `disableFontFace:true`, `useSystemFonts:false`, packed CMaps and explicit resource URLs. Do not pass or claim `isEvalSupported`: PDF.js 6.1.200 no longer exposes or reads that option, so it is not a security control.
- [ ] Enforce 1,000 pages and shared text/input limits. Map `PasswordException` to `PDF_ENCRYPTED`, `InvalidPDFException`/content-stream failures to `INVALID_PDF`, and zero extractable text to `OCR_REQUIRED`; operator-list image paint operations may refine the message but never claim OCR.
- [ ] Group items by transformed baseline/angle/font height, using EOL/blank items only as hints; sort along text flow, join gaps below `0.2em`, insert one space through `1.5em`, and treat larger gaps as column/cell evidence. Detect a multi-column gutter only when it exceeds 5% page width across at least three lines; require multiple high-precision signals for headings and stable x anchors across at least 2–3 rows for table-like cells, otherwise fall back to paragraphs.
- [ ] Use `page.getViewport({scale:1})` so CropBox/Rotate/UserUnit are represented. Combine viewport and item matrices, derive four corners from flow/up vectors, item advance, font height and ascent/descent (bounded fallback), axis-align and clip to the viewport, normalize top-left x/y/width/height, round to six decimals, and retain complete regions from all contributing spans.
- [ ] Document v1 limitations rather than fabricate structure: missing ToUnicode, content-stream vs reading order, ligatures/hyphenation, floating multi-column content, RTL/vertical text, headers/watermarks, and complex/borderless tables.
- [ ] Run targeted tests, package audit, typecheck, and lint.
- [ ] Commit: `feat: parse digital pdf layout and locators`.

### Task 5: Isolated parser runtime and durable-worker wiring

**Files:**
- Create: `backend/src/infrastructure/parser/parser-worker.ts`
- Create: `backend/src/infrastructure/parser/isolated-document-parser.ts`
- Modify: `backend/src/config.ts`, `.env.example`
- Modify: `backend/src/application/durable-task-worker.ts`
- Modify: `backend/src/application/upload-processing-service.ts`
- Modify: `backend/src/app.ts`, `backend/src/worker.ts`
- Modify: `backend/src/api/routes.ts`
- Test: `backend/test/parser-isolation.test.ts`
- Test: existing worker/recovery/API tests

- [ ] Write failing tests for real-task routing, historical fixture routing, parser thread success, timeout/termination, permanent parser errors, and unchanged transient storage/database retry behavior.
- [ ] Run targeted tests and confirm RED.
- [ ] Reuse the shared permanent parser-error protocol from `parser-types.ts` when defining the worker reply:

  ```ts
  export type ParserWorkerReply =
    | { ok: true; requirements: Requirement[] }
    | { ok: false; error: { code: ParserFailureCode; message: string } }
  ```

- [ ] Implement a plain-data transferable worker request/reply protocol, 60-second deadline, 256 MiB old-generation resource limit, termination cleanup, stable-code allowlist, malformed-reply handling, and sanitized `ParserError` rehydration. Copy with `Uint8Array.from(file.content)` before transferring its exact `ArrayBuffer`; never transfer a pooled `Buffer` backing store.
- [ ] Resolve the worker as `new URL('./parser-worker.js', import.meta.url)`. Keep the inherited `tsx` loader in source execution so it remaps the sibling `.js` URL to `.ts`; let `tsc` emit the same sibling `.js` path for production. Do not emit a `.ts` URL or clear `execArgv`.
- [ ] Route new PostgreSQL uploads to `document-parse-v1`; keep memory uploads and historical tasks on `development-document-parse`. Reject `.doc` synchronously with 415; keep PDF/DOCX/TXT.
- [ ] Wire real parsing only into the durable worker. The durable worker owns an `AbortController`; lease loss or shutdown aborts and terminates the parser worker before any completion write/acknowledgement. Parser timeout/resource/corruption/OCR-required errors remain permanent and are acknowledged only after fenced failure persistence.
- [ ] Execute the real source worker under `node --import tsx` and the compiled sibling worker from `dist`. Add an integration test whose isolated parser consumes CPU longer than two heartbeat intervals and proves lease renewal continues; add lease-loss/shutdown cases proving the child terminates and no requirement completion or acknowledgement occurs.
- [ ] Update worker/full-stack smoke text to contain real requirements and assert real extraction method, confidence, quote hash, and locator kind.
- [ ] Run backend check and JS syntax check.
- [ ] Commit: `feat: run real parser in isolated worker thread`.

### Task 6: OpenAPI, frontend evidence presentation, and documentation

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `frontend/src/api/contracts.ts`, `frontend/src/api/adapters.ts`, adapter tests
- Modify: `frontend/src/pages/FilesPage.tsx`, `frontend/src/pages/AnalysisPage.tsx`
- Modify: `README.md`, `backend/README.md`, `deploy/README.md`, `docs/MVP_TECHNICAL_DESIGN.md`, `docs/README.md`

- [ ] Write failing frontend adapter/UI-unit tests for fixture fallback and PDF/DOCX/TXT evidence labels, confidence conversion, page-null handling, and no fabricated verified state.
- [ ] Run frontend targeted tests and confirm RED.
- [ ] Expand OpenAPI task type, extraction method, confidence, and discriminated locator schemas; remove legacy DOC media type.
- [ ] Mirror the unions in the frontend, use an exhaustive locator switch, and branch Analysis presentation on evidence kind rather than API/mock mode.
- [ ] Replace development-only warnings when real evidence exists; show exact quote, revision, parser version, and anchor metadata without fake surrounding text or an active source-opening action.
- [ ] Update docs to mark C2.1 digital parsing delivered and explicitly defer OCR, original-file viewer/highlighting, and production accuracy corpus.
- [ ] Run frontend typecheck/lint/test/build, OpenAPI lint, YAML parse, and backend check.
- [ ] Commit: `docs: document real parser evidence boundary`.

### Task 7: Final verification and publication

- [ ] Run `cd backend && npm run check` and record test counts.
- [ ] Run `cd frontend && npm run typecheck && npm run lint && npm run test && npm run build`.
- [ ] Run OpenAPI lint and parse CI/Compose/OpenAPI YAML.
- [ ] Run `node --check deploy/full-stack-smoke.mjs`.
- [ ] Apply migrations through `0004`, then run `npm run db:smoke` and `npm run worker:smoke` against PostgreSQL/Redis; verify preserved fixture rows plus newly persisted real TXT evidence. If local containers are unavailable, require the equivalent GitHub Actions jobs before publication is considered complete.
- [ ] Review the complete branch for tenant boundaries, locator integrity, parser resource limits, lease safety, historical compatibility, and docs accuracy.
- [ ] Push `agent/phase-c2-real-parser`, open a Draft PR against `main`, verify no unrelated files, and monitor GitHub Actions until all jobs pass.
