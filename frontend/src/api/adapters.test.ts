import { createHash } from 'node:crypto'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  DevelopmentSourceLocator,
  ProcessingTask,
  ProjectFileRecord,
  ProjectRecord,
  RealSourceLocatorV1,
  RequirementRecord,
} from './contracts'
import {
  adaptApiProjectFiles,
  adaptApiProjectListItem,
  adaptApiRequirement,
  adaptMockRequirement,
} from './adapters'

const project: ProjectRecord = {
  id: 'project-1',
  name: '智慧园区项目',
  code: null,
  customerName: null,
  ownerName: null,
  deadline: null,
  status: 'draft',
  createdAt: '2026-07-10T08:00:00Z',
  updatedAt: '2026-07-10T08:00:00Z',
}

const REAL_QUOTE = '应保留全流程审计记录。'
const REAL_QUOTE_SHA256 = createHash('sha256').update(REAL_QUOTE).digest('hex')

describe('API view adapters', () => {
  it('pairs each extraction method with its confidence and locator contract', () => {
    type FixtureRequirement = Extract<
      RequirementRecord,
      { extractionMethod: 'development-fixture' }
    >
    type RealRequirement = Extract<
      RequirementRecord,
      { extractionMethod: 'deterministic-rules-v1' }
    >

    expectTypeOf<FixtureRequirement['confidence']>().toEqualTypeOf<null>()
    expectTypeOf<FixtureRequirement['sourceLocator']>()
      .toEqualTypeOf<DevelopmentSourceLocator>()
    expectTypeOf<RealRequirement['confidence']>().toEqualTypeOf<number>()
    expectTypeOf<RealRequirement['sourceLocator']>().toEqualTypeOf<RealSourceLocatorV1>()
  })

  it('does not invent progress, coverage, or risk metrics absent from the API', () => {
    expect(adaptApiProjectListItem(project)).toMatchObject({
      stage: '待上传',
      progress: null,
      coverage: null,
      risks: null,
    })
  })

  it('combines a file with its newest processing task', () => {
    const file: ProjectFileRecord = {
      id: 'file-1',
      projectId: project.id,
      fileName: '招标书.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 2048,
      sha256: 'hash',
      parseStatus: 'parsing',
      createdAt: '2026-07-10T08:00:00Z',
      updatedAt: '2026-07-10T08:00:00Z',
    }
    const task = {
      id: 'task-1',
      projectId: project.id,
      fileId: file.id,
      type: 'document-parse-v1',
      status: 'running',
      progress: 45,
      error: null,
      createdAt: '2026-07-10T08:00:00Z',
      startedAt: '2026-07-10T08:00:01Z',
      finishedAt: null,
      updatedAt: '2026-07-10T08:00:01Z',
    } satisfies ProcessingTask

    expect(adaptApiProjectFiles([file], [task])[0]).toMatchObject({
      name: '招标书.docx',
      category: '技术附件',
      pages: null,
      status: 'parsing',
      taskId: task.id,
      progress: 45,
    })
  })

  it('maps compliance requirements explicitly and keeps unavailable confidence empty', () => {
    const requirement = {
      id: 'requirement-1',
      projectId: project.id,
      fileId: 'file-1',
      taskId: 'task-1',
      code: 'REQ-001',
      title: '审计要求',
      description: '应保留全流程审计记录。',
      category: 'compliance',
      confirmationStatus: 'pending',
      confirmationNote: null,
      priority: 'mandatory',
      confirmedAt: null,
      extractionMethod: 'development-fixture',
      confidence: null,
      sourceLocator: {
        kind: 'development-fixture',
        fileId: 'file-1',
        fileName: '招标书.docx',
        pageNumber: null,
        sectionPath: ['安全要求'],
        paragraphIndex: null,
        quote: '应保留全流程审计记录。',
      },
      createdAt: '2026-07-10T08:00:00Z',
      updatedAt: '2026-07-10T08:00:00Z',
    } satisfies RequirementRecord

    expect(adaptApiRequirement(requirement)).toMatchObject({
      id: 'requirement-1',
      code: 'REQ-001',
      type: '合规要求',
      confidence: null,
      mandatory: true,
      page: null,
      evidence: {
        kind: 'development-fixture',
        label: '开发夹具',
        sourceRevision: null,
        parserVersion: null,
        anchorLabel: '安全要求',
        anchorDetails: ['章节：安全要求'],
        quoteSha256: null,
        sourceSha256: null,
        verified: false,
      },
    })

    expect(adaptApiRequirement({ ...requirement, confirmationStatus: 'rejected' })).toMatchObject({
      confirmationStatus: 'rejected',
      status: '已驳回',
    })
  })

  it('maps PDF evidence to its first region page and rounds confidence to a percentage', () => {
    const requirement = realRequirement({
      kind: 'pdf',
      regions: [
        { page: 4, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
        { page: 5, bbox: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 } },
      ],
    }, 0.954)

    expect(adaptApiRequirement(requirement)).toMatchObject({
      source: 'requirements.pdf',
      page: 4,
      confidence: 95,
      evidence: {
        kind: 'pdf',
        label: 'PDF',
        sourceRevision: 1,
        parserVersion: 'deterministic-rules-v1',
        anchorLabel: '第 4 页',
        anchorDetails: [
          '区域 1：第 4 页 · x 0.1 · y 0.2 · 宽 0.3 · 高 0.1',
          '区域 2：第 5 页 · x 0.2 · y 0.3 · 宽 0.4 · 高 0.2',
        ],
        quoteSha256: REAL_QUOTE_SHA256,
        sourceSha256: 'a'.repeat(64),
        verified: false,
      },
    })
  })

  it('maps DOCX evidence without fabricating a page number', () => {
    const requirement = realRequirement({
      kind: 'docx',
      ranges: [{
        paragraphId: 'A1B2C3D4',
        paragraphIndex: 2,
        tablePath: [{ tableIndex: 0, rowIndex: 1, cellIndex: 2 }],
        charStart: 3,
        charEnd: 10,
      }],
    }, 0.876)

    expect(adaptApiRequirement(requirement)).toMatchObject({
      source: 'requirements.docx',
      page: null,
      confidence: 88,
      evidence: {
        kind: 'docx',
        label: 'DOCX',
        anchorLabel: '段落 A1B2C3D4',
        anchorDetails: [
          '范围 1：段落 A1B2C3D4 · 段落索引 2 · 字符 3–10 · 表格 0 / 行 1 / 单元格 2',
        ],
        verified: false,
      },
    })
  })

  it('maps TXT line and column anchors without fabricating a page number', () => {
    const requirement = realRequirement({
      kind: 'txt',
      start: { line: 8, column: 2 },
      end: { line: 9, column: 5 },
    }, 0.444)

    expect(adaptApiRequirement(requirement)).toMatchObject({
      source: 'requirements.txt',
      page: null,
      confidence: 44,
      evidence: {
        kind: 'txt',
        label: 'TXT',
        anchorLabel: '第 8 行',
        anchorDetails: ['起点 8:2', '终点 9:5（不含）'],
        verified: false,
      },
    })
  })

  it('keeps mock evidence explicitly separate and never marks it verified', () => {
    const adapted = adaptMockRequirement({
      id: 'REQ-MOCK',
      type: '技术要求',
      summary: '模拟要求',
      source: 'mock.pdf',
      page: 12,
      mandatory: true,
      confidence: 98,
      owner: '李明',
      section: '3.2 总体技术方案',
      risk: '低',
      status: '未确认',
      confirmed: false,
    })

    expect(adapted.evidence).toEqual({
      kind: 'mock-preview',
      label: '模拟预览',
      sourceRevision: null,
      parserVersion: null,
      anchorLabel: '第 12 页',
      anchorDetails: ['模拟来源定位'],
      quoteSha256: null,
      sourceSha256: null,
      verified: false,
    })
  })
})

type RealLocatorDetails =
  | Pick<Extract<RequirementRecord['sourceLocator'], { kind: 'pdf' }>, 'kind' | 'regions'>
  | Pick<Extract<RequirementRecord['sourceLocator'], { kind: 'docx' }>, 'kind' | 'ranges'>
  | Pick<Extract<RequirementRecord['sourceLocator'], { kind: 'txt' }>, 'kind' | 'start' | 'end'>

function realRequirement(
  details: RealLocatorDetails,
  confidence: number,
): RequirementRecord {
  const extension = details.kind
  const sourceLocator = {
    version: 1,
    sourceFileId: 'file-1',
    sourceFileName: `requirements.${extension}`,
    sourceRevision: 1,
    sourceSha256: 'a'.repeat(64),
    quote: REAL_QUOTE,
    quoteSha256: REAL_QUOTE_SHA256,
    textStart: 10,
    textEnd: 10 + REAL_QUOTE.length,
    sectionPath: ['安全要求'],
    parserVersion: 'deterministic-rules-v1',
    ...details,
  } satisfies RequirementRecord['sourceLocator']
  return {
    id: `requirement-${details.kind}`,
    projectId: project.id,
    fileId: 'file-1',
    taskId: 'task-1',
    code: 'REQ-001',
    title: '审计要求',
    description: REAL_QUOTE,
    category: 'compliance',
    confirmationStatus: 'pending',
    confirmationNote: null,
    priority: 'mandatory',
    confirmedAt: null,
    extractionMethod: 'deterministic-rules-v1',
    confidence,
    sourceLocator,
    createdAt: '2026-07-10T08:00:00Z',
    updatedAt: '2026-07-10T08:00:00Z',
  }
}
