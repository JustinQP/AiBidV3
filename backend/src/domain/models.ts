import type { ObjectReference } from './object-storage.js'

export type ProjectStatus = 'draft' | 'active' | 'archived'
export type FileParseStatus = 'queued' | 'parsing' | 'parsed' | 'failed'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type RequirementCategory = 'technical' | 'commercial' | 'compliance'
export type RequirementPriority = 'mandatory' | 'important' | 'normal'
export type ConfirmationStatus = 'pending' | 'confirmed' | 'rejected'

export interface Project {
  id: string
  tenantId: string
  name: string
  code: string | null
  customerName: string | null
  ownerName: string | null
  deadline: string | null
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface ProjectFile {
  id: string
  tenantId: string
  projectId: string
  fileName: string
  mediaType: string
  sizeBytes: number
  sha256: string
  parseStatus: FileParseStatus
  createdAt: string
  updatedAt: string
}

export interface StoredProjectFile extends ProjectFile {
  content: Buffer
}

export interface NewStoredProjectFile extends ProjectFile {
  objectReference: ObjectReference
}

export type StoredProjectFileSource =
  | { kind: 'object'; reference: ObjectReference }
  | { kind: 'legacy-inline'; content: Buffer }

export interface StoredProjectFileRecord extends ProjectFile {
  source: StoredProjectFileSource
}

export interface TaskError {
  code: string
  message: string
}

export interface ParseTask {
  id: string
  tenantId: string
  projectId: string
  fileId: string
  type: 'development-document-parse'
  status: TaskStatus
  progress: number
  error: TaskError | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface DevelopmentSourceLocator {
  kind: 'development-fixture'
  fileId: string
  fileName: string
  pageNumber: null
  sectionPath: string[]
  paragraphIndex: null
  quote: string
}

export interface Requirement {
  id: string
  tenantId: string
  projectId: string
  fileId: string
  taskId: string
  code: string
  title: string
  description: string
  category: RequirementCategory
  priority: RequirementPriority
  confirmationStatus: ConfirmationStatus
  confirmationNote: string | null
  confirmedAt: string | null
  extractionMethod: 'development-fixture'
  sourceLocator: DevelopmentSourceLocator
  createdAt: string
  updatedAt: string
}

export interface RequirementFilters {
  confirmationStatus?: ConfirmationStatus
  priority?: RequirementPriority
}

export interface NewProject {
  id: string
  tenantId: string
  name: string
  code: string | null
  customerName: string | null
  ownerName: string | null
  deadline: string | null
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface NewUpload {
  file: NewStoredProjectFile
  task: ParseTask
}

export interface RequirementConfirmation {
  status: Exclude<ConfirmationStatus, 'pending'>
  note: string | null
  confirmedAt: string
}
