import type {
  ClaimedTask,
  NewProject,
  NewUpload,
  ParseTask,
  Project,
  ProjectFile,
  Requirement,
  RequirementConfirmation,
  RequirementFilters,
  StoredProjectFileRecord,
  TaskError,
  TaskLease,
  TaskOutboxEvent,
} from './models.js'

export interface BidRepository {
  ping(): Promise<void>
  close(): Promise<void>

  createProject(project: NewProject): Promise<Project>
  listProjects(tenantId: string): Promise<Project[]>
  findProject(tenantId: string, projectId: string): Promise<Project | null>

  createUpload(upload: NewUpload): Promise<{ file: ProjectFile; task: ParseTask }>
  listProjectFiles(tenantId: string, projectId: string): Promise<ProjectFile[]>
  findStoredFile(tenantId: string, fileId: string): Promise<StoredProjectFileRecord | null>

  listProjectTasks(tenantId: string, projectId: string): Promise<ParseTask[]>
  findTask(tenantId: string, taskId: string): Promise<ParseTask | null>
  claimTask(
    tenantId: string,
    taskId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    maxAttempts: number,
  ): Promise<ClaimedTask | null>
  renewTaskLease(
    lease: TaskLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TaskLease | null>
  completeTask(
    lease: TaskLease,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null>
  failTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    deadLetter: boolean,
  ): Promise<ParseTask | null>
  requeueTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    availableAt: string,
  ): Promise<ParseTask | null>
  retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null>

  claimOutboxEvents(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<TaskOutboxEvent[]>
  markOutboxEventPublished(eventId: string, workerId: string, publishedAt: string): Promise<boolean>
  releaseOutboxEvent(
    eventId: string,
    workerId: string,
    error: TaskError,
    releasedAt: string,
    availableAt: string,
  ): Promise<boolean>

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
