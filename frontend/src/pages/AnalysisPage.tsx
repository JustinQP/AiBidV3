import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  FileSearch,
  Filter,
  LocateFixed,
  MapPin,
  Pencil,
  Search,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePrototype } from '../context/PrototypeContext'
import type { Requirement, RequirementType } from '../types'
import { Badge, Button, Drawer, InlineMessage, Modal, PageHeader, StatusBadge } from '../components/ui'

const REQUIREMENT_TYPES: Array<RequirementType | '全部'> = ['全部', '评分项', '技术要求', '资格项', '商务要求', '无效条款']
const LOW_CONFIDENCE_THRESHOLD = 85

interface EditDraft {
  summary: string
  type: RequirementType
  mandatory: boolean
}

const EMPTY_DRAFT: EditDraft = { summary: '', type: '技术要求', mandatory: false }

function typeTone(type: RequirementType) {
  if (type === '无效条款') return 'red' as const
  if (type === '评分项') return 'blue' as const
  if (type === '资格项') return 'teal' as const
  if (type === '商务要求') return 'amber' as const
  return 'neutral' as const
}

function confidenceClass(value: number) {
  if (value < LOW_CONFIDENCE_THRESHOLD) return 'confidence-low'
  if (value < 93) return 'confidence-medium'
  return 'confidence-high'
}

export function AnalysisPage() {
  const navigate = useNavigate()
  const { requirements, updateRequirement, notify } = usePrototype()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<RequirementType | '全部'>('全部')
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft>(EMPTY_DRAFT)

  const confirmedCount = requirements.filter((item) => item.confirmed).length
  const lowConfidenceCount = requirements.filter((item) => item.confidence < LOW_CONFIDENCE_THRESHOLD).length
  const mandatoryCount = requirements.filter((item) => item.mandatory).length
  const sourceRequirement = requirements.find((item) => item.id === sourceId)
  const editingRequirement = requirements.find((item) => item.id === editingId)

  const filteredRequirements = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return requirements.filter((item) => {
      const matchesType = typeFilter === '全部' || item.type === typeFilter
      const matchesConfidence = !lowConfidenceOnly || item.confidence < LOW_CONFIDENCE_THRESHOLD
      const matchesQuery = keyword.length === 0 || `${item.id} ${item.summary} ${item.source}`.toLowerCase().includes(keyword)
      return matchesType && matchesConfidence && matchesQuery
    })
  }, [lowConfidenceOnly, query, requirements, typeFilter])

  const confirmRequirement = (requirement: Requirement) => {
    updateRequirement(requirement.id, {
      confirmed: true,
      status: requirement.status === '未确认' ? '待响应' : requirement.status,
    })
    notify({ title: `${requirement.id} 已确认`, description: '该条目已同步进入要求响应矩阵。', tone: 'success' })
  }

  const confirmHighConfidence = () => {
    const pending = requirements.filter((item) => !item.confirmed && item.confidence >= LOW_CONFIDENCE_THRESHOLD)
    pending.forEach((item) => updateRequirement(item.id, { confirmed: true, status: item.status === '未确认' ? '待响应' : item.status }))
    notify({
      title: pending.length > 0 ? `已确认 ${pending.length} 条高置信度结果` : '高置信度结果均已确认',
      description: '低置信度与冲突项仍保留在人工确认队列。',
      tone: 'success',
    })
  }

  const openEditor = (requirement: Requirement) => {
    setEditingId(requirement.id)
    setEditDraft({ summary: requirement.summary, type: requirement.type, mandatory: requirement.mandatory })
  }

  const saveEdit = () => {
    if (!editingRequirement || editDraft.summary.trim().length === 0) return
    updateRequirement(editingRequirement.id, {
      summary: editDraft.summary.trim(),
      type: editDraft.type,
      mandatory: editDraft.mandatory,
      confirmed: true,
      status: editingRequirement.status === '未确认' ? '待响应' : editingRequirement.status,
    })
    setEditingId(null)
    notify({ title: '修正已保存并确认', description: `${editingRequirement.id} 已同步更新原文摘要和响应矩阵。`, tone: 'success' })
  }

  return (
    <div className="page page-stack analysis-page">
      <PageHeader
        eyebrow="项目 / 智能解析"
        title="智能解析与人工确认"
        description="逐项核对评分、资格、技术与无效条款；每条结果都可定位原文并保留人工修正记录。"
        actions={(
          <>
            <Button variant="secondary" icon={<Sparkles size={16} />} onClick={confirmHighConfidence}>确认高置信度项</Button>
            <Button icon={<ArrowRight size={16} />} onClick={() => navigate('/projects/demo/requirements')}>进入响应矩阵</Button>
          </>
        )}
      />

      <section className="metric-strip" aria-label="解析结果概览">
        <article className="metric-card"><span className="metric-icon metric-icon-blue"><FileSearch size={19} /></span><div><small>识别结果</small><strong>{requirements.length}</strong><p>来自 4 份招标材料</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-green"><CheckCircle2 size={19} /></span><div><small>人工已确认</small><strong>{confirmedCount}</strong><p>{Math.round((confirmedCount / requirements.length) * 100)}% 已进入响应矩阵</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-amber"><CircleAlert size={19} /></span><div><small>低置信度</small><strong>{lowConfidenceCount}</strong><p>需要人工查看原文</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-red"><ShieldAlert size={19} /></span><div><small>强制要求</small><strong>{mandatoryCount}</strong><p>含无效投标条款</p></div></article>
      </section>

      {lowConfidenceCount > 0 ? (
        <InlineMessage tone="warning" title={`${lowConfidenceCount} 条低置信度结果待确认`}>
          低置信度条目不会自动参与正式正文生成。请结合原文进行修正、确认或忽略。
        </InlineMessage>
      ) : null}

      <section className="panel">
        <header className="panel-header analysis-toolbar">
          <div><h2 className="panel-title">结构化解析结果</h2><p className="panel-subtitle">当前显示 {filteredRequirements.length} / {requirements.length} 条</p></div>
          <div className="filter-bar compact-filter-bar">
            <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、要求或来源" /></label>
            <button className={`filter-toggle ${lowConfidenceOnly ? 'active' : ''}`} onClick={() => setLowConfidenceOnly((current) => !current)}><Filter size={15} />低置信度<span>{lowConfidenceCount}</span></button>
          </div>
        </header>

        <div className="filter-tabs analysis-type-tabs" role="tablist" aria-label="解析结果类型">
          {REQUIREMENT_TYPES.map((type) => (
            <button key={type} className={typeFilter === type ? 'active' : ''} onClick={() => setTypeFilter(type)}>
              {type}<span>{type === '全部' ? requirements.length : requirements.filter((item) => item.type === type).length}</span>
            </button>
          ))}
        </div>

        <div className="table-wrap">
          <table className="data-table analysis-table">
            <thead><tr><th>编号 / 类型</th><th>识别内容</th><th>原文来源</th><th>置信度</th><th>确认状态</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {filteredRequirements.map((item) => (
                <tr key={item.id} className={`${!item.confirmed ? 'row-attention' : ''} ${item.confidence < LOW_CONFIDENCE_THRESHOLD ? 'low-confidence' : ''}`}>
                  <td><div className="table-primary"><strong>{item.id}</strong><div className="badge-row"><Badge tone={typeTone(item.type)}>{item.type}</Badge>{item.mandatory ? <Badge tone="red">强制</Badge> : null}{item.score ? <Badge tone="blue">{item.score} 分</Badge> : null}</div></div></td>
                  <td><div className="requirement-summary"><p>{item.summary}</p>{!item.confirmed ? <small><CircleAlert size={13} />建议人工核对后确认</small> : null}</div></td>
                  <td><button className="source-link" onClick={() => setSourceId(item.id)}><MapPin size={14} /><span><strong>{item.source}</strong><small>第 {item.page} 页 · 点击定位</small></span></button></td>
                  <td><div className="confidence-cell"><div><strong>{item.confidence}%</strong><small>{item.confidence < LOW_CONFIDENCE_THRESHOLD ? '低置信度' : item.confidence < 93 ? '建议复核' : '可信'}</small></div><div className="confidence-meter"><span className={`confidence-fill ${confidenceClass(item.confidence)}`} style={{ width: `${item.confidence}%`, backgroundColor: item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#dc3e36' : item.confidence < 93 ? '#d98a16' : '#22a35a' }} /></div></div></td>
                  <td>{item.confirmed ? <Badge tone="green" dot>已确认</Badge> : <StatusBadge status="待确认" />}</td>
                  <td><div className="row-actions align-right"><Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={() => openEditor(item)}>编辑</Button><Button variant={item.confirmed ? 'secondary' : 'teal'} size="sm" icon={<Check size={14} />} disabled={item.confirmed} onClick={() => confirmRequirement(item)}>{item.confirmed ? '已确认' : '确认'}</Button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRequirements.length === 0 ? <div className="empty-state"><Search size={24} /><strong>没有匹配的解析结果</strong><p>调整类型、置信度或搜索关键词。</p></div> : null}
        </div>
        <footer className="panel-footer"><span>人工确认结果将自动同步到响应矩阵，并保留操作记录。</span><Button variant="teal" icon={<ArrowRight size={15} />} onClick={() => navigate('/projects/demo/requirements')}>查看响应矩阵</Button></footer>
      </section>

      <Drawer
        open={Boolean(sourceRequirement)}
        title="原文定位"
        subtitle={sourceRequirement ? `${sourceRequirement.source} · 第 ${sourceRequirement.page} 页` : undefined}
        onClose={() => setSourceId(null)}
      >
        {sourceRequirement ? (
          <div className="drawer-stack">
            <section className="drawer-section drawer-meta-grid">
              <div><small>解析编号</small><strong>{sourceRequirement.id}</strong></div>
              <div><small>条款类型</small><Badge tone={typeTone(sourceRequirement.type)}>{sourceRequirement.type}</Badge></div>
              <div><small>置信度</small><strong>{sourceRequirement.confidence}%</strong></div>
              <div><small>定位锚点</small><strong>页 {sourceRequirement.page} / 段落 4</strong></div>
            </section>
            <section className="drawer-section">
              <header><div><h3>原文上下文</h3><p>高亮内容为当前解析结果对应的原文片段。</p></div><Badge tone="green" dot>坐标已校验</Badge></header>
              <div className="source-preview">
                <div className="source-page"><FileSearch size={16} />第 {sourceRequirement.page} 页</div>
                <p>投标人应根据本项目建设目标、服务边界及评分要求，提供完整、可执行并具备充分证明材料的响应方案。</p>
                <p className="source-highlight">{sourceRequirement.summary}</p>
                <p>相关证明材料须与投标人主体保持一致，并在投标文件对应章节中明确标注，便于评审专家核验。</p>
              </div>
            </section>
            <InlineMessage tone="info" title="来源可追溯">该原文锚点会随解析结果同步到响应矩阵、章节写作和审核记录。</InlineMessage>
            <div className="drawer-actions"><Button variant="secondary" icon={<LocateFixed size={15} />} onClick={() => notify({ title: '已定位至原文', description: `已打开第 ${sourceRequirement.page} 页对应段落。`, tone: 'info' })}>打开整页</Button><Button icon={<Pencil size={15} />} onClick={() => { openEditor(sourceRequirement); setSourceId(null) }}>修正结果</Button></div>
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={Boolean(editingRequirement)}
        title={`修正解析结果 ${editingRequirement?.id ?? ''}`}
        description="修改后将作为人工确认结果同步到响应矩阵，并保留当前原文锚点。"
        onClose={() => setEditingId(null)}
        width={640}
        footer={<><Button variant="secondary" onClick={() => setEditingId(null)}>取消</Button><Button icon={<Check size={15} />} disabled={editDraft.summary.trim().length === 0} onClick={saveEdit}>保存并确认</Button></>}
      >
        <div className="form-grid two">
          <div className="form-field form-field-full"><label htmlFor="analysis-summary">要求内容</label><textarea id="analysis-summary" rows={5} value={editDraft.summary} onChange={(event) => setEditDraft((current) => ({ ...current, summary: event.target.value }))} /><small>{editDraft.summary.length} 字 · 请保持原意，不要补充原文不存在的事实。</small></div>
          <div className="form-field"><label htmlFor="analysis-type">条款类型</label><select id="analysis-type" value={editDraft.type} onChange={(event) => setEditDraft((current) => ({ ...current, type: event.target.value as RequirementType }))}>{REQUIREMENT_TYPES.filter((type): type is RequirementType => type !== '全部').map((type) => <option key={type}>{type}</option>)}</select></div>
          <div className="form-field checkbox-field"><label htmlFor="analysis-mandatory">约束级别</label><span className="checkbox-line"><input id="analysis-mandatory" type="checkbox" checked={editDraft.mandatory} onChange={(event) => setEditDraft((current) => ({ ...current, mandatory: event.target.checked }))} />标记为强制要求</span></div>
        </div>
      </Modal>
    </div>
  )
}

export default AnalysisPage
