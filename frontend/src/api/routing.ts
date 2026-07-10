import { useLocation } from 'react-router-dom'
import { isApiDataSource, type DataSource } from './config'

export const DEMO_PROJECT_ID = 'demo'

export type ProjectRouteDestination =
  | 'overview'
  | 'files'
  | 'analysis'
  | 'requirements'
  | 'outline'
  | 'review'
  | 'export'
  | 'settings'
  | `write/${string}`

export function isDemoProjectId(projectId: string | null | undefined): boolean {
  return projectId === DEMO_PROJECT_ID
}

export function getProjectDataSource(projectId: string | null | undefined): DataSource {
  return isApiDataSource && projectId && !isDemoProjectId(projectId) ? 'api' : 'mock'
}

export function getProjectIdFromPathname(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname)
  if (!match || match[1] === 'new') return null

  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

export function projectRoute(projectId: string, destination: ProjectRouteDestination): string {
  return `/projects/${encodeURIComponent(projectId)}/${destination}`
}

export function useCurrentProjectId(): string | null {
  return getProjectIdFromPathname(useLocation().pathname)
}
