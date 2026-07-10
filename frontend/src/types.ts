export type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'teal'

export type FileStatus = 'ready' | 'parsing' | 'error'

export interface BidFile {
  id: string
  name: string
  category: string
  size: string
  pages: number | string
  version: string
  status: FileStatus
  updatedAt: string
  owner: string
}

export type RequirementType = '评分项' | '技术要求' | '资格项' | '商务要求' | '无效条款'
export type RequirementStatus = '未确认' | '待响应' | '编写中' | '已响应' | '已确认' | '已驳回'
export type RiskLevel = '阻断' | '高' | '中' | '低'

export interface Requirement {
  id: string
  type: RequirementType
  summary: string
  source: string
  page: number
  score?: number
  mandatory: boolean
  confidence: number
  owner: string
  section: string
  risk: RiskLevel
  status: RequirementStatus
  confirmed: boolean
}

export type SectionStatus = '未开始' | '编写中' | '待审核' | '已批准'

export interface OutlineSection {
  id: string
  number: string
  title: string
  level: 1 | 2
  owner: string
  reviewer: string
  targetWords: number
  requirementCount: number
  status: SectionStatus
}

export interface ReviewIssue {
  id: string
  title: string
  description: string
  severity: '阻断' | '重要' | '一般'
  owner: string
  location: string
  status: '待处理' | '已解决'
}

export interface ExportRecord {
  id: string
  name: string
  type: '草稿' | '正式版'
  template: string
  contentVersion: string
  createdAt: string
  owner: string
  size: string
}
