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

export interface TaskFailure {
  code: string
  message: string
}

export interface ProcessingTask {
  id: string
  projectId: string
  fileId: string
  type: 'development-document-parse'
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

export interface RequirementSourceLocator {
  kind: 'development-fixture'
  fileId: string
  fileName: string
  pageNumber: number | null
  sectionPath: string[]
  paragraphIndex: null
  quote: string
}

export interface RequirementRecord {
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
  extractionMethod: 'development-fixture'
  sourceLocator: RequirementSourceLocator
  createdAt: string
  updatedAt: string
}

export interface RequirementListQuery {
  confirmationStatus?: RequirementConfirmationStatus
  priority?: RequirementPriority
}

export interface ConfirmRequirementInput {
  status: Exclude<RequirementConfirmationStatus, 'pending'>
  note?: string
}
