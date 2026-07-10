import { describe, expect, it } from 'vitest'
import { initialFiles, initialIssues, initialOutline, initialRequirements } from './mock'

describe('prototype demo data', () => {
  it('keeps requirement and section identifiers unique', () => {
    expect(new Set(initialRequirements.map((item) => item.id)).size).toBe(initialRequirements.length)
    expect(new Set(initialOutline.map((item) => item.id)).size).toBe(initialOutline.length)
  })

  it('contains the recovery and compliance states required by the demo', () => {
    expect(initialFiles.some((item) => item.status === 'error')).toBe(true)
    expect(initialRequirements.some((item) => !item.confirmed)).toBe(true)
    expect(initialIssues.some((item) => item.severity === '阻断' && item.status === '待处理')).toBe(true)
  })

  it('maps confirmed requirements to a response section', () => {
    const confirmed = initialRequirements.filter((item) => item.confirmed)
    expect(confirmed.every((item) => item.section !== '未映射')).toBe(true)
  })
})
