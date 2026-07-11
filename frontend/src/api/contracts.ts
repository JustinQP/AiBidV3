export interface ApiEnvelope<T> {
  data: T
  meta?: Record<string, unknown>
}

/** RFC 9457 / RFC 7807 compatible problem response. */
export interface ApiProblem {
  type?: string
  title: string
  status: number
  detail?: string
  instance?: string
  code?: string
  requestId?: string
}

export interface HealthStatus {
  status: 'ok' | 'degraded'
  repository: 'memory' | 'postgres'
  timestamp: string
}

export type ProjectStatus = 'draft' | 'active' | 'archived'

export interface ProjectRecord {
  id: string
  name: string
  code: string | null
  customerName: string | null
  ownerName: string | null
  deadline: string | null
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  code?: string | null
  customerName?: string | null
  ownerName?: string | null
  deadline?: string | null
}

export type ProjectFileParseStatus = 'queued' | 'parsing' | 'parsed' | 'failed'

export interface ProjectFileRecord {
  id: string
  projectId: string
  fileName: string
  mediaType: string
  sizeBytes: number
  sha256: string
  parseStatus: ProjectFileParseStatus
  createdAt: string
  updatedAt: string
}

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type ParseTaskType = 'development-document-parse' | 'document-parse-v1'

export interface TaskFailure {
  code: string
  message: string
}

export interface ProcessingTask {
  id: string
  projectId: string
  fileId: string
  type: ParseTaskType
  status: TaskStatus
  progress: number
  error: TaskFailure | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface UploadProjectFileResult {
  file: ProjectFileRecord
  task: ProcessingTask
}

export type RequirementCategory = 'technical' | 'commercial' | 'compliance'
export type RequirementConfirmationStatus = 'pending' | 'confirmed' | 'rejected'
export type RequirementPriority = 'mandatory' | 'important' | 'normal'

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
export type RequirementSourceLocator = SourceLocator

interface RequirementRecordBase {
  id: string
  projectId: string
  fileId: string
  taskId: string
  code: string
  title: string
  description: string
  category: RequirementCategory
  confirmationStatus: RequirementConfirmationStatus
  confirmationNote: string | null
  priority: RequirementPriority
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
}

export type RequirementRecord = RequirementRecordBase & (
  | {
      extractionMethod: 'development-fixture'
      confidence: null
      sourceLocator: DevelopmentSourceLocator
    }
  | {
      extractionMethod: 'deterministic-rules-v1'
      confidence: number
      sourceLocator: RealSourceLocatorV1
    }
)

export interface RequirementListQuery {
  confirmationStatus?: RequirementConfirmationStatus
  priority?: RequirementPriority
}

export interface ConfirmRequirementInput {
  status: Exclude<RequirementConfirmationStatus, 'pending'>
  note?: string
}
