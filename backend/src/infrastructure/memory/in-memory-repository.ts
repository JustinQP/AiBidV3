import type {
  NewProject,
  NewUpload,
  ParseTask,
  Project,
  ProjectFile,
  Requirement,
  RequirementConfirmation,
  RequirementFilters,
  StoredProjectFile,
} from '../../domain/models.js'
import type { BidRepository } from '../../domain/repository.js'

function publicFile(file: StoredProjectFile): ProjectFile {
  return {
    id: file.id,
    tenantId: file.tenantId,
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

export class InMemoryBidRepository implements BidRepository {
  private readonly projects = new Map<string, Project>()
  private readonly files = new Map<string, StoredProjectFile>()
  private readonly tasks = new Map<string, ParseTask>()
  private readonly requirements = new Map<string, Requirement>()

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

  async recoverPendingTasks(): Promise<ParseTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.status === 'queued')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => ({ ...task, error: task.error ? { ...task.error } : null }))
  }

  async createProject(project: NewProject): Promise<Project> {
    const stored = { ...project }
    this.projects.set(stored.id, stored)
    return { ...stored }
  }

  async listProjects(tenantId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => project.tenantId === tenantId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((project) => ({ ...project }))
  }

  async findProject(tenantId: string, projectId: string): Promise<Project | null> {
    const project = this.projects.get(projectId)
    return project?.tenantId === tenantId ? { ...project } : null
  }

  async createUpload(upload: NewUpload): Promise<{ file: ProjectFile; task: ParseTask }> {
    const project = this.projects.get(upload.file.projectId)
    if (project?.tenantId !== upload.file.tenantId || upload.task.tenantId !== upload.file.tenantId) {
      throw new Error('Cannot create an upload outside its tenant and project boundary')
    }
    this.files.set(upload.file.id, { ...upload.file, content: Buffer.from(upload.file.content) })
    this.tasks.set(upload.task.id, { ...upload.task })
    return { file: publicFile(upload.file), task: { ...upload.task } }
  }

  async listProjectFiles(tenantId: string, projectId: string): Promise<ProjectFile[]> {
    return [...this.files.values()]
      .filter((file) => file.tenantId === tenantId && file.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicFile)
  }

  async findStoredFile(tenantId: string, fileId: string): Promise<StoredProjectFile | null> {
    const file = this.files.get(fileId)
    if (file?.tenantId !== tenantId) return null
    return { ...file, content: Buffer.from(file.content) }
  }

  async listProjectTasks(tenantId: string, projectId: string): Promise<ParseTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.tenantId === tenantId && task.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => ({ ...task, error: task.error ? { ...task.error } : null }))
  }

  async findTask(tenantId: string, taskId: string): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId) return null
    return { ...task, error: task.error ? { ...task.error } : null }
  }

  async markTaskRunning(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId || task.status !== 'queued') return null
    const updated: ParseTask = {
      ...task,
      status: 'running',
      progress: 20,
      startedAt: now,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'parsing', updatedAt: now })
    }
    return { ...updated }
  }

  async completeTask(
    tenantId: string,
    taskId: string,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId || task.status !== 'running') return null
    for (const requirement of requirements) {
      if (
        requirement.tenantId !== tenantId ||
        requirement.taskId !== taskId ||
        requirement.projectId !== task.projectId ||
        requirement.fileId !== task.fileId
      ) {
        throw new Error('Cannot persist a requirement outside its task boundary')
      }
      this.requirements.set(requirement.id, { ...requirement })
    }
    const updated: ParseTask = {
      ...task,
      status: 'succeeded',
      progress: 100,
      finishedAt: now,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'parsed', updatedAt: now })
    }
    return { ...updated }
  }

  async failTask(
    tenantId: string,
    taskId: string,
    error: { code: string; message: string },
    now: string,
  ): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId || !['queued', 'running'].includes(task.status)) return null
    const updated: ParseTask = {
      ...task,
      status: 'failed',
      error: { ...error },
      finishedAt: now,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'failed', updatedAt: now })
    }
    return { ...updated, error: { ...error } }
  }

  async retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId || task.status !== 'failed') return null
    const updated: ParseTask = {
      ...task,
      status: 'queued',
      progress: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'queued', updatedAt: now })
    }
    return { ...updated }
  }

  async listRequirements(
    tenantId: string,
    projectId: string,
    filters: RequirementFilters,
  ): Promise<Requirement[]> {
    return [...this.requirements.values()]
      .filter(
        (requirement) =>
          requirement.tenantId === tenantId &&
          requirement.projectId === projectId &&
          (filters.confirmationStatus === undefined ||
            requirement.confirmationStatus === filters.confirmationStatus) &&
          (filters.priority === undefined || requirement.priority === filters.priority),
      )
      .sort((left, right) => left.code.localeCompare(right.code))
      .map((requirement) => ({
        ...requirement,
        sourceLocator: { ...requirement.sourceLocator, sectionPath: [...requirement.sourceLocator.sectionPath] },
      }))
  }

  async confirmRequirement(
    tenantId: string,
    projectId: string,
    requirementId: string,
    confirmation: RequirementConfirmation,
  ): Promise<Requirement | null> {
    const requirement = this.requirements.get(requirementId)
    if (requirement?.tenantId !== tenantId || requirement.projectId !== projectId) return null
    const updated: Requirement = {
      ...requirement,
      confirmationStatus: confirmation.status,
      confirmationNote: confirmation.note,
      confirmedAt: confirmation.confirmedAt,
      updatedAt: confirmation.confirmedAt,
    }
    this.requirements.set(requirementId, updated)
    return {
      ...updated,
      sourceLocator: { ...updated.sourceLocator, sectionPath: [...updated.sourceLocator.sectionPath] },
    }
  }
}
