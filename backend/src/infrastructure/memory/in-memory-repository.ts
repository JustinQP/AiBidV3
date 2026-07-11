import { randomUUID } from 'node:crypto'
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
} from '../../domain/models.js'
import type { BidRepository } from '../../domain/repository.js'
import { createId } from '../../lib/id.js'

interface InMemoryOutboxEvent {
  event: TaskOutboxEvent
  availableAt: string
  publishedAt: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  lastError: TaskError | null
}

function cloneTask(task: ParseTask): ParseTask {
  return { ...task, error: task.error ? { ...task.error } : null }
}

function isAfter(left: string, right: string): boolean {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime
}

function publicFile(file: ProjectFile): ProjectFile {
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
  private readonly files = new Map<string, StoredProjectFileRecord>()
  private readonly tasks = new Map<string, ParseTask>()
  private readonly taskNextAttemptAt = new Map<string, string>()
  private readonly taskLeases = new Map<string, TaskLease>()
  private readonly deadLetteredTasks = new Set<string>()
  private readonly outbox = new Map<string, InMemoryOutboxEvent>()
  private readonly requirements = new Map<string, Requirement>()

  async ping(): Promise<void> {}

  async close(): Promise<void> {}

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
    if (
      project?.tenantId !== upload.file.tenantId ||
      upload.task.tenantId !== upload.file.tenantId ||
      upload.task.projectId !== upload.file.projectId ||
      upload.task.fileId !== upload.file.id ||
      upload.file.parseStatus !== 'queued' ||
      upload.task.status !== 'queued' ||
      upload.task.progress !== 0 ||
      upload.task.attempt !== 0 ||
      upload.task.error !== null ||
      upload.task.startedAt !== null ||
      upload.task.finishedAt !== null
    ) {
      throw new Error('Cannot create an upload outside its tenant and project boundary')
    }
    const { objectReference, ...file } = upload.file
    this.files.set(upload.file.id, {
      ...file,
      source: { kind: 'object', reference: { ...objectReference } },
    })
    this.tasks.set(upload.task.id, cloneTask(upload.task))
    this.taskNextAttemptAt.set(upload.task.id, upload.task.createdAt)
    this.insertOutboxEvent(upload.task.tenantId, upload.task.id, upload.task.createdAt, upload.task.createdAt)
    return { file: publicFile(upload.file), task: cloneTask(upload.task) }
  }

  async listProjectFiles(tenantId: string, projectId: string): Promise<ProjectFile[]> {
    return [...this.files.values()]
      .filter((file) => file.tenantId === tenantId && file.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicFile)
  }

  async findStoredFile(tenantId: string, fileId: string): Promise<StoredProjectFileRecord | null> {
    const file = this.files.get(fileId)
    if (file?.tenantId !== tenantId) return null
    return {
      ...file,
      source:
        file.source.kind === 'object'
          ? { kind: 'object', reference: { ...file.source.reference } }
          : { kind: 'legacy-inline', content: Buffer.from(file.source.content) },
    }
  }

  async listProjectTasks(tenantId: string, projectId: string): Promise<ParseTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.tenantId === tenantId && task.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneTask)
  }

  async findTask(tenantId: string, taskId: string): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId) return null
    return cloneTask(task)
  }

  async claimTask(
    tenantId: string,
    taskId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    maxAttempts: number,
  ): Promise<ClaimedTask | null> {
    const task = this.tasks.get(taskId)
    const currentLease = this.taskLeases.get(taskId)
    const delayedRetryPending = task !== undefined && isAfter(
      this.taskNextAttemptAt.get(taskId) ?? task.createdAt,
      now,
    )
    const canReclaimExpired =
      task?.status === 'running' &&
      currentLease !== undefined &&
      !isAfter(currentLease.expiresAt, now)
    if (
      task?.tenantId !== tenantId ||
      this.deadLetteredTasks.has(taskId) ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      (task.status === 'queued' && delayedRetryPending) ||
      (task.status !== 'queued' && !canReclaimExpired) ||
      !isAfter(leaseExpiresAt, now)
    ) {
      return null
    }
    if (task.attempt >= maxAttempts) {
      const exhausted: ParseTask = {
        ...task,
        status: 'failed',
        error: {
          code: 'TASK_ATTEMPTS_EXHAUSTED',
          message: 'Task attempts were exhausted before a worker could complete it',
        },
        finishedAt: now,
        updatedAt: now,
      }
      this.tasks.set(taskId, exhausted)
      this.taskLeases.delete(taskId)
      this.deadLetteredTasks.add(taskId)
      const file = this.files.get(task.fileId)
      if (file?.tenantId === tenantId) {
        this.files.set(file.id, { ...file, parseStatus: 'failed', updatedAt: now })
      }
      return null
    }
    const lease: TaskLease = {
      tenantId,
      taskId,
      workerId,
      token: randomUUID(),
      expiresAt: leaseExpiresAt,
    }
    const updated: ParseTask = {
      ...task,
      status: 'running',
      progress: 20,
      attempt: task.attempt + 1,
      error: null,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    this.taskLeases.set(taskId, lease)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'parsing', updatedAt: now })
    }
    return { task: cloneTask(updated), lease: { ...lease } }
  }

  async renewTaskLease(
    lease: TaskLease,
    now: string,
    leaseExpiresAt: string,
  ): Promise<TaskLease | null> {
    if (!this.hasValidLease(lease, now) || !isAfter(leaseExpiresAt, now)) return null
    const renewed = { ...lease, expiresAt: leaseExpiresAt }
    this.taskLeases.set(lease.taskId, renewed)
    const task = this.tasks.get(lease.taskId)
    if (task) this.tasks.set(task.id, { ...task, updatedAt: now })
    return { ...renewed }
  }

  async completeTask(
    lease: TaskLease,
    requirements: Requirement[],
    now: string,
  ): Promise<ParseTask | null> {
    const task = this.tasks.get(lease.taskId)
    if (task?.tenantId !== lease.tenantId || !this.hasValidLease(lease, now)) return null
    for (const requirement of requirements) {
      if (
        requirement.tenantId !== lease.tenantId ||
        requirement.taskId !== lease.taskId ||
        requirement.projectId !== task.projectId ||
        requirement.fileId !== task.fileId
      ) {
        throw new Error('Cannot persist a requirement outside its task boundary')
      }
    }
    for (const requirement of requirements) {
      this.requirements.set(requirement.id, { ...requirement })
    }
    const updated: ParseTask = {
      ...task,
      status: 'succeeded',
      progress: 100,
      error: null,
      finishedAt: now,
      updatedAt: now,
    }
    this.tasks.set(lease.taskId, updated)
    this.taskLeases.delete(lease.taskId)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === lease.tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'parsed', updatedAt: now })
    }
    return cloneTask(updated)
  }

  async failTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    deadLetter: boolean,
  ): Promise<ParseTask | null> {
    const task = this.tasks.get(lease.taskId)
    if (task?.tenantId !== lease.tenantId || !this.hasValidLease(lease, now)) return null
    const updated: ParseTask = {
      ...task,
      status: 'failed',
      error: { ...error },
      finishedAt: now,
      updatedAt: now,
    }
    this.tasks.set(lease.taskId, updated)
    this.taskLeases.delete(lease.taskId)
    if (deadLetter) this.deadLetteredTasks.add(lease.taskId)
    else this.deadLetteredTasks.delete(lease.taskId)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === lease.tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'failed', updatedAt: now })
    }
    return cloneTask(updated)
  }

  async requeueTask(
    lease: TaskLease,
    error: TaskError,
    now: string,
    availableAt: string,
  ): Promise<ParseTask | null> {
    const task = this.tasks.get(lease.taskId)
    if (task?.tenantId !== lease.tenantId || !this.hasValidLease(lease, now)) return null
    const updated: ParseTask = {
      ...task,
      status: 'queued',
      progress: 0,
      error: { ...error },
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    }
    this.tasks.set(lease.taskId, updated)
    this.taskNextAttemptAt.set(lease.taskId, availableAt)
    this.taskLeases.delete(lease.taskId)
    this.deadLetteredTasks.delete(lease.taskId)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === lease.tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'queued', updatedAt: now })
    }
    this.insertOutboxEvent(lease.tenantId, lease.taskId, availableAt, now)
    return cloneTask(updated)
  }

  async retryTask(tenantId: string, taskId: string, now: string): Promise<ParseTask | null> {
    const task = this.tasks.get(taskId)
    if (task?.tenantId !== tenantId || task.status !== 'failed') return null
    const updated: ParseTask = {
      ...task,
      status: 'queued',
      progress: 0,
      attempt: 0,
      error: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    }
    this.tasks.set(taskId, updated)
    this.taskNextAttemptAt.set(taskId, now)
    this.taskLeases.delete(taskId)
    this.deadLetteredTasks.delete(taskId)
    const file = this.files.get(task.fileId)
    if (file?.tenantId === tenantId) {
      this.files.set(file.id, { ...file, parseStatus: 'queued', updatedAt: now })
    }
    this.insertOutboxEvent(tenantId, taskId, now, now)
    return cloneTask(updated)
  }

  async claimOutboxEvents(
    workerId: string,
    now: string,
    leaseExpiresAt: string,
    limit: number,
  ): Promise<TaskOutboxEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !isAfter(leaseExpiresAt, now)) return []
    const candidates = [...this.outbox.values()]
      .filter(
        ({ availableAt, publishedAt, leaseOwner, leaseExpiresAt: currentLeaseExpiresAt }) =>
          publishedAt === null &&
          !isAfter(availableAt, now) &&
          (leaseOwner === null ||
            currentLeaseExpiresAt === null ||
            !isAfter(currentLeaseExpiresAt, now)),
      )
      .sort(
        (left, right) =>
          left.availableAt.localeCompare(right.availableAt) ||
          left.event.createdAt.localeCompare(right.event.createdAt) ||
          left.event.id.localeCompare(right.event.id),
      )
      .slice(0, limit)

    return candidates.map((candidate) => {
      candidate.leaseOwner = workerId
      candidate.leaseExpiresAt = leaseExpiresAt
      candidate.lastError = null
      candidate.event = {
        ...candidate.event,
        publishAttempts: candidate.event.publishAttempts + 1,
      }
      return { ...candidate.event }
    })
  }

  async markOutboxEventPublished(
    eventId: string,
    workerId: string,
    publishedAt: string,
  ): Promise<boolean> {
    const stored = this.outbox.get(eventId)
    if (
      !stored ||
      stored.publishedAt !== null ||
      stored.leaseOwner !== workerId ||
      stored.leaseExpiresAt === null ||
      !isAfter(stored.leaseExpiresAt, publishedAt)
    ) {
      return false
    }
    stored.publishedAt = publishedAt
    stored.leaseOwner = null
    stored.leaseExpiresAt = null
    stored.lastError = null
    return true
  }

  async releaseOutboxEvent(
    eventId: string,
    workerId: string,
    error: TaskError,
    releasedAt: string,
    availableAt: string,
  ): Promise<boolean> {
    const stored = this.outbox.get(eventId)
    if (
      !stored ||
      stored.publishedAt !== null ||
      stored.leaseOwner !== workerId ||
      stored.leaseExpiresAt === null ||
      !isAfter(stored.leaseExpiresAt, releasedAt)
    ) {
      return false
    }
    stored.availableAt = availableAt
    stored.leaseOwner = null
    stored.leaseExpiresAt = null
    stored.lastError = { ...error }
    return true
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

  private hasValidLease(lease: TaskLease, now: string): boolean {
    const task = this.tasks.get(lease.taskId)
    const stored = this.taskLeases.get(lease.taskId)
    return (
      task?.tenantId === lease.tenantId &&
      task.status === 'running' &&
      stored?.tenantId === lease.tenantId &&
      stored.workerId === lease.workerId &&
      stored.token === lease.token &&
      isAfter(stored.expiresAt, now)
    )
  }

  private insertOutboxEvent(
    tenantId: string,
    taskId: string,
    availableAt: string,
    createdAt: string,
  ): void {
    const event: TaskOutboxEvent = {
      id: createId(),
      tenantId,
      taskId,
      publishAttempts: 0,
      createdAt,
    }
    this.outbox.set(event.id, {
      event,
      availableAt,
      publishedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
    })
  }
}
