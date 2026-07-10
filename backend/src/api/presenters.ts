import type { ParseTask, Project, ProjectFile, Requirement } from '../domain/models.js'

export function presentProject(project: Project): Omit<Project, 'tenantId'> {
  return {
    id: project.id,
    name: project.name,
    code: project.code,
    customerName: project.customerName,
    ownerName: project.ownerName,
    deadline: project.deadline,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export function presentFile(file: ProjectFile): Omit<ProjectFile, 'tenantId'> {
  return {
    id: file.id,
    projectId: file.projectId,
    fileName: file.fileName,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    parseStatus: file.parseStatus,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  }
}

export function presentTask(task: ParseTask): Omit<ParseTask, 'tenantId'> {
  return {
    id: task.id,
    projectId: task.projectId,
    fileId: task.fileId,
    type: task.type,
    status: task.status,
    progress: task.progress,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    updatedAt: task.updatedAt,
  }
}

export function presentRequirement(requirement: Requirement): Omit<Requirement, 'tenantId'> {
  return {
    id: requirement.id,
    projectId: requirement.projectId,
    fileId: requirement.fileId,
    taskId: requirement.taskId,
    code: requirement.code,
    title: requirement.title,
    description: requirement.description,
    category: requirement.category,
    priority: requirement.priority,
    confirmationStatus: requirement.confirmationStatus,
    confirmationNote: requirement.confirmationNote,
    confirmedAt: requirement.confirmedAt,
    extractionMethod: requirement.extractionMethod,
    sourceLocator: requirement.sourceLocator,
    createdAt: requirement.createdAt,
    updatedAt: requirement.updatedAt,
  }
}
