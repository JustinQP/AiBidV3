import { createHash } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from '../config.js'
import type {
  ConfirmationStatus,
  NewProject,
  NewUpload,
  ProjectStatus,
  RequirementFilters,
  RequirementPriority,
} from '../domain/models.js'
import type { BidRepository } from '../domain/repository.js'
import { badRequest, notFound, payloadTooLarge, unsupportedMediaType } from '../lib/app-error.js'
import { createId } from '../lib/id.js'
import type { UploadProcessingService } from '../application/upload-processing-service.js'
import { presentFile, presentProject, presentRequirement, presentTask } from './presenters.js'
import { getTenantId } from './tenant-context.js'

interface RouteDependencies {
  config: AppConfig
  repository: BidRepository
  processor: UploadProcessingService
}

interface ProjectParams {
  projectId: string
}

interface TaskParams {
  taskId: string
}

interface RequirementParams extends ProjectParams {
  requirementId: string
}

const confirmationStatuses: ConfirmationStatus[] = ['pending', 'confirmed', 'rejected']
const priorities: RequirementPriority[] = ['mandatory', 'important', 'normal']
const supportedExtensions = new Set(['.pdf', '.doc', '.docx', '.txt'])
const createProjectKeys = new Set(['name', 'code', 'customerName', 'ownerName', 'deadline'])
const requirementConfirmationKeys = new Set(['status', 'note'])
const rfc3339DateTime =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('INVALID_BODY', 'Request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function optionalString(body: Record<string, unknown>, key: string, maxLength = 160): string | null {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw badRequest('INVALID_BODY', `${key} must be a string up to ${maxLength} characters`)
  }
  return value.trim()
}

function normalizeRfc3339(value: string): string {
  const match = rfc3339DateTime.exec(value)
  if (!match) throw badRequest('INVALID_DEADLINE', 'deadline must be an RFC 3339 date-time')
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] =
    match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysByMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw badRequest('INVALID_DEADLINE', 'deadline must be a valid RFC 3339 date-time')
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    throw badRequest('INVALID_DEADLINE', 'deadline must be a valid RFC 3339 date-time')
  }
  return parsed.toISOString()
}

function projectIdFrom(request: FastifyRequest<{ Params: ProjectParams }>): string {
  const id = request.params.projectId
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw badRequest('INVALID_PROJECT_ID', 'Invalid project ID')
  return id
}

async function requireProject(
  request: FastifyRequest<{ Params: ProjectParams }>,
  dependencies: RouteDependencies,
): Promise<{ tenantId: string; projectId: string }> {
  const tenantId = getTenantId(request, dependencies.config)
  const projectId = projectIdFrom(request)
  const project = await dependencies.repository.findProject(tenantId, projectId)
  if (!project) throw notFound('PROJECT_NOT_FOUND', 'Project was not found')
  return { tenantId, projectId }
}

export async function registerRoutes(
  app: FastifyInstance,
  dependencies: RouteDependencies,
): Promise<void> {
  const { config, repository, processor } = dependencies

  app.get('/health', async () => {
    await repository.ping()
    return {
      data: {
        status: 'ok',
        repository: config.repositoryDriver,
        timestamp: new Date().toISOString(),
      },
    }
  })

  app.get('/api/v1/projects', async (request) => {
    const tenantId = getTenantId(request, config)
    const projects = await repository.listProjects(tenantId)
    return { data: projects.map(presentProject) }
  })

  app.post('/api/v1/projects', { config: { rateLimit: false } }, async (request, reply) => {
    const tenantId = getTenantId(request, config)
    const body = asRecord(request.body)
    const unknownKey = Object.keys(body).find((key) => !createProjectKeys.has(key))
    if (unknownKey) throw badRequest('UNKNOWN_PROJECT_FIELD', `Unknown project field: ${unknownKey}`)
    if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.trim().length > 160) {
      throw badRequest('INVALID_PROJECT_NAME', 'name must contain 1 to 160 characters')
    }
    let deadline: string | null = null
    const deadlineInput = optionalString(body, 'deadline', 64)
    if (deadlineInput) {
      deadline = normalizeRfc3339(deadlineInput)
    }
    const now = new Date().toISOString()
    const project: NewProject = {
      id: createId(),
      tenantId,
      name: body.name.trim(),
      code: optionalString(body, 'code', 80),
      customerName: optionalString(body, 'customerName'),
      ownerName: optionalString(body, 'ownerName'),
      deadline,
      status: 'draft' satisfies ProjectStatus,
      createdAt: now,
      updatedAt: now,
    }
    const created = await repository.createProject(project)
    return reply.code(201).send({ data: presentProject(created) })
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId', async (request) => {
    const { tenantId, projectId } = await requireProject(request, dependencies)
    const project = await repository.findProject(tenantId, projectId)
    return { data: presentProject(project!) }
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/files', async (request) => {
    const { tenantId, projectId } = await requireProject(request, dependencies)
    const files = await repository.listProjectFiles(tenantId, projectId)
    return { data: files.map(presentFile) }
  })

  app.post<{ Params: ProjectParams }>('/api/v1/projects/:projectId/files', async (request, reply) => {
    const { tenantId, projectId } = await requireProject(request, dependencies)
    if (!request.isMultipart()) {
      throw unsupportedMediaType('MULTIPART_REQUIRED', 'Content-Type must be multipart/form-data')
    }
    const part = await request.file()
    if (!part) throw badRequest('FILE_REQUIRED', 'Multipart field "file" is required')
    if (part.fieldname !== 'file') throw badRequest('FILE_REQUIRED', 'Multipart file field must be named "file"')
    const fileName = path.basename(part.filename.replaceAll('\\', '/')).trim()
    const extension = path.extname(fileName).toLowerCase()
    if (!fileName || fileName.length > 255) {
      throw badRequest('INVALID_FILE_NAME', 'File name must contain 1 to 255 characters')
    }
    if (!supportedExtensions.has(extension)) {
      throw unsupportedMediaType('UNSUPPORTED_FILE_TYPE', 'Only PDF, DOC, DOCX, and TXT files are accepted')
    }
    const content = await part.toBuffer()
    if (part.file.truncated) {
      throw payloadTooLarge('FILE_TOO_LARGE', `File exceeds ${config.maxUploadBytes} bytes`)
    }
    if (content.length === 0) throw badRequest('EMPTY_FILE', 'Uploaded file must not be empty')

    const now = new Date().toISOString()
    const fileId = createId()
    const taskId = createId()
    const upload: NewUpload = {
      file: {
        id: fileId,
        tenantId,
        projectId,
        fileName,
        mediaType: part.mimetype || 'application/octet-stream',
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        content,
        parseStatus: 'queued',
        createdAt: now,
        updatedAt: now,
      },
      task: {
        id: taskId,
        tenantId,
        projectId,
        fileId,
        type: 'development-document-parse',
        status: 'queued',
        progress: 0,
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      },
    }
    const created = await repository.createUpload(upload)
    processor.enqueue(tenantId, taskId)
    return reply.code(202).send({
      data: { file: presentFile(created.file), task: presentTask(created.task) },
    })
  })

  app.get<{ Params: ProjectParams }>('/api/v1/projects/:projectId/tasks', async (request) => {
    const { tenantId, projectId } = await requireProject(request, dependencies)
    const tasks = await repository.listProjectTasks(tenantId, projectId)
    return { data: tasks.map(presentTask) }
  })

  app.get<{ Params: TaskParams }>('/api/v1/tasks/:taskId', async (request) => {
    const tenantId = getTenantId(request, config)
    const taskId = request.params.taskId
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(taskId)) throw badRequest('INVALID_TASK_ID', 'Invalid task ID')
    const task = await repository.findTask(tenantId, taskId)
    if (!task) throw notFound('TASK_NOT_FOUND', 'Task was not found')
    return { data: presentTask(task) }
  })

  app.post<{ Params: TaskParams }>('/api/v1/tasks/:taskId/retry', async (request, reply) => {
    const tenantId = getTenantId(request, config)
    const taskId = request.params.taskId
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(taskId)) throw badRequest('INVALID_TASK_ID', 'Invalid task ID')
    const task = await repository.findTask(tenantId, taskId)
    if (!task) throw notFound('TASK_NOT_FOUND', 'Task was not found')
    if (task.status !== 'failed') {
      throw badRequest('TASK_NOT_RETRYABLE', 'Only failed tasks can be retried')
    }
    const retried = await repository.retryTask(tenantId, taskId, new Date().toISOString())
    if (!retried) throw badRequest('TASK_NOT_RETRYABLE', 'Task can no longer be retried')
    processor.enqueue(tenantId, taskId)
    return reply.code(202).send({ data: presentTask(retried) })
  })

  app.get<{ Params: ProjectParams; Querystring: Record<string, string | undefined> }>(
    '/api/v1/projects/:projectId/requirements',
    async (request) => {
      const { tenantId, projectId } = await requireProject(request, dependencies)
      const confirmationStatus = request.query.confirmationStatus
      const priority = request.query.priority
      if (confirmationStatus && !confirmationStatuses.includes(confirmationStatus as ConfirmationStatus)) {
        throw badRequest('INVALID_CONFIRMATION_STATUS', 'Invalid confirmationStatus filter')
      }
      if (priority && !priorities.includes(priority as RequirementPriority)) {
        throw badRequest('INVALID_PRIORITY', 'Invalid priority filter')
      }
      const filters: RequirementFilters = {}
      if (confirmationStatus) filters.confirmationStatus = confirmationStatus as ConfirmationStatus
      if (priority) filters.priority = priority as RequirementPriority
      const requirements = await repository.listRequirements(tenantId, projectId, filters)
      return { data: requirements.map(presentRequirement) }
    },
  )

  app.patch<{ Params: RequirementParams }>(
    '/api/v1/projects/:projectId/requirements/:requirementId/confirmation',
    async (request) => {
      const { tenantId, projectId } = await requireProject(request, dependencies)
      const requirementId = request.params.requirementId
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(requirementId)) {
        throw badRequest('INVALID_REQUIREMENT_ID', 'Invalid requirement ID')
      }
      const body = asRecord(request.body)
      const unknownKey = Object.keys(body).find((key) => !requirementConfirmationKeys.has(key))
      if (unknownKey) {
        throw badRequest('UNKNOWN_CONFIRMATION_FIELD', `Unknown confirmation field: ${unknownKey}`)
      }
      if (body.status !== 'confirmed' && body.status !== 'rejected') {
        throw badRequest('INVALID_CONFIRMATION', 'status must be confirmed or rejected')
      }
      const requirement = await repository.confirmRequirement(tenantId, projectId, requirementId, {
        status: body.status,
        note: optionalString(body, 'note', 1000),
        confirmedAt: new Date().toISOString(),
      })
      if (!requirement) throw notFound('REQUIREMENT_NOT_FOUND', 'Requirement was not found')
      return { data: presentRequirement(requirement) }
    },
  )
}
