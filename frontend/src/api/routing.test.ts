import { describe, expect, it } from 'vitest'
import { getProjectIdFromPathname, projectRoute } from './routing'

describe('project routing', () => {
  it('builds project-scoped routes and encodes identifiers', () => {
    expect(projectRoute('project/1', 'files')).toBe('/projects/project%2F1/files')
    expect(projectRoute('demo', 'write/s32')).toBe('/projects/demo/write/s32')
  })

  it('extracts project identifiers without treating the new-project route as a project', () => {
    expect(getProjectIdFromPathname('/projects/01JABC/files')).toBe('01JABC')
    expect(getProjectIdFromPathname('/projects/project%2F1/analysis')).toBe('project/1')
    expect(getProjectIdFromPathname('/projects/new')).toBeNull()
    expect(getProjectIdFromPathname('/projects')).toBeNull()
  })
})
