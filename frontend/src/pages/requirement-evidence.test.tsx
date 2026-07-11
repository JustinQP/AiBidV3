import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  RequirementEvidence,
  RequirementListItem,
} from '../api/adapters'
import {
  RequirementEvidenceDetails,
  RequirementEvidenceNotice,
} from './requirement-evidence'

const QUOTE_SHA = 'a'.repeat(64)
const SOURCE_SHA = 'b'.repeat(64)

function requirement(evidence: RequirementEvidence): RequirementListItem {
  return {
    id: `requirement-${evidence.kind}`,
    code: 'REQ-001',
    title: '提交技术实施方案',
    summary: '投标人必须提交完整的技术实施方案。',
    type: '技术要求',
    source: `技术要求.${evidence.kind === 'txt' ? 'txt' : evidence.kind === 'pdf' ? 'pdf' : 'docx'}`,
    page: evidence.kind === 'pdf' ? 3 : null,
    sectionPath: ['技术要求', '实施方案'],
    sourceQuote: '投标人必须提交完整的技术实施方案。',
    mandatory: true,
    confidence: evidence.kind === 'development-fixture' ? null : 94.6,
    owner: null,
    section: null,
    risk: null,
    status: '未确认',
    confirmed: false,
    confirmationStatus: 'pending',
    confirmationNote: null,
    priority: 'mandatory',
    score: null,
    evidence,
  }
}

function realEvidence(
  kind: 'pdf' | 'docx' | 'txt',
  label: string,
  anchorLabel: string,
  anchorDetails: string[],
): RequirementEvidence {
  return {
    kind,
    label,
    sourceRevision: 1,
    parserVersion: 'deterministic-rules-v1',
    anchorLabel,
    anchorDetails,
    quoteSha256: QUOTE_SHA,
    sourceSha256: SOURCE_SHA,
    verified: false,
  }
}

const REAL_CASES = [
  realEvidence('pdf', 'PDF 页区证据', '第 3 页 · 1 个区域', [
    '区域 1：页 3',
    '边界框：x 0.1000，y 0.2000，宽 0.5000，高 0.0600',
  ]),
  realEvidence('docx', 'DOCX 文本范围证据', '段落 8 · 字符 0–19', [
    '段落索引：7',
    '字符范围：0–19',
  ]),
  realEvidence('txt', 'TXT 行列证据', '第 4 行第 0 列至第 4 行第 19 列', [
    '起点：第 4 行，第 0 列',
    '终点：第 4 行，第 19 列',
  ]),
] as const

describe('RequirementEvidenceDetails', () => {
  it.each(REAL_CASES)('renders exact $kind evidence without inventing verification claims', (evidence) => {
    const html = renderToStaticMarkup(
      <RequirementEvidenceDetails requirement={requirement(evidence)} />,
    )

    expect(html).toContain(evidence.label)
    expect(html).toContain(evidence.anchorLabel)
    evidence.anchorDetails.forEach((detail) => expect(html).toContain(detail))
    expect(html).toContain('投标人必须提交完整的技术实施方案。')
    expect(html).toContain('修订 1')
    expect(html).toContain('deterministic-rules-v1')
    expect(html).toContain(QUOTE_SHA)
    expect(html).toContain(SOURCE_SHA)
    expect(html).toContain('规则得分')
    expect(html).toContain('95%')
    expect(html).not.toContain('94.6%')
    expect(html).toContain('仍需人工确认')
    expect(html).toContain('未通过原件重解析验证')
    expect(html).not.toContain('打开整页')
    expect(html).not.toContain('坐标已校验')
    expect(html).not.toContain('原文上下文')
  })

  it('marks a historical fixture as non-real evidence', () => {
    const fixture = requirement({
      kind: 'development-fixture',
      label: '历史开发夹具',
      sourceRevision: null,
      parserVersion: null,
      anchorLabel: '页码与段落均未提供',
      anchorDetails: [],
      quoteSha256: null,
      sourceSha256: null,
      verified: false,
    })

    const html = renderToStaticMarkup(<RequirementEvidenceDetails requirement={fixture} />)

    expect(html).toContain('development-fixture')
    expect(html).toContain('非真实证据')
    expect(html).toContain('没有读取上传文件正文')
    expect(html).not.toContain('坐标已校验')
    expect(html).not.toContain('已核验')
  })
})

describe('RequirementEvidenceNotice', () => {
  const pdf = requirement(REAL_CASES[0])
  const fixture = requirement({
    kind: 'development-fixture',
    label: '历史开发夹具',
    sourceRevision: null,
    parserVersion: null,
    anchorLabel: '无真实锚点',
    anchorDetails: [],
    quoteSha256: null,
    sourceSha256: null,
    verified: false,
  })

  it('describes an all-real result set as unverified real parser evidence', () => {
    const html = renderToStaticMarkup(<RequirementEvidenceNotice requirements={[pdf]} />)
    expect(html).toContain('真实解析证据待人工核验')
    expect(html).toContain('1 条')
    expect(html).toContain('未通过原件重解析验证')
  })

  it('describes an all-fixture result set as historical non-real output', () => {
    const html = renderToStaticMarkup(<RequirementEvidenceNotice requirements={[fixture]} />)
    expect(html).toContain('历史开发夹具不是原文证据')
    expect(html).toContain('1 条')
  })

  it('describes mixed real and fixture results without collapsing their provenance', () => {
    const html = renderToStaticMarkup(
      <RequirementEvidenceNotice requirements={[pdf, fixture]} />,
    )
    expect(html).toContain('真实证据与历史夹具并存')
    expect(html).toContain('1 条真实解析证据')
    expect(html).toContain('1 条历史开发夹具')
  })
})
