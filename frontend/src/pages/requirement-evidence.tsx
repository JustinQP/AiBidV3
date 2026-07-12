import type { RequirementEvidence, RequirementListItem } from '../api/adapters'
import { Badge, Button, InlineMessage } from '../components/ui'

type EvidenceRequirement = Pick<
  RequirementListItem,
  | 'code'
  | 'confidence'
  | 'confirmationNote'
  | 'evidence'
  | 'page'
  | 'sectionPath'
  | 'source'
  | 'sourceQuote'
  | 'summary'
  | 'type'
>

interface RequirementEvidenceDetailsProps {
  requirement: EvidenceRequirement
  onClose?: () => void
  onEdit?: () => void
}

function isRealEvidence(
  evidence: RequirementEvidence,
): evidence is Extract<RequirementEvidence, { kind: 'pdf' | 'docx' | 'txt' }> {
  return evidence.kind === 'pdf' || evidence.kind === 'docx' || evidence.kind === 'txt'
}

function formatConfidencePercent(confidence: number): string {
  return `${Math.round(confidence)}%`
}

export function RequirementEvidenceNotice({
  requirements,
}: {
  requirements: readonly Pick<RequirementListItem, 'evidence'>[]
}) {
  let realCount = 0
  let fixtureCount = 0
  for (const requirement of requirements) {
    if (isRealEvidence(requirement.evidence)) realCount += 1
    else if (requirement.evidence.kind === 'development-fixture') fixtureCount += 1
  }

  if (realCount > 0 && fixtureCount > 0) {
    return (
      <InlineMessage tone="warning" title="真实证据与历史夹具并存">
        当前包含 {realCount} 条真实解析证据和 {fixtureCount} 条历史开发夹具。两类来源不会合并标记；真实证据仍需人工核验，历史夹具不是原文证据。
      </InlineMessage>
    )
  }
  if (realCount > 0) {
    return (
      <InlineMessage tone="info" title="真实解析证据待人工核验">
        当前 {realCount} 条结果带有精确原文片段和版本化锚点，但尚未通过原件重解析验证，仍需人工确认。
      </InlineMessage>
    )
  }
  if (fixtureCount > 0) {
    return (
      <InlineMessage tone="warning" title="历史开发夹具不是原文证据">
        当前 {fixtureCount} 条 <code>development-fixture</code> 结果没有读取上传文件正文，仅用于兼容历史流程。
      </InlineMessage>
    )
  }
  return null
}

export function RequirementSourceLabel({ requirement }: { requirement: EvidenceRequirement }) {
  const { evidence } = requirement
  let detail: string
  if (isRealEvidence(evidence)) detail = `${evidence.label} · ${evidence.anchorLabel} · 查看证据`
  else if (evidence.kind === 'development-fixture') detail = '历史开发夹具 · 非真实证据 · 查看说明'
  else detail = requirement.page === null ? '原型预览 · 查看来源' : `第 ${requirement.page} 页 · 原型定位演示`

  return <span><strong>{requirement.source}</strong><small>{detail}</small></span>
}

function CloseAction({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null
  return <div className="drawer-actions"><Button variant="secondary" onClick={onClose}>关闭</Button></div>
}

function ConfirmationNote({ note }: { note: string | null }) {
  if (!note) return null
  return <InlineMessage tone="info" title="人工备注">{note}</InlineMessage>
}

function RealEvidenceDetails({ requirement, onClose }: RequirementEvidenceDetailsProps) {
  const evidence = requirement.evidence
  if (!isRealEvidence(evidence)) return null
  const confidence = requirement.confidence === null
    ? '未提供'
    : `${formatConfidencePercent(requirement.confidence)}（仍需人工确认）`

  return (
    <div className="drawer-stack" data-evidence-kind={evidence.kind}>
      <section className="drawer-section drawer-meta-grid">
        <div><small>解析编号</small><strong>{requirement.code}</strong></div>
        <div><small>证据类型</small><strong>{evidence.label}</strong></div>
        <div><small>规则得分</small><strong>{confidence}</strong></div>
        <div><small>核验状态</small><strong>待人工核验</strong></div>
      </section>
      <section className="drawer-section">
        <header><div><h3>精确提取片段</h3><p>{evidence.anchorLabel}</p></div><Badge tone="amber">未验证</Badge></header>
        <div className="source-preview">
          <div className="source-page">{requirement.source}</div>
          <p className="source-highlight">{requirement.sourceQuote}</p>
        </div>
      </section>
      <section className="drawer-section">
        <header><div><h3>版本与锚点元数据</h3><p>以下字段由解析结果直接提供。</p></div></header>
        <div className="drawer-meta-grid">
          <div><small>来源修订</small><strong>修订 {evidence.sourceRevision}</strong></div>
          <div><small>解析器版本</small><strong>{evidence.parserVersion}</strong></div>
        </div>
        <ul>
          {evidence.anchorDetails.map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
        <div className="drawer-meta-grid">
          <div><small>片段 SHA-256</small><code>{evidence.quoteSha256}</code></div>
          <div><small>源文件 SHA-256</small><code>{evidence.sourceSha256}</code></div>
        </div>
      </section>
      <InlineMessage tone="warning" title="尚未通过原件重解析验证">
        此处展示解析器返回的精确片段与锚点元数据，不代表已经对原件重新解析核验；仍需人工确认后使用。
      </InlineMessage>
      <ConfirmationNote note={requirement.confirmationNote} />
      <CloseAction onClose={onClose} />
    </div>
  )
}

function FixtureEvidenceDetails({ requirement, onClose }: RequirementEvidenceDetailsProps) {
  const evidence = requirement.evidence
  if (evidence.kind !== 'development-fixture') return null
  return (
    <div className="drawer-stack" data-evidence-kind={evidence.kind}>
      <section className="drawer-section drawer-meta-grid">
        <div><small>解析编号</small><strong>{requirement.code}</strong></div>
        <div><small>输出类型</small><strong>{evidence.label}</strong></div>
        <div><small>规则得分</small><strong>未提供</strong></div>
        <div><small>证据状态</small><strong>非真实证据</strong></div>
      </section>
      <section className="drawer-section">
        <header><div><h3>历史开发夹具输出</h3><p>{evidence.anchorLabel}</p></div><Badge tone="amber">非真实证据</Badge></header>
        <div className="source-preview">
          <div className="source-page">{requirement.source}</div>
          <p className="source-highlight">{requirement.sourceQuote}</p>
        </div>
      </section>
      <InlineMessage tone="warning" title="这不是原文证据">
        <code>development-fixture</code> 没有读取上传文件正文，不能作为投标依据或真实原文引用。
      </InlineMessage>
      <ConfirmationNote note={requirement.confirmationNote} />
      <CloseAction onClose={onClose} />
    </div>
  )
}

function MockEvidenceDetails({ requirement, onClose, onEdit }: RequirementEvidenceDetailsProps) {
  const evidence = requirement.evidence
  if (evidence.kind !== 'mock-preview') return null
  return (
    <div className="drawer-stack" data-evidence-kind={evidence.kind}>
      <section className="drawer-section drawer-meta-grid">
        <div><small>解析编号</small><strong>{requirement.code}</strong></div>
        <div><small>条款类型</small><strong>{requirement.type}</strong></div>
        <div><small>置信度</small><strong>{requirement.confidence === null ? '未提供' : formatConfidencePercent(requirement.confidence)}</strong></div>
        <div><small>演示锚点</small><strong>{evidence.anchorLabel}</strong></div>
      </section>
      <section className="drawer-section">
        <header><div><h3>原型来源预览</h3><p>以下内容仅用于产品原型演示。</p></div><Badge tone="blue">Mock preview</Badge></header>
        <div className="source-preview">
          <div className="source-page">{requirement.page === null ? '页码未提供' : `第 ${requirement.page} 页`}</div>
          <p className="source-highlight">{requirement.sourceQuote || requirement.summary}</p>
        </div>
      </section>
      <InlineMessage tone="info" title="原型演示数据">该预览不代表 API 返回的真实解析证据。</InlineMessage>
      <div className="drawer-actions">
        {onClose ? <Button variant="secondary" onClick={onClose}>关闭</Button> : null}
        {onEdit ? <Button onClick={onEdit}>修正结果</Button> : null}
      </div>
    </div>
  )
}

export function RequirementEvidenceDetails(props: RequirementEvidenceDetailsProps) {
  const { kind } = props.requirement.evidence
  if (kind === 'development-fixture') return <FixtureEvidenceDetails {...props} />
  if (kind === 'mock-preview') return <MockEvidenceDetails {...props} />
  return <RealEvidenceDetails {...props} />
}
