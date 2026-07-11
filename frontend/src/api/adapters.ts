import { project as demoProject, recentProjects } from '../data/mock'
import type { BidFile, FileStatus, Requirement, RequirementStatus, RequirementType, RiskLevel } from '../types'
import type {
  ProcessingTask,
  ProjectFileParseStatus,
  ProjectFileRecord,
  ProjectRecord,
  ProjectStatus,
  RequirementConfirmationStatus,
  RequirementPriority,
  RequirementRecord,
} from './contracts'

export type RequirementDisplayType = RequirementType | '合规要求'

export interface ProjectIdentity {
  id: string
  name: string
  code: string | null
  customerName: string | null
  ownerName: string | null
  deadline: string | null
  status: ProjectStatus
}

export interface ProjectListItem extends ProjectIdentity {
  stage: string
  progress: number | null
  coverage: number | null
  risks: number | null
}

export interface ProjectFileItem {
  id: string
  name: string
  category: string
  mediaType: string | null
  size: string
  sizeBytes: number | null
  pages: number | string | null
  version: string | null
  status: FileStatus
  parseStatus: ProjectFileParseStatus | null
  updatedAt: string
  owner: string | null
  taskId: string | null
  taskStatus: ProcessingTask['status'] | null
  progress: number | null
  error: string | null
  canRetry: boolean
}

interface RequirementEvidenceBase {
  label: string
  anchorLabel: string
  anchorDetails: string[]
  verified: false
}

export type RequirementEvidence =
  | (RequirementEvidenceBase & {
      kind: 'mock-preview' | 'development-fixture'
      sourceRevision: null
      parserVersion: null
      quoteSha256: null
      sourceSha256: null
    })
  | (RequirementEvidenceBase & {
      kind: 'pdf' | 'docx' | 'txt'
      sourceRevision: 1
      parserVersion: string
      quoteSha256: string
      sourceSha256: string
    })

export interface RequirementListItem {
  /** Stable backend resource identifier used by mutations. */
  id: string
  /** Human-readable requirement code. */
  code: string
  title: string
  summary: string
  type: RequirementDisplayType
  source: string
  page: number | null
  sectionPath: string[]
  sourceQuote: string
  mandatory: boolean
  confidence: number | null
  owner: string | null
  section: string | null
  risk: RiskLevel | null
  status: RequirementStatus
  confirmed: boolean
  confirmationStatus: RequirementConfirmationStatus
  confirmationNote: string | null
  priority: RequirementPriority
  score: number | null
  evidence: RequirementEvidence
}

interface MockProjectSummary {
  id: string
  name: string
  code: string
  purchaser: string
  owner: string
  deadline: string
  stage: string
  progress: number
  coverage: number
  risks: number
}

const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: '待上传',
  active: '进行中',
  archived: '已归档',
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extensionOf(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function categoryOf(fileName: string): string {
  const extension = extensionOf(fileName)
  if (extension === 'doc' || extension === 'docx') return '技术附件'
  if (extension === 'txt') return '文本附件'
  return '招标正文'
}

function typeFromCategory(category: RequirementRecord['category']): RequirementDisplayType {
  if (category === 'commercial') return '商务要求'
  if (category === 'compliance') return '合规要求'
  return '技术要求'
}

function mockConfirmationStatus(requirement: Requirement): RequirementConfirmationStatus {
  return requirement.confirmed ? 'confirmed' : 'pending'
}

function statusFromConfirmation(status: RequirementConfirmationStatus): RequirementStatus {
  if (status === 'confirmed') return '待响应'
  if (status === 'rejected') return '已驳回'
  return '未确认'
}

interface AdaptedRequirementSource {
  source: string
  page: number | null
  sectionPath: string[]
  sourceQuote: string
  evidence: RequirementEvidence
}

function adaptRequirementSource(
  locator: RequirementRecord['sourceLocator'],
): AdaptedRequirementSource {
  switch (locator.kind) {
    case 'development-fixture': {
      const anchorLabel = locator.sectionPath.at(-1) ?? '未提供原文锚点'
      return {
        source: locator.fileName,
        page: locator.pageNumber,
        sectionPath: locator.sectionPath,
        sourceQuote: locator.quote,
        evidence: {
          kind: 'development-fixture',
          label: '开发夹具',
          sourceRevision: null,
          parserVersion: null,
          anchorLabel,
          anchorDetails: locator.sectionPath.length === 0
            ? []
            : [`章节：${locator.sectionPath.join(' / ')}`],
          quoteSha256: null,
          sourceSha256: null,
          verified: false,
        },
      }
    }
    case 'pdf': {
      const firstRegion = locator.regions[0]
      if (firstRegion === undefined) throw new Error('PDF evidence requires at least one region')
      return {
        source: locator.sourceFileName,
        page: firstRegion.page,
        sectionPath: locator.sectionPath,
        sourceQuote: locator.quote,
        evidence: {
          kind: 'pdf',
          label: 'PDF',
          sourceRevision: locator.sourceRevision,
          parserVersion: locator.parserVersion,
          anchorLabel: `第 ${firstRegion.page} 页`,
          anchorDetails: locator.regions.map((region, index) =>
            `区域 ${index + 1}：第 ${region.page} 页 · x ${region.bbox.x} · y ${region.bbox.y} · 宽 ${region.bbox.width} · 高 ${region.bbox.height}`,
          ),
          quoteSha256: locator.quoteSha256,
          sourceSha256: locator.sourceSha256,
          verified: false,
        },
      }
    }
    case 'docx': {
      const firstRange = locator.ranges[0]
      if (firstRange === undefined) throw new Error('DOCX evidence requires at least one range')
      const anchorLabel = firstRange.paragraphId === null
        ? `段落索引 ${firstRange.paragraphIndex}`
        : `段落 ${firstRange.paragraphId}`
      return {
        source: locator.sourceFileName,
        page: null,
        sectionPath: locator.sectionPath,
        sourceQuote: locator.quote,
        evidence: {
          kind: 'docx',
          label: 'DOCX',
          sourceRevision: locator.sourceRevision,
          parserVersion: locator.parserVersion,
          anchorLabel,
          anchorDetails: locator.ranges.map((range, index) => {
            const paragraph = range.paragraphId === null
              ? `段落索引 ${range.paragraphIndex}`
              : `段落 ${range.paragraphId} · 段落索引 ${range.paragraphIndex}`
            const tablePath = range.tablePath
              .map((entry) =>
                `表格 ${entry.tableIndex} / 行 ${entry.rowIndex} / 单元格 ${entry.cellIndex}`,
              )
              .join(' > ')
            return `范围 ${index + 1}：${paragraph} · 字符 ${range.charStart}–${range.charEnd}${
              tablePath.length === 0 ? '' : ` · ${tablePath}`
            }`
          }),
          quoteSha256: locator.quoteSha256,
          sourceSha256: locator.sourceSha256,
          verified: false,
        },
      }
    }
    case 'txt':
      return {
        source: locator.sourceFileName,
        page: null,
        sectionPath: locator.sectionPath,
        sourceQuote: locator.quote,
        evidence: {
          kind: 'txt',
          label: 'TXT',
          sourceRevision: locator.sourceRevision,
          parserVersion: locator.parserVersion,
          anchorLabel: `第 ${locator.start.line} 行`,
          anchorDetails: [
            `起点 ${locator.start.line}:${locator.start.column}`,
            `终点 ${locator.end.line}:${locator.end.column}（不含）`,
          ],
          quoteSha256: locator.quoteSha256,
          sourceSha256: locator.sourceSha256,
          verified: false,
        },
      }
    default:
      return assertNever(locator)
  }
}

function confidencePercent(requirement: RequirementRecord): number | null {
  if (requirement.sourceLocator.kind === 'development-fixture') return null
  return requirement.confidence === null ? null : Math.round(requirement.confidence * 100)
}

function assertNever(value: never): never {
  throw new Error(`Unsupported source locator: ${String(value)}`)
}

function newestTaskByFile(tasks: ProcessingTask[]): Map<string, ProcessingTask> {
  const result = new Map<string, ProcessingTask>()
  for (const task of tasks) {
    const existing = result.get(task.fileId)
    if (!existing || task.createdAt > existing.createdAt) result.set(task.fileId, task)
  }
  return result
}

function fileStatus(parseStatus: ProjectFileParseStatus, task?: ProcessingTask): FileStatus {
  if (task?.status === 'failed' || parseStatus === 'failed') return 'error'
  if (task?.status === 'succeeded' || parseStatus === 'parsed') return 'ready'
  return 'parsing'
}

export function adaptApiProject(project: ProjectRecord): ProjectIdentity {
  return {
    id: project.id,
    name: project.name,
    code: project.code,
    customerName: project.customerName,
    ownerName: project.ownerName,
    deadline: project.deadline,
    status: project.status,
  }
}

export function adaptApiProjectListItem(project: ProjectRecord): ProjectListItem {
  return {
    ...adaptApiProject(project),
    stage: PROJECT_STATUS_LABELS[project.status],
    progress: null,
    coverage: null,
    risks: null,
  }
}

export function adaptMockProjectListItem(project: MockProjectSummary): ProjectListItem {
  return {
    id: project.id,
    name: project.name,
    code: project.code,
    customerName: project.purchaser,
    ownerName: project.owner,
    deadline: project.deadline,
    status: 'active',
    stage: project.stage,
    progress: project.progress,
    coverage: project.coverage,
    risks: project.risks,
  }
}

export function getMockProjectList(): ProjectListItem[] {
  return recentProjects.map(adaptMockProjectListItem)
}

export function getMockProject(projectId: string): ProjectIdentity | null {
  if (projectId === demoProject.id) {
    return {
      id: demoProject.id,
      name: demoProject.name,
      code: demoProject.code,
      customerName: demoProject.purchaser,
      ownerName: demoProject.owner,
      deadline: demoProject.deadline,
      status: 'active',
    }
  }

  const project = recentProjects.find((item) => item.id === projectId)
  return project ? adaptMockProjectListItem(project) : null
}

export function adaptApiProjectFiles(files: ProjectFileRecord[], tasks: ProcessingTask[]): ProjectFileItem[] {
  const taskByFile = newestTaskByFile(tasks)
  return files.map((file) => {
    const task = taskByFile.get(file.id)
    const status = fileStatus(file.parseStatus, task)
    return {
      id: file.id,
      name: file.fileName,
      category: categoryOf(file.fileName),
      mediaType: file.mediaType,
      size: formatFileSize(file.sizeBytes),
      sizeBytes: file.sizeBytes,
      pages: null,
      version: null,
      status,
      parseStatus: file.parseStatus,
      updatedAt: formatDateTime(file.updatedAt),
      owner: null,
      taskId: task?.id ?? null,
      taskStatus: task?.status ?? null,
      progress: task?.progress ?? (status === 'ready' ? 100 : null),
      error: task?.error?.message ?? null,
      canRetry: task?.status === 'failed',
    }
  })
}

export function adaptMockProjectFiles(files: BidFile[]): ProjectFileItem[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    category: file.category,
    mediaType: null,
    size: file.size,
    sizeBytes: null,
    pages: file.pages,
    version: file.version,
    status: file.status,
    parseStatus: null,
    updatedAt: file.updatedAt,
    owner: file.owner,
    taskId: null,
    taskStatus: null,
    progress: file.status === 'ready' ? 100 : file.status === 'parsing' ? 64 : null,
    error: file.status === 'error' ? 'OCR 服务连接超时' : null,
    canRetry: file.status === 'error',
  }))
}

export function adaptApiRequirement(requirement: RequirementRecord): RequirementListItem {
  const source = adaptRequirementSource(requirement.sourceLocator)
  return {
    id: requirement.id,
    code: requirement.code,
    title: requirement.title,
    summary: requirement.description,
    type: typeFromCategory(requirement.category),
    source: source.source,
    page: source.page,
    sectionPath: source.sectionPath,
    sourceQuote: source.sourceQuote,
    mandatory: requirement.priority === 'mandatory',
    confidence: confidencePercent(requirement),
    owner: null,
    section: null,
    risk: null,
    status: statusFromConfirmation(requirement.confirmationStatus),
    confirmed: requirement.confirmationStatus === 'confirmed',
    confirmationStatus: requirement.confirmationStatus,
    confirmationNote: requirement.confirmationNote,
    priority: requirement.priority,
    score: null,
    evidence: source.evidence,
  }
}

export function adaptMockRequirement(requirement: Requirement): RequirementListItem {
  return {
    id: requirement.id,
    code: requirement.id,
    title: requirement.summary,
    summary: requirement.summary,
    type: requirement.type,
    source: requirement.source,
    page: requirement.page,
    sectionPath: requirement.section === '未映射' ? [] : [requirement.section],
    sourceQuote: requirement.summary,
    mandatory: requirement.mandatory,
    confidence: requirement.confidence,
    owner: requirement.owner,
    section: requirement.section,
    risk: requirement.risk,
    status: requirement.status,
    confirmed: requirement.confirmed,
    confirmationStatus: mockConfirmationStatus(requirement),
    confirmationNote: null,
    priority: requirement.mandatory ? 'mandatory' : 'normal',
    score: requirement.score ?? null,
    evidence: {
      kind: 'mock-preview',
      label: '模拟预览',
      sourceRevision: null,
      parserVersion: null,
      anchorLabel: `第 ${requirement.page} 页`,
      anchorDetails: ['模拟来源定位'],
      quoteSha256: null,
      sourceSha256: null,
      verified: false,
    },
  }
}
