import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePrototype } from '../context/PrototypeContext'
import {
  adaptApiProject,
  adaptApiProjectFiles,
  adaptApiProjectListItem,
  adaptApiRequirement,
  adaptMockProjectFiles,
  adaptMockRequirement,
  getMockProject,
  getMockProjectList,
  type ProjectFileItem,
  type ProjectIdentity,
  type ProjectListItem,
  type RequirementListItem,
} from './adapters'
import { ApiError, apiClient } from './client'
import { isApiDataSource, runtimeConfig, type DataSource } from './config'
import type {
  ConfirmRequirementInput,
  CreateProjectInput,
  ProcessingTask,
  ProjectFileRecord,
  ProjectRecord,
  RequirementListQuery,
  RequirementRecord,
  UploadProjectFileResult,
} from './contracts'
import { getProjectDataSource } from './routing'

const MOCK_PROJECTS = getMockProjectList()
const ACTIVE_TASK_STATUSES = new Set<ProcessingTask['status']>(['queued', 'running'])
const EMPTY_PROJECT_RECORDS: ProjectRecord[] = []
const EMPTY_FILE_RECORDS: ProjectFileRecord[] = []
const EMPTY_TASKS: ProcessingTask[] = []
const EMPTY_REQUIREMENT_RECORDS: RequirementRecord[] = []

interface KeyedState<T> {
  key: string
  data: T
  loading: boolean
  error: ApiError | null
}

interface FilesAndTasks {
  files: ProjectFileRecord[]
  tasks: ProcessingTask[]
}

export interface ProjectListResource {
  source: DataSource
  projects: ProjectListItem[]
  records: ProjectRecord[]
  loading: boolean
  creating: boolean
  error: ApiError | null
  refresh: () => void
  createProject: (input: CreateProjectInput) => Promise<ProjectIdentity>
}

export interface ProjectListOptions {
  load?: boolean
}

export interface ProjectDetailResource {
  source: DataSource
  project: ProjectIdentity | null
  record: ProjectRecord | null
  loading: boolean
  error: ApiError | null
  refresh: () => void
}

export interface ProjectFilesResource {
  source: DataSource
  files: ProjectFileItem[]
  records: ProjectFileRecord[]
  tasks: ProcessingTask[]
  loading: boolean
  uploading: boolean
  polling: boolean
  error: ApiError | null
  refresh: () => void
  uploadFile: (file: File) => Promise<UploadProjectFileResult>
  uploadFiles: (files: File[]) => Promise<UploadProjectFileResult[]>
  retryTask: (taskId: string) => Promise<ProcessingTask>
  retryFile: (fileId: string) => Promise<ProcessingTask>
}

export interface ProjectRequirementsResource {
  source: DataSource
  requirements: RequirementListItem[]
  records: RequirementRecord[]
  loading: boolean
  confirmingIds: ReadonlySet<string>
  error: ApiError | null
  refresh: () => void
  confirmRequirement: (requirementId: string, input?: ConfirmRequirementInput) => Promise<RequirementListItem>
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError({
    title: 'Unexpected client error',
    status: 0,
    detail: error instanceof Error ? error.message : String(error),
  })
}

function apiModeRequired(operation: string): ApiError {
  return new ApiError({
    title: 'API mode required',
    status: 0,
    detail: `${operation} is only available for a real project while VITE_DATA_SOURCE=api.`,
  })
}

function useMountedRef() {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return mountedRef
}

async function loadFilesAndTasks(projectId: string, signal: AbortSignal): Promise<FilesAndTasks> {
  const [files, tasks] = await Promise.all([
    apiClient.files.list(projectId, signal),
    apiClient.tasks.list(projectId, signal),
  ])
  return { files, tasks }
}

function latestFailedTask(tasks: ProcessingTask[], fileId: string): ProcessingTask | undefined {
  let latest: ProcessingTask | undefined
  for (const task of tasks) {
    if (task.fileId !== fileId || task.status !== 'failed') continue
    if (!latest || task.createdAt > latest.createdAt) latest = task
  }
  return latest
}

export function useProjectList({ load = true }: ProjectListOptions = {}): ProjectListResource {
  const source: DataSource = isApiDataSource ? 'api' : 'mock'
  const mountedRef = useMountedRef()
  const createPromiseRef = useRef<Promise<ProjectIdentity> | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [creating, setCreating] = useState(false)
  const [state, setState] = useState<KeyedState<ProjectRecord[]>>({
    key: '',
    data: [],
    loading: source === 'api' && load,
    error: null,
  })

  useEffect(() => {
    if (source === 'mock' || !load) return
    const key = String(refreshVersion)
    const controller = new AbortController()
    let live = true
    setState((current) => ({ key, data: current.data, loading: true, error: null }))

    apiClient.projects.list(controller.signal)
      .then((records) => {
        if (live) setState({ key, data: records, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (live && !controller.signal.aborted) {
          setState((current) => ({ ...current, key, loading: false, error: toApiError(error) }))
        }
      })

    return () => {
      live = false
      controller.abort('Project list effect disposed')
    }
  }, [load, refreshVersion, source])

  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), [])
  const createProject = useCallback((input: CreateProjectInput) => {
    if (source !== 'api') throw apiModeRequired('Creating a persisted project')
    if (createPromiseRef.current) return createPromiseRef.current

    setCreating(true)
    const operation = apiClient.projects.create(input)
      .then((created) => {
        if (mountedRef.current) {
          setState((current) => ({ ...current, data: [created, ...current.data], error: null }))
        }
        return adaptApiProject(created)
      })
      .catch((error: unknown) => {
        const apiError = toApiError(error)
        if (mountedRef.current) setState((current) => ({ ...current, error: apiError }))
        throw apiError
      })
      .finally(() => {
        if (createPromiseRef.current === operation) createPromiseRef.current = null
        if (mountedRef.current) setCreating(false)
      })

    createPromiseRef.current = operation
    return operation
  }, [mountedRef, source])

  const records = source === 'api' ? state.data : EMPTY_PROJECT_RECORDS
  const projects = useMemo(
    () => source === 'api' ? records.map(adaptApiProjectListItem) : MOCK_PROJECTS,
    [records, source],
  )

  return {
    source,
    projects,
    records,
    loading: source === 'api' && load && state.loading,
    creating,
    error: source === 'api' ? state.error : null,
    refresh,
    createProject,
  }
}

export function useProjectDetail(projectId: string | null | undefined): ProjectDetailResource {
  const source = getProjectDataSource(projectId)
  const key = projectId ?? ''
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [state, setState] = useState<KeyedState<ProjectRecord | null>>({
    key: '',
    data: null,
    loading: source === 'api',
    error: null,
  })

  useEffect(() => {
    if (source !== 'api' || !projectId) return
    const requestKey = `${projectId}:${refreshVersion}`
    const controller = new AbortController()
    let live = true
    setState({ key: requestKey, data: null, loading: true, error: null })

    apiClient.projects.get(projectId, controller.signal)
      .then((record) => {
        if (live) setState({ key: requestKey, data: record, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (live && !controller.signal.aborted) {
          setState({ key: requestKey, data: null, loading: false, error: toApiError(error) })
        }
      })

    return () => {
      live = false
      controller.abort('Project detail effect disposed')
    }
  }, [projectId, refreshVersion, source])

  const requestKey = `${key}:${refreshVersion}`
  const currentState = state.key === requestKey ? state : { key: requestKey, data: null, loading: source === 'api', error: null }
  const record = source === 'api' ? currentState.data : null
  const project = source === 'api'
    ? (record ? adaptApiProject(record) : null)
    : (projectId ? getMockProject(projectId) : null)

  return {
    source,
    project,
    record,
    loading: source === 'api' && currentState.loading,
    error: source === 'api' ? currentState.error : null,
    refresh: useCallback(() => setRefreshVersion((value) => value + 1), []),
  }
}

export function useProjectFiles(projectId: string | null | undefined): ProjectFilesResource {
  const { files: mockFiles } = usePrototype()
  const source = getProjectDataSource(projectId)
  const mountedRef = useMountedRef()
  const key = projectId ?? ''
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [state, setState] = useState<KeyedState<FilesAndTasks>>({
    key: '',
    data: { files: [], tasks: [] },
    loading: source === 'api',
    error: null,
  })

  useEffect(() => {
    if (source !== 'api' || !projectId) return
    const requestKey = `${projectId}:${refreshVersion}`
    const controller = new AbortController()
    let live = true
    setState({ key: requestKey, data: { files: [], tasks: [] }, loading: true, error: null })

    loadFilesAndTasks(projectId, controller.signal)
      .then((data) => {
        if (live) setState({ key: requestKey, data, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (live && !controller.signal.aborted) {
          setState({ key: requestKey, data: { files: [], tasks: [] }, loading: false, error: toApiError(error) })
        }
      })

    return () => {
      live = false
      controller.abort('Project files effect disposed')
    }
  }, [projectId, refreshVersion, source])

  const requestKey = `${key}:${refreshVersion}`
  const currentState = state.key === requestKey
    ? state
    : { key: requestKey, data: { files: [], tasks: [] }, loading: source === 'api', error: null }
  const records = source === 'api' ? currentState.data.files : EMPTY_FILE_RECORDS
  const tasks = source === 'api' ? currentState.data.tasks : EMPTY_TASKS
  const activeTaskKey = useMemo(
    () => tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).map((task) => task.id).sort().join('|'),
    [tasks],
  )

  useEffect(() => {
    if (source !== 'api' || !projectId || activeTaskKey.length === 0) return
    const controller = new AbortController()
    let live = true
    let timeoutId: number | undefined

    const poll = async () => {
      try {
        const data = await loadFilesAndTasks(projectId, controller.signal)
        if (!live) return
        setState({ key: requestKey, data, loading: false, error: null })
        if (data.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))) {
          timeoutId = window.setTimeout(poll, runtimeConfig.apiPollIntervalMs)
        }
      } catch (error) {
        if (!live || controller.signal.aborted) return
        setState((current) => ({ ...current, error: toApiError(error) }))
        timeoutId = window.setTimeout(poll, runtimeConfig.apiPollIntervalMs)
      }
    }

    timeoutId = window.setTimeout(poll, runtimeConfig.apiPollIntervalMs)
    return () => {
      live = false
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      controller.abort('Task polling effect disposed')
    }
  }, [activeTaskKey, projectId, requestKey, source])

  const uploadFile = useCallback(async (file: File) => {
    if (source !== 'api' || !projectId) throw apiModeRequired('Uploading a persisted project file')
    setUploadingCount((count) => count + 1)
    try {
      const result = await apiClient.files.upload(projectId, file)
      if (mountedRef.current) {
        setState((current) => current.key === requestKey ? {
          ...current,
          data: {
            files: [result.file, ...current.data.files.filter((item) => item.id !== result.file.id)],
            tasks: [result.task, ...current.data.tasks.filter((item) => item.id !== result.task.id)],
          },
          error: null,
        } : current)
      }
      return result
    } catch (error) {
      const apiError = toApiError(error)
      if (mountedRef.current) setState((current) => ({ ...current, error: apiError }))
      throw apiError
    } finally {
      if (mountedRef.current) setUploadingCount((count) => Math.max(0, count - 1))
    }
  }, [mountedRef, projectId, requestKey, source])

  const uploadFiles = useCallback(
    (files: File[]) => Promise.all(files.map((file) => uploadFile(file))),
    [uploadFile],
  )

  const retryTask = useCallback(async (taskId: string) => {
    if (source !== 'api') throw apiModeRequired('Retrying a persisted parsing task')
    try {
      const retried = await apiClient.tasks.retry(taskId)
      if (mountedRef.current) {
        setState((current) => current.key === requestKey ? {
          ...current,
          data: {
            ...current.data,
            tasks: [retried, ...current.data.tasks.filter((item) => item.id !== retried.id)],
          },
          error: null,
        } : current)
      }
      return retried
    } catch (error) {
      const apiError = toApiError(error)
      if (mountedRef.current) setState((current) => ({ ...current, error: apiError }))
      throw apiError
    }
  }, [mountedRef, requestKey, source])

  const retryFile = useCallback((fileId: string) => {
    const task = latestFailedTask(tasks, fileId)
    if (!task) {
      throw new ApiError({ title: 'No failed task', status: 0, detail: 'This file has no failed parsing task to retry.' })
    }
    return retryTask(task.id)
  }, [retryTask, tasks])

  const files = useMemo(
    () => source === 'api' ? adaptApiProjectFiles(records, tasks) : adaptMockProjectFiles(mockFiles),
    [mockFiles, records, source, tasks],
  )

  return {
    source,
    files,
    records,
    tasks,
    loading: source === 'api' && currentState.loading,
    uploading: uploadingCount > 0,
    polling: source === 'api' && activeTaskKey.length > 0,
    error: source === 'api' ? currentState.error : null,
    refresh: useCallback(() => setRefreshVersion((value) => value + 1), []),
    uploadFile,
    uploadFiles,
    retryTask,
    retryFile,
  }
}

export function useProjectRequirements(
  projectId: string | null | undefined,
  query: RequirementListQuery = {},
): ProjectRequirementsResource {
  const { requirements: mockRequirements, updateRequirement } = usePrototype()
  const source = getProjectDataSource(projectId)
  const mountedRef = useMountedRef()
  const confirmationStatus = query.confirmationStatus
  const priority = query.priority
  const resourceKey = `${projectId ?? ''}:${confirmationStatus ?? ''}:${priority ?? ''}`
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(() => new Set())
  const [state, setState] = useState<KeyedState<RequirementRecord[]>>({
    key: '',
    data: [],
    loading: source === 'api',
    error: null,
  })

  useEffect(() => {
    if (source !== 'api' || !projectId) return
    const requestKey = `${resourceKey}:${refreshVersion}`
    const controller = new AbortController()
    let live = true
    setState({ key: requestKey, data: [], loading: true, error: null })

    apiClient.requirements.list(projectId, { confirmationStatus, priority }, controller.signal)
      .then((records) => {
        if (live) setState({ key: requestKey, data: records, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (live && !controller.signal.aborted) {
          setState({ key: requestKey, data: [], loading: false, error: toApiError(error) })
        }
      })

    return () => {
      live = false
      controller.abort('Requirements effect disposed')
    }
  }, [confirmationStatus, priority, projectId, refreshVersion, resourceKey, source])

  const requestKey = `${resourceKey}:${refreshVersion}`
  const currentState = state.key === requestKey
    ? state
    : { key: requestKey, data: [], loading: source === 'api', error: null }
  const records = source === 'api' ? currentState.data : EMPTY_REQUIREMENT_RECORDS
  const requirements = useMemo(
    () => source === 'api' ? records.map(adaptApiRequirement) : mockRequirements.map(adaptMockRequirement),
    [mockRequirements, records, source],
  )

  const confirmRequirement = useCallback(async (
    requirementId: string,
    input: ConfirmRequirementInput = { status: 'confirmed' },
  ) => {
    if (source === 'mock') {
      const current = mockRequirements.find((item) => item.id === requirementId)
      if (!current) throw new ApiError({ title: 'Requirement not found', status: 404 })
      const confirmed = input.status === 'confirmed'
      updateRequirement(requirementId, {
        confirmed,
        status: confirmed ? (current.status === '未确认' ? '待响应' : current.status) : '未确认',
      })
      return adaptMockRequirement({
        ...current,
        confirmed,
        status: confirmed ? (current.status === '未确认' ? '待响应' : current.status) : '未确认',
      })
    }

    if (!projectId) throw apiModeRequired('Confirming a persisted requirement')
    setConfirmingIds((current) => new Set(current).add(requirementId))
    try {
      const updated = await apiClient.requirements.confirm(projectId, requirementId, input)
      if (mountedRef.current) {
        setState((current) => ({
          ...current,
          data: current.data.map((item) => item.id === updated.id ? updated : item),
          error: null,
        }))
      }
      return adaptApiRequirement(updated)
    } catch (error) {
      const apiError = toApiError(error)
      if (mountedRef.current) setState((current) => ({ ...current, error: apiError }))
      throw apiError
    } finally {
      if (mountedRef.current) {
        setConfirmingIds((current) => {
          const next = new Set(current)
          next.delete(requirementId)
          return next
        })
      }
    }
  }, [mockRequirements, mountedRef, projectId, source, updateRequirement])

  return {
    source,
    requirements,
    records,
    loading: source === 'api' && currentState.loading,
    confirmingIds,
    error: source === 'api' ? currentState.error : null,
    refresh: useCallback(() => setRefreshVersion((value) => value + 1), []),
    confirmRequirement,
  }
}
