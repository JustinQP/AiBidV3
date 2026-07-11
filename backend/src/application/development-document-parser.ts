import type { Requirement, RequirementCategory, RequirementPriority, StoredProjectFile } from '../domain/models.js'
import { createId } from '../lib/id.js'

interface DevelopmentFixture {
  title: string
  description: string
  category: RequirementCategory
  priority: RequirementPriority
}

const DEVELOPMENT_FIXTURES: DevelopmentFixture[] = [
  {
    title: '提交完整的技术实施方案',
    description: '开发演示数据：说明实施方法、项目计划、交付物与质量保障措施。',
    category: 'technical',
    priority: 'mandatory',
  },
  {
    title: '提供同类项目案例',
    description: '开发演示数据：列示代表性项目、服务范围和可核验的交付成果。',
    category: 'commercial',
    priority: 'important',
  },
  {
    title: '按时完成投标文件签章与提交',
    description: '开发演示数据：在截止时间前完成签章、校验与正式提交。',
    category: 'compliance',
    priority: 'mandatory',
  },
]

/**
 * Development-only adapter for exercising the ingestion workflow.
 *
 * It deliberately does not inspect or parse PDF/DOC/DOCX content. Every result
 * is marked `development-fixture`, so consumers cannot mistake it for a real
 * extraction or a verified source location.
 */
export class DevelopmentDocumentParser {
  async parse(file: StoredProjectFile, taskId: string, now: string): Promise<Requirement[]> {
    return DEVELOPMENT_FIXTURES.map((fixture, index) => ({
      id: createId(),
      tenantId: file.tenantId,
      projectId: file.projectId,
      fileId: file.id,
      taskId,
      code: `DEV-${String(index + 1).padStart(3, '0')}`,
      title: fixture.title,
      description: fixture.description,
      category: fixture.category,
      priority: fixture.priority,
      confirmationStatus: 'pending',
      confirmationNote: null,
      confirmedAt: null,
      extractionMethod: 'development-fixture',
      sourceLocator: {
        kind: 'development-fixture',
        fileId: file.id,
        fileName: file.fileName,
        pageNumber: null,
        sectionPath: ['开发演示数据（非原文解析）'],
        paragraphIndex: null,
        quote: fixture.description,
      },
      createdAt: now,
      updatedAt: now,
    }))
  }
}

