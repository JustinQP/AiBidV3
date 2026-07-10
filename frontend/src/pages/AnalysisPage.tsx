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
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RequirementDisplayType, RequirementListItem } from '../api/adapters'
import type { ApiError } from '../api/client'
import { useProjectFiles, useProjectRequirements } from '../api/hooks'
import { projectRoute, useCurrentProjectId } from '../api/routing'
import { Badge, Button, Drawer, InlineMessage, LoadingBlock, Modal, PageHeader, StatusBadge } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import type { RequirementType } from '../types'

const MOCK_REQUIREMENT_TYPES: Array<RequirementDisplayType | '全部'> = ['全部', '评分项', '技术要求', '资格项', '商务要求', '无效条款']
const API_REQUIREMENT_TYPES: Array<RequirementDisplayType | '全部'> = ['全部', '技术要求', '商务要求', '合规要求']
const LOW_CONFIDENCE_THRESHOLD = 85

interface EditDraft {
  summary: string
  type: RequirementType
  mandatory: boolean
}

interface ConfirmationDraft {
  requirementId: string
  status: 'confirmed' | 'rejected'
  note: string
}

const EMPTY_DRAFT: EditDraft = { summary: '', type: '技术要求', mandatory: false }

function typeTone(type: RequirementDisplayType) {
  if (type === '无效条款') return 'red' as const
  if (type === '评分项') return 'blue' as const
  if (type === '资格项' || type === '合规要求') return 'teal' as const
  if (type === '商务要求') return 'amber' as const
  return 'neutral' as const
}

function confidenceClass(value: number) {
  if (value < LOW_CONFIDENCE_THRESHOLD) return 'confidence-low'
  if (value < 93) return 'confidence-medium'
  return 'confidence-high'
}

function apiErrorDescription(error: ApiError) {
  const details = [error.problem.detail || error.message]
  if (error.problem.code) details.push(`错误码：${error.problem.code}`)
  if (error.problem.requestId) details.push(`请求 ID：${error.problem.requestId}`)
  return details.join(' · ')
}

function confirmationBadge(requirement: RequirementListItem) {
  if (requirement.confirmationStatus === 'confirmed') return <Badge tone="green" dot>已确认</Badge>
  if (requirement.confirmationStatus === 'rejected') return <Badge tone="red" dot>已驳回</Badge>
  return <StatusBadge status="待确认" />
}

export function AnalysisPage() {
  const navigate = useNavigate()
  const projectId = useCurrentProjectId()
  const { updateRequirement, notify } = usePrototype()
  const {
    source,
    requirements,
    loading,
    confirmingIds,
    error,
    refresh: refreshRequirements,
    confirmRequirement: persistConfirmation,
  } = useProjectRequirements(projectId)
  const fileResource = useProjectFiles(projectId)
  const isApi = source === 'api'
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<RequirementDisplayType | '全部'>('全部')
  const [lowConfidenceOnly, setLowConfidenceOnly] = useState(false)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<EditDraft>(EMPTY_DRAFT)
  const [confirmationDraft, setConfirmationDraft] = useState<ConfirmationDraft | null>(null)
  const wasPollingRef = useRef(false)

  const requirementTypes = isApi ? API_REQUIREMENT_TYPES : MOCK_REQUIREMENT_TYPES
  const confirmedCount = requirements.filter((item) => item.confirmationStatus === 'confirmed').length
  const rejectedCount = requirements.filter((item) => item.confirmationStatus === 'rejected').length
  const pendingCount = requirements.filter((item) => item.confirmationStatus === 'pending').length
  const lowConfidenceCount = requirements.filter((item) => item.confidence !== null && item.confidence < LOW_CONFIDENCE_THRESHOLD).length
  const mandatoryCount = requirements.filter((item) => item.mandatory).length
  const sourceCount = new Set(requirements.map((item) => item.source)).size
  const sourceRequirement = requirements.find((item) => item.id === sourceId)
  const editingRequirement = requirements.find((item) => item.id === editingId)
  const confirmationRequirement = requirements.find((item) => item.id === confirmationDraft?.requirementId)
  const filesRoute = projectId ? projectRoute(projectId, 'files') : '/projects'
  const requirementsRoute = projectId ? projectRoute(projectId, 'requirements') : '/projects'

  useEffect(() => {
    if (!requirementTypes.includes(typeFilter)) setTypeFilter('全部')
  }, [requirementTypes, typeFilter])

  useEffect(() => {
    if (!isApi) return
    if (wasPollingRef.current && !fileResource.polling) refreshRequirements()
    wasPollingRef.current = fileResource.polling
  }, [fileResource.polling, isApi, refreshRequirements])

  const filteredRequirements = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return requirements.filter((item) => {
      const matchesType = typeFilter === '全部' || item.type === typeFilter
      const matchesConfidence = isApi || !lowConfidenceOnly || (item.confidence !== null && item.confidence < LOW_CONFIDENCE_THRESHOLD)
      const matchesQuery = keyword.length === 0 || `${item.code} ${item.title} ${item.summary} ${item.source}`.toLowerCase().includes(keyword)
      return matchesType && matchesConfidence && matchesQuery
    })
  }, [isApi, lowConfidenceOnly, query, requirements, typeFilter])

  const confirmMockRequirement = (requirement: RequirementListItem) => {
    updateRequirement(requirement.id, {
      confirmed: true,
      status: requirement.status === '未确认' ? '待响应' : requirement.status,
    })
    notify({ title: `${requirement.code} 已确认`, description: '该条目已同步进入要求响应矩阵。', tone: 'success' })
  }

  const confirmHighConfidence = () => {
    const pending = requirements.filter((item) => !item.confirmed && item.confidence !== null && item.confidence >= LOW_CONFIDENCE_THRESHOLD)
    pending.forEach((item) => updateRequirement(item.id, { confirmed: true, status: item.status === '未确认' ? '待响应' : item.status }))
    notify({
      title: pending.length > 0 ? `已确认 ${pending.length} 条高置信度结果` : '高置信度结果均已确认',
      description: '低置信度与冲突项仍保留在人工确认队列。',
      tone: 'success',
    })
  }

  const openEditor = (requirement: RequirementListItem) => {
    if (isApi || requirement.type === '合规要求') return
    setEditingId(requirement.id)
    setEditDraft({ summary: requirement.summary, type: requirement.type, mandatory: requirement.mandatory })
  }

  const saveEdit = () => {
    if (!editingRequirement || editDraft.summary.trim().length === 0 || isApi) return
    updateRequirement(editingRequirement.id, {
      summary: editDraft.summary.trim(),
      type: editDraft.type,
      mandatory: editDraft.mandatory,
      confirmed: true,
      status: editingRequirement.status === '未确认' ? '待响应' : editingRequirement.status,
    })
    setEditingId(null)
    notify({ title: '修正已保存并确认', description: `${editingRequirement.code} 已同步更新原文摘要和响应矩阵。`, tone: 'success' })
  }

  const openConfirmation = (requirement: RequirementListItem, status: ConfirmationDraft['status']) => {
    setConfirmationDraft({ requirementId: requirement.id, status, note: requirement.confirmationNote ?? '' })
  }

  const saveConfirmation = async () => {
    if (!confirmationDraft || !confirmationRequirement || confirmationDraft.note.length > 1000) return
    const label = confirmationDraft.status === 'confirmed' ? '确认' : '驳回'
    try {
      await persistConfirmation(confirmationDraft.requirementId, {
        status: confirmationDraft.status,
        note: confirmationDraft.note.trim() || undefined,
      })
      setConfirmationDraft(null)
      notify({
        title: `${confirmationRequirement.code} 已${label}`,
        description: '人工处理状态已保存到第一阶段 API。',
        tone: confirmationDraft.status === 'confirmed' ? 'success' : 'info',
      })
    } catch (confirmationError) {
      notify({
        title: `${label}失败`,
        description: confirmationError instanceof Error ? confirmationError.message : '请稍后重试。',
        tone: 'error',
      })
    }
  }

  const refreshAll = () => {
    refreshRequirements()
    fileResource.refresh()
  }

  let emptyTitle = '尚无解析结果'
  let emptyDescription = '上传招标材料后开始解析。'
  let emptyActionLabel = '前往招标文件'
  if (isApi) {
    if (fileResource.loading) {
      emptyTitle = '正在检查解析任务'
      emptyDescription = '文件与任务状态加载完成后会自动更新。'
      emptyActionLabel = '刷新状态'
    } else if (fileResource.polling) {
      emptyTitle = '解析任务仍在运行'
      emptyDescription = '页面正在轮询真实任务进度，完成后会自动读取提取要求。'
      emptyActionLabel = '查看任务'
    } else if (fileResource.files.length === 0) {
      emptyTitle = '尚无可解析文件'
      emptyDescription = '请先上传 PDF、DOC、DOCX 或 TXT 文件。'
    } else if (fileResource.files.some((file) => file.status === 'error')) {
      emptyTitle = '解析任务需要处理'
      emptyDescription = '至少一个解析任务失败，请在招标文件页查看错误并重试。'
    } else {
      emptyTitle = '未提取到要求'
      emptyDescription = '当前任务已结束，但没有返回结构化要求；可刷新或检查解析器输出。'
      emptyActionLabel = '重新加载'
    }
  }

  return (
    <div className="page page-stack analysis-page">
      <PageHeader
        eyebrow="项目 / 智能解析"
        title="智能解析与人工确认"
        description={isApi
          ? '查看开发解析适配器返回的结构化要求，并将逐条确认或驳回结果保存到 API。'
          : '逐项核对评分、资格、技术与无效条款；每条结果都可定位原文并保留人工修正记录。'}
        actions={(
          <>
            {isApi ? <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={refreshAll} disabled={loading}>刷新结果</Button> : <Button variant="secondary" icon={<Sparkles size={16} />} onClick={confirmHighConfidence}>确认高置信度项</Button>}
            <Button
              icon={<ArrowRight size={16} />}
              disabled={isApi}
              title={isApi ? '响应矩阵尚未接入真实数据' : undefined}
              onClick={() => !isApi && navigate(requirementsRoute)}
            >
              {isApi ? '响应矩阵未接入' : '进入响应矩阵'}
            </Button>
          </>
        )}
      />

      <section className="metric-strip" aria-label="解析结果概览">
        <article className="metric-card"><span className="metric-icon metric-icon-blue"><FileSearch size={19} /></span><div><small>识别结果</small><strong>{loading ? '—' : requirements.length}</strong><p>{isApi ? `来自 ${sourceCount} 份文件` : '来自 4 份招标材料'}</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-green"><CheckCircle2 size={19} /></span><div><small>人工已确认</small><strong>{loading ? '—' : confirmedCount}</strong><p>{requirements.length > 0 ? `${Math.round((confirmedCount / requirements.length) * 100)}% ${isApi ? '已确认' : '已进入响应矩阵'}` : '暂无可确认条目'}</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-amber"><CircleAlert size={19} /></span><div><small>{isApi ? '待人工处理' : '低置信度'}</small><strong>{loading ? '—' : isApi ? pendingCount : lowConfidenceCount}</strong><p>{isApi ? `${rejectedCount} 条已驳回` : '需要人工查看原文'}</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-red"><ShieldAlert size={19} /></span><div><small>强制要求</small><strong>{loading ? '—' : mandatoryCount}</strong><p>{isApi ? '由强制优先级映射' : '含无效投标条款'}</p></div></article>
      </section>

      {isApi ? (
        <InlineMessage tone="warning" title="当前结果来自开发解析适配器">
          <code>development-fixture</code> 不读取真实文件正文，也不提供置信度或真实页码；结果仅用于验证接口闭环。
        </InlineMessage>
      ) : null}

      {!isApi && lowConfidenceCount > 0 ? (
        <InlineMessage tone="warning" title={`${lowConfidenceCount} 条低置信度结果待确认`}>
          低置信度条目不会自动参与正式正文生成。请结合原文进行修正、确认或忽略。
        </InlineMessage>
      ) : null}

      {error && !loading ? (
        <InlineMessage tone="error" title="解析结果请求未完成">
          {apiErrorDescription(error)}。可点击“刷新结果”重试；后台状态刷新失败不会伪造成功结果。
        </InlineMessage>
      ) : null}

      {isApi && fileResource.error && !fileResource.loading ? (
        <InlineMessage tone="warning" title="任务状态刷新中断">
          {apiErrorDescription(fileResource.error)}。解析结果仍可查看，刷新后将继续同步任务状态。
        </InlineMessage>
      ) : null}

      <section className="panel">
        <header className="panel-header analysis-toolbar">
          <div><h2 className="panel-title">结构化解析结果</h2><p className="panel-subtitle">{loading ? '正在加载…' : `当前显示 ${filteredRequirements.length} / ${requirements.length} 条`}</p></div>
          <div className="filter-bar compact-filter-bar">
            <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号、要求或来源" /></label>
            {!isApi ? <button className={`filter-toggle ${lowConfidenceOnly ? 'active' : ''}`} onClick={() => setLowConfidenceOnly((current) => !current)}><Filter size={15} />低置信度<span>{lowConfidenceCount}</span></button> : null}
          </div>
        </header>

        <div className="filter-tabs analysis-type-tabs" role="tablist" aria-label="解析结果类型">
          {requirementTypes.map((type) => (
            <button key={type} className={typeFilter === type ? 'active' : ''} onClick={() => setTypeFilter(type)}>
              {type}<span>{type === '全部' ? requirements.length : requirements.filter((item) => item.type === type).length}</span>
            </button>
          ))}
        </div>

        {loading ? <LoadingBlock label="正在读取结构化要求…" /> : null}
        {!loading && error && requirements.length === 0 ? (
          <div className="empty-state"><XCircle size={24} /><strong>无法加载解析结果</strong><p>{apiErrorDescription(error)}</p><Button variant="secondary" icon={<RefreshCw size={15} />} onClick={refreshAll}>重新加载</Button></div>
        ) : null}
        {!loading && !error && requirements.length === 0 ? (
          <div className="empty-state"><FileSearch size={24} /><strong>{emptyTitle}</strong><p>{emptyDescription}</p><Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => emptyActionLabel === '重新加载' || emptyActionLabel === '刷新状态' ? refreshAll() : navigate(filesRoute)}>{emptyActionLabel}</Button></div>
        ) : null}
        {!loading && requirements.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table analysis-table">
              <thead><tr><th>编号 / 类型</th><th>识别内容</th><th>{isApi ? '来源信息' : '原文来源'}</th><th>置信度</th><th>确认状态</th><th className="align-right">操作</th></tr></thead>
              <tbody>
                {filteredRequirements.map((item) => {
                  const lowConfidence = item.confidence !== null && item.confidence < LOW_CONFIDENCE_THRESHOLD
                  const confirming = confirmingIds.has(item.id)
                  return (
                    <tr key={item.id} className={`${item.confirmationStatus === 'pending' ? 'row-attention' : ''} ${lowConfidence ? 'low-confidence' : ''}`}>
                      <td><div className="table-primary"><strong>{item.code}</strong><div className="badge-row"><Badge tone={typeTone(item.type)}>{item.type}</Badge>{item.mandatory ? <Badge tone="red">强制</Badge> : null}{item.score !== null ? <Badge tone="blue">{item.score} 分</Badge> : null}</div></div></td>
                      <td><div className="requirement-summary">{item.title !== item.summary ? <strong>{item.title}</strong> : null}<p>{item.summary}</p>{item.confirmationStatus === 'pending' ? <small><CircleAlert size={13} />{isApi ? '建议人工核对后确认或驳回' : '建议人工核对后确认'}</small> : null}</div></td>
                      <td><button className="source-link" onClick={() => setSourceId(item.id)}><MapPin size={14} /><span><strong>{item.source}</strong><small>{item.page === null ? '页码未提供 · 查看来源信息' : `第 ${item.page} 页 · 点击定位`}</small></span></button></td>
                      <td>
                        {item.confidence === null ? (
                          <div className="confidence-cell"><div><strong>未提供</strong><small>开发适配器未输出</small></div></div>
                        ) : (
                          <div className="confidence-cell"><div><strong>{item.confidence}%</strong><small>{item.confidence < LOW_CONFIDENCE_THRESHOLD ? '低置信度' : item.confidence < 93 ? '建议复核' : '可信'}</small></div><div className="confidence-meter"><span className={`confidence-fill ${confidenceClass(item.confidence)}`} style={{ width: `${item.confidence}%`, backgroundColor: item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#dc3e36' : item.confidence < 93 ? '#d98a16' : '#22a35a' }} /></div></div>
                        )}
                      </td>
                      <td>{confirmationBadge(item)}</td>
                      <td>
                        {isApi ? (
                          <div className="row-actions align-right">
                            <Button variant="ghost" size="sm" icon={<XCircle size={14} />} disabled={confirming || item.confirmationStatus === 'rejected'} onClick={() => openConfirmation(item, 'rejected')}>{confirming ? '保存中' : '驳回'}</Button>
                            <Button variant={item.confirmationStatus === 'confirmed' ? 'secondary' : 'teal'} size="sm" icon={<Check size={14} />} disabled={confirming || item.confirmationStatus === 'confirmed'} onClick={() => openConfirmation(item, 'confirmed')}>{confirming ? '保存中' : item.confirmationStatus === 'confirmed' ? '已确认' : '确认'}</Button>
                          </div>
                        ) : (
                          <div className="row-actions align-right"><Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={() => openEditor(item)}>编辑</Button><Button variant={item.confirmed ? 'secondary' : 'teal'} size="sm" icon={<Check size={14} />} disabled={item.confirmed} onClick={() => confirmMockRequirement(item)}>{item.confirmed ? '已确认' : '确认'}</Button></div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filteredRequirements.length === 0 ? <div className="empty-state"><Search size={24} /><strong>没有匹配的解析结果</strong><p>{isApi ? '调整类型或搜索关键词。' : '调整类型、置信度或搜索关键词。'}</p></div> : null}
          </div>
        ) : null}
        <footer className="panel-footer"><span>{isApi ? '第一阶段仅保存确认状态；响应矩阵尚未接入真实数据。' : '人工确认结果将自动同步到响应矩阵，并保留操作记录。'}</span><Button variant="teal" icon={<ArrowRight size={15} />} disabled={isApi} title={isApi ? '响应矩阵尚未接入真实数据' : undefined} onClick={() => !isApi && navigate(requirementsRoute)}>{isApi ? '响应矩阵未接入' : '查看响应矩阵'}</Button></footer>
      </section>

      <Drawer
        open={Boolean(sourceRequirement)}
        title={isApi ? '来源信息（开发夹具）' : '原文定位'}
        subtitle={sourceRequirement ? isApi ? sourceRequirement.source : `${sourceRequirement.source} · 第 ${sourceRequirement.page} 页` : undefined}
        onClose={() => setSourceId(null)}
      >
        {sourceRequirement ? isApi ? (
          <div className="drawer-stack">
            <section className="drawer-section drawer-meta-grid">
              <div><small>解析编号</small><strong>{sourceRequirement.code}</strong></div>
              <div><small>条款类型</small><Badge tone={typeTone(sourceRequirement.type)}>{sourceRequirement.type}</Badge></div>
              <div><small>置信度</small><strong>未提供</strong></div>
              <div><small>定位状态</small><strong>非真实定位</strong></div>
            </section>
            <section className="drawer-section">
              <header><div><h3>开发解析输出</h3><p>{sourceRequirement.sectionPath.length > 0 ? sourceRequirement.sectionPath.join(' / ') : '未提供章节路径'}</p></div><Badge tone="amber">开发夹具</Badge></header>
              <div className="source-preview">
                <div className="source-page"><FileSearch size={16} />页码未提供</div>
                <p className="source-highlight">{sourceRequirement.sourceQuote}</p>
              </div>
            </section>
            <InlineMessage tone="warning" title="这不是原文定位"><code>development-fixture</code> 不读取上传文件，不能作为投标依据或已核验引用。</InlineMessage>
            {sourceRequirement.confirmationNote ? <InlineMessage tone="info" title="人工备注">{sourceRequirement.confirmationNote}</InlineMessage> : null}
            <div className="drawer-actions"><Button variant="secondary" onClick={() => setSourceId(null)}>关闭</Button></div>
          </div>
        ) : (
          <div className="drawer-stack">
            <section className="drawer-section drawer-meta-grid">
              <div><small>解析编号</small><strong>{sourceRequirement.code}</strong></div>
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
        open={!isApi && Boolean(editingRequirement)}
        title={`修正解析结果 ${editingRequirement?.code ?? ''}`}
        description="修改后将作为人工确认结果同步到响应矩阵，并保留当前原文锚点。"
        onClose={() => setEditingId(null)}
        width={640}
        footer={<><Button variant="secondary" onClick={() => setEditingId(null)}>取消</Button><Button icon={<Check size={15} />} disabled={editDraft.summary.trim().length === 0} onClick={saveEdit}>保存并确认</Button></>}
      >
        <div className="form-grid two">
          <div className="form-field form-field-full"><label htmlFor="analysis-summary">要求内容</label><textarea id="analysis-summary" rows={5} value={editDraft.summary} onChange={(event) => setEditDraft((current) => ({ ...current, summary: event.target.value }))} /><small>{editDraft.summary.length} 字 · 请保持原意，不要补充原文不存在的事实。</small></div>
          <div className="form-field"><label htmlFor="analysis-type">条款类型</label><select id="analysis-type" value={editDraft.type} onChange={(event) => setEditDraft((current) => ({ ...current, type: event.target.value as RequirementType }))}>{MOCK_REQUIREMENT_TYPES.filter((type): type is RequirementType => type !== '全部' && type !== '合规要求').map((type) => <option key={type}>{type}</option>)}</select></div>
          <div className="form-field checkbox-field"><label htmlFor="analysis-mandatory">约束级别</label><span className="checkbox-line"><input id="analysis-mandatory" type="checkbox" checked={editDraft.mandatory} onChange={(event) => setEditDraft((current) => ({ ...current, mandatory: event.target.checked }))} />标记为强制要求</span></div>
        </div>
      </Modal>

      <Modal
        open={isApi && Boolean(confirmationDraft && confirmationRequirement)}
        title={`${confirmationDraft?.status === 'rejected' ? '驳回' : '确认'} ${confirmationRequirement?.code ?? ''}`}
        description={confirmationDraft?.status === 'rejected' ? '驳回后该条目不会被视为已确认，可填写人工判断依据。' : '确认只保存人工处理状态，不代表已进入响应矩阵。'}
        onClose={() => setConfirmationDraft(null)}
        width={560}
        footer={<><Button variant="secondary" onClick={() => setConfirmationDraft(null)}>取消</Button><Button variant={confirmationDraft?.status === 'rejected' ? 'danger' : 'primary'} icon={confirmationDraft?.status === 'rejected' ? <XCircle size={15} /> : <Check size={15} />} disabled={!confirmationDraft || confirmationDraft.note.length > 1000 || Boolean(confirmationDraft && confirmingIds.has(confirmationDraft.requirementId))} onClick={() => void saveConfirmation()}>{confirmationDraft && confirmingIds.has(confirmationDraft.requirementId) ? '保存中' : '保存处理结果'}</Button></>}
      >
        <div className="form-field">
          <label htmlFor="confirmation-note">人工备注（可选）</label>
          <textarea id="confirmation-note" rows={5} maxLength={1000} value={confirmationDraft?.note ?? ''} onChange={(event) => setConfirmationDraft((current) => current ? { ...current, note: event.target.value } : current)} placeholder="记录确认依据或驳回原因" />
          <small>{confirmationDraft?.note.length ?? 0} / 1000 字</small>
        </div>
      </Modal>
    </div>
  )
}

export default AnalysisPage
