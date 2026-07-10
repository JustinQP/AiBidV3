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
} from './models.js'

export interface BidRepository {
  ping(): Promise<void>
  close(): Promise<void>
  /** Privileged single-instance startup operation; not a tenant-facing query. */
  recoverPendingTasks(): Promise<ParseTask[]>

  createProject(project: NewProject): Promise<Project>
  listProjects(tenantId: string): Promise<Project[]>
  findProject(tenantId: string, projectId: string): Promise<Project | null>

  createUpload(upload: NewUpload): Promise<{ file: ProjectFile; task: ParseTask }>
  listProjectFiles(tenantId: string, projectId: string): Promise<ProjectFile[]>
  findStoredFile(tenantId: string, fileId: string): Promise<StoredProjectFile | null>

  listProjectTasks(tenantId: string, projectId: string): Promise<ParseTask[]>
  findTask(tenantId: string, taskId: string): Promise<ParseTask | null>
  markTaskRunning(tenantId: string, taskId: string, now: string): Promise<ParseTask | null>
  completeTask(
    tenantId: string,
    taskId: string,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null>
  failTask(
    tenantId: string,
    taskId: string,
    error: { code: string; message: string },
    now: string,
  ): Promise<ParseTask | null>
  retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null>

  listRequirements(
    tenantId: string,
    projectId: string,
    filters: RequirementFilters,
  ): Promise<Requirement[]>
  confirmRequirement(
    tenantId: string,
    projectId: string,
    requirementId: string,
    confirmation: RequirementConfirmation,
  ): Promise<Requirement | null>
}
