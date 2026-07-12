import { describe, expect, it } from 'vitest'
import { parseText } from './helpers/document-fixtures.js'

// This synthetic corpus is a deterministic contract fixture. It is deliberately
// not presented as evidence of production accuracy on real procurement files.
const HARD_POSITIVES = Array.from({ length: 60 }, (_, index) => {
  const variants = [
    `Supplier ${index} must encrypt stored data.`,
    `Bidder ${index} SHALL provide an audit trail.`,
    `供应商${index}必须提交技术方案。`,
    `供应商${index}不得泄露客户数据。`,
    `供应商${index}应当保留审计日志。`,
    `供应商${index}须提供测试报告。`,
  ]
  return variants[index % variants.length]!
})

const SCORE_POSITIVES = Array.from({ length: 24 }, (_, index) => {
  const points = index + 1
  const variants = [
    `方案${index}最高可得${points}分。`,
    `案例${index}满分为 ${points} 分。`,
    `Item ${index} is worth ${points} points.`,
    `Item ${index} has a maximum of ${points} points.`,
  ]
  return variants[index % variants.length]!
})

const INDEPENDENT_NEGATIVES = [
  'Mustard appears in the catering notes.',
  'Shallots appear in the catering notes.',
  '本事项无需供应商处理。',
  '本事项无须另行盖章。',
  '请先阅读投标须知。',
  'See page 12 for the architecture.',
  'The software version is 3.2.',
  'Delivery takes 10 days.',
  'The maximum file size is 20 MB.',
  'The supplier describes its service model.',
  '供应商介绍服务模式。',
  '方案包含项目背景和现状。',
  'The page contains 10 diagrams.',
  'Version 5 contains revised wording.',
  'The deadline occurs in 30 days.',
  'This sentence has ordinary declarative text.',
  '最高建筑高达10米。',
  '总预算为100万元。',
  '评分办法见附件。',
  'The score is shown in another system.',
  'Points are discussed without a number.',
  'Award criteria are described generally.',
  'A max value exists without points.',
  '计量单位为千米。',
]

describe('deterministic-rules-v1 synthetic contract benchmark', () => {
  it('has at least 50 labeled hard positives and recalls at least 98%', async () => {
    expect(HARD_POSITIVES.length).toBeGreaterThanOrEqual(50)
    const requirements = await parseText(HARD_POSITIVES.join('\n'))
    const extracted = new Set(requirements.map((item) => item.description))
    const truePositives = HARD_POSITIVES.filter((quote) => extracted.has(quote)).length
    expect(truePositives / HARD_POSITIVES.length).toBeGreaterThanOrEqual(0.98)
  })

  it('has at least 20 labeled score positives and recalls at least 95%', async () => {
    expect(SCORE_POSITIVES.length).toBeGreaterThanOrEqual(20)
    const requirements = await parseText(SCORE_POSITIVES.join('\n'))
    const extracted = new Set(requirements.map((item) => item.description))
    const truePositives = SCORE_POSITIVES.filter((quote) => extracted.has(quote)).length
    expect(truePositives / SCORE_POSITIVES.length).toBeGreaterThanOrEqual(0.95)
  })

  it('keeps the independent negative fixture free of rule matches', async () => {
    await expect(parseText(INDEPENDENT_NEGATIVES.join('\n'))).resolves.toEqual([])
  })
})
