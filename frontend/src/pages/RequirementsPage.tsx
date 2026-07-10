import {
  ArrowRight,
  BookOpen,
  CheckSquare2,
  CircleAlert,
  Filter,
  Link2,
  Search,
  ShieldAlert,
  Sparkles,
  Unlink,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePrototype } from '../context/PrototypeContext'
import type { RequirementStatus, RequirementType, RiskLevel } from '../types'
import { Badge, Button, InlineMessage, Modal, PageHeader, Select, StatusBadge } from '../components/ui'

const TYPE_OPTIONS: Array<RequirementType | '全部类型'> = ['全部类型', '评分项', '技术要求', '资格项', '商务要求', '无效条款']
const RISK_OPTIONS: Array<RiskLevel | '全部风险'> = ['全部风险', '阻断', '高', '中', '低']
const STATUS_OPTIONS: RequirementStatus[] = ['未确认', '待响应', '编写中', '已响应', '已确认']
const OWNERS = ['李明', '王芳', '陈晨', '赵敏', '周宁', '张伟']

function typeTone(type: RequirementType) {
  if (type === '无效条款') return 'red' as const
  if (type === '评分项') return 'blue' as const
  if (type === '资格项') return 'teal' as const
  if (type === '商务要求') return 'amber' as const
  return 'neutral' as const
}

function riskTone(risk: RiskLevel) {
  if (risk === '阻断' || risk === '高') return 'red' as const
  if (risk === '中') return 'amber' as const
  return 'green' as const
}

export function RequirementsPage() {
  const navigate = useNavigate()
  const { requirements, outline, assignRequirements, updateRequirement, notify } = usePrototype()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<RequirementType | '全部类型'>('全部类型')
  const [riskFilter, setRiskFilter] = useState<RiskLevel | '全部风险'>('全部风险')
  const [mandatoryOnly, setMandatoryOnly] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [assignIds, setAssignIds] = useState<string[]>([])
  const [assignmentOwner, setAssignmentOwner] = useState('李明')
  const [assignmentSection, setAssignmentSection] = useState('')

  const sectionOptions = useMemo(() => outline
    .filter((section) => section.level === 2)
    .map((section) => `${section.number} ${section.title}`), [outline])

  const filteredRequirements = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return requirements.filter((item) => {
      const matchesType = typeFilter === '全部类型' || item.type === typeFilter
      const matchesRisk = riskFilter === '全部风险' || item.risk === riskFilter
      const matchesMandatory = !mandatoryOnly || item.mandatory
      const matchesQuery = keyword.length === 0 || `${item.id} ${item.summary} ${item.owner} ${item.section} ${item.source}`.toLowerCase().includes(keyword)
      return matchesType && matchesRisk && matchesMandatory && matchesQuery
    })
  }, [mandatoryOnly, query, requirements, riskFilter, typeFilter])

  const confirmedRequirements = requirements.filter((item) => item.confirmed)
  const mandatoryCount = requirements.filter((item) => item.mandatory).length
  const unmappedCount = confirmedRequirements.filter((item) => item.section === '未映射').length
  const unmappedMandatoryCount = confirmedRequirements.filter((item) => item.mandatory && item.section === '未映射').length
  const highRiskCount = requirements.filter((item) => item.risk === '阻断' || item.risk === '高').length
  const coverage = confirmedRequirements.length === 0 ? 0 : Math.round(((confirmedRequirements.length - unmappedCount) / confirmedRequirements.length) * 100)
  const selectedVisibleCount = filteredRequirements.filter((item) => selectedIds.has(item.id)).length
  const allVisibleSelected = filteredRequirements.length > 0 && selectedVisibleCount === filteredRequirements.length

  const toggleSelection = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) filteredRequirements.forEach((item) => next.delete(item.id))
      else filteredRequirements.forEach((item) => next.add(item.id))
      return next
    })
  }

  const openAssignment = (ids: string[]) => {
    if (ids.length === 0) return
    const first = requirements.find((item) => item.id === ids[0])
    setAssignIds(ids)
    setAssignmentOwner(first?.owner && first.owner !== '未分配' ? first.owner : '李明')
    setAssignmentSection(first?.section && first.section !== '未映射' ? first.section : (sectionOptions[0] ?? ''))
  }

  const applyAssignment = () => {
    if (assignIds.length === 0 || assignmentSection.length === 0) return
    assignRequirements(assignIds, assignmentOwner, assignmentSection)
    setSelectedIds((current) => {
      const next = new Set(current)
      assignIds.forEach((id) => next.delete(id))
      return next
    })
    notify({ title: `已更新 ${assignIds.length} 条要求`, description: `负责人：${assignmentOwner} · 映射章节：${assignmentSection}`, tone: 'success' })
    setAssignIds([])
  }

  const clearFilters = () => {
    setQuery('')
    setTypeFilter('全部类型')
    setRiskFilter('全部风险')
    setMandatoryOnly(false)
  }

  return (
    <div className="page page-stack requirements-page">
      <PageHeader
        eyebrow="项目 / 响应矩阵"
        title="要求响应矩阵"
        description="把已确认的招标要求转化为可跟踪任务，明确责任人、响应章节、风险与完成状态。"
        actions={(
          <>
            <Button variant="secondary" icon={<Sparkles size={16} />} onClick={() => notify({ title: '智能建议已更新', description: '已根据要求语义与目录标题刷新章节映射建议。', tone: 'success' })}>智能映射</Button>
            <Button icon={<ArrowRight size={16} />} onClick={() => navigate('/projects/demo/outline')}>进入目录规划</Button>
          </>
        )}
      />

      <section className="metric-strip" aria-label="响应矩阵概览">
        <article className="metric-card"><span className="metric-icon metric-icon-blue"><CheckSquare2 size={19} /></span><div><small>要求总数</small><strong>{requirements.length}</strong><p>{confirmedRequirements.length} 条已人工确认</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-red"><ShieldAlert size={19} /></span><div><small>强制要求</small><strong>{mandatoryCount}</strong><p>正式导出前必须响应</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-green"><Link2 size={19} /></span><div><small>章节映射率</small><strong>{coverage}%</strong><p>{unmappedCount} 条尚未映射</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-amber"><CircleAlert size={19} /></span><div><small>高风险 / 阻断</small><strong>{highRiskCount}</strong><p>优先安排负责人处理</p></div></article>
      </section>

      {unmappedMandatoryCount > 0 ? (
        <InlineMessage tone="warning" title={`${unmappedMandatoryCount} 条强制要求尚未映射章节`}>
          所有强制要求完成章节映射前，目录规划门禁不会通过。可选择条目后批量分配。
        </InlineMessage>
      ) : null}

      <section className="panel">
        <header className="panel-header requirements-toolbar">
          <div><h2 className="panel-title">矩阵明细</h2><p className="panel-subtitle">显示 {filteredRequirements.length} / {requirements.length} 条要求</p></div>
          <div className="filter-bar compact-filter-bar">
            <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、要求、负责人或章节" /></label>
            <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as RequirementType | '全部类型')}>{TYPE_OPTIONS.map((item) => <option key={item}>{item}</option>)}</Select>
            <Select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as RiskLevel | '全部风险')}>{RISK_OPTIONS.map((item) => <option key={item}>{item}</option>)}</Select>
            <button className={`filter-toggle ${mandatoryOnly ? 'active' : ''}`} onClick={() => setMandatoryOnly((current) => !current)}><Filter size={15} />仅看强制</button>
            {(query || typeFilter !== '全部类型' || riskFilter !== '全部风险' || mandatoryOnly) ? <button className="text-button" onClick={clearFilters}>清除筛选</button> : null}
          </div>
        </header>

        {selectedIds.size > 0 ? (
          <div className="bulk-bar">
            <div className="selection-count"><CheckSquare2 size={17} /><strong>已选择 {selectedIds.size} 条要求</strong><span>可同时分配负责人和响应章节</span></div>
            <div><button className="text-button" onClick={() => setSelectedIds(new Set())}>取消选择</button><Button size="sm" icon={<Users size={15} />} onClick={() => openAssignment([...selectedIds])}>批量分配与映射</Button></div>
          </div>
        ) : null}

        <div className="table-wrap requirements-table-wrap">
          <table className="data-table requirements-table">
            <thead><tr><th className="checkbox-cell"><input type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} aria-label="选择当前结果" /></th><th>要求编号 / 类型</th><th>要求摘要</th><th>来源</th><th>责任人</th><th>响应章节</th><th>风险</th><th>状态</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {filteredRequirements.map((item) => (
                <tr key={item.id} className={`${selectedIds.has(item.id) ? 'row-selected' : ''} ${item.section === '未映射' ? 'row-unmapped' : ''}`}>
                  <td className="checkbox-cell"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelection(item.id)} aria-label={`选择 ${item.id}`} /></td>
                  <td><div className="table-primary"><strong>{item.id}</strong><div className="badge-row"><Badge tone={typeTone(item.type)}>{item.type}</Badge>{item.mandatory ? <Badge tone="red">强制</Badge> : null}{item.score ? <Badge tone="blue">{item.score} 分</Badge> : null}</div></div></td>
                  <td><div className="requirement-summary"><p>{item.summary}</p>{!item.confirmed ? <small><CircleAlert size={13} />解析结果尚未人工确认</small> : null}</div></td>
                  <td><div className="table-secondary"><strong>{item.source}</strong><small>第 {item.page} 页</small></div></td>
                  <td><div className={`owner-cell ${item.owner === '未分配' ? 'is-empty' : ''}`}>{item.owner === '未分配' ? <span className="avatar avatar-empty">?</span> : <span className="avatar avatar-soft">{item.owner.slice(0, 1)}</span>}<span>{item.owner}</span></div></td>
                  <td>{item.section === '未映射' ? <button className="mapping-empty" onClick={() => openAssignment([item.id])}><Unlink size={14} />未映射</button> : <button className="mapping-link" onClick={() => openAssignment([item.id])}><BookOpen size={14} />{item.section}</button>}</td>
                  <td><Badge tone={riskTone(item.risk)} dot>{item.risk}</Badge></td>
                  <td><Select value={item.status} onChange={(event) => updateRequirement(item.id, { status: event.target.value as RequirementStatus })}>{STATUS_OPTIONS.map((status) => <option key={status}>{status}</option>)}</Select></td>
                  <td><div className="row-actions align-right"><Button variant="ghost" size="sm" icon={<Link2 size={14} />} onClick={() => openAssignment([item.id])}>分配</Button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRequirements.length === 0 ? <div className="empty-state"><Search size={24} /><strong>没有匹配的要求</strong><p>调整筛选条件或清除搜索关键词。</p><Button variant="secondary" size="sm" onClick={clearFilters}>清除筛选</Button></div> : null}
        </div>
        <footer className="panel-footer"><span>章节映射率 {coverage}% · {unmappedCount} 条待映射 · {selectedIds.size} 条已选择</span><Button variant="teal" icon={<ArrowRight size={15} />} onClick={() => navigate('/projects/demo/outline')}>进入目录规划</Button></footer>
      </section>

      <Modal
        open={assignIds.length > 0}
        title={assignIds.length === 1 ? `分配要求 ${assignIds[0]}` : `批量分配 ${assignIds.length} 条要求`}
        description="负责人将收到章节任务；章节映射会同步到目录覆盖率和写作工作台。"
        onClose={() => setAssignIds([])}
        width={580}
        footer={<><Button variant="secondary" onClick={() => setAssignIds([])}>取消</Button><Button icon={<Link2 size={15} />} disabled={assignmentOwner.length === 0 || assignmentSection.length === 0} onClick={applyAssignment}>确认分配</Button></>}
      >
        <div className="form-grid two">
          <div className="form-field"><label htmlFor="assignment-owner">负责人</label><select id="assignment-owner" value={assignmentOwner} onChange={(event) => setAssignmentOwner(event.target.value)}>{OWNERS.map((owner) => <option key={owner}>{owner}</option>)}</select><small>负责人将在工作台收到处理任务。</small></div>
          <div className="form-field"><label htmlFor="assignment-section">目标章节</label><select id="assignment-section" value={assignmentSection} onChange={(event) => setAssignmentSection(event.target.value)}>{sectionOptions.map((section) => <option key={section}>{section}</option>)}</select><small>映射后会更新章节要求覆盖数量。</small></div>
          <section className="assignment-preview form-field-full">
            <header><strong>本次变更</strong><Badge tone="blue">{assignIds.length} 条</Badge></header>
            <div><span><Users size={15} />负责人</span><strong>{assignmentOwner}</strong></div>
            <div><span><BookOpen size={15} />响应章节</span><strong>{assignmentSection || '请选择章节'}</strong></div>
            <div><span><StatusBadge status="编写中" /></span><small>分配后要求状态将更新为“编写中”</small></div>
          </section>
        </div>
      </Modal>
    </div>
  )
}

export default RequirementsPage
