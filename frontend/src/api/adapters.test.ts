import { describe, expect, it } from 'vitest'
import type { ProcessingTask, ProjectFileRecord, ProjectRecord, RequirementRecord } from './contracts'
import { adaptApiProjectFiles, adaptApiProjectListItem, adaptApiRequirement } from './adapters'

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

describe('API view adapters', () => {
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
      type: 'development-document-parse',
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
    })

    expect(adaptApiRequirement({ ...requirement, confirmationStatus: 'rejected' })).toMatchObject({
      confirmationStatus: 'rejected',
      status: '已驳回',
    })
  })
})
