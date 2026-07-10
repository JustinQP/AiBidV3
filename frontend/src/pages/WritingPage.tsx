import {
  AlignLeft,
  ArrowLeft,
  Bold,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDot,
  Clock3,
  Cloud,
  CloudOff,
  ExternalLink,
  FileCheck2,
  FileSearch,
  FileText,
  Heading1,
  Heading2,
  History,
  Image,
  Italic,
  Link2,
  List,
  ListFilter,
  ListOrdered,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightClose,
  Quote,
  Redo2,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Table2,
  Underline,
  Undo2,
  WandSparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePrototype } from '../context/PrototypeContext'
import { project } from '../data/mock'
import type { OutlineSection } from '../types'
import { Badge, Button, Drawer, InlineMessage, Modal, StatusBadge } from '../components/ui'

type WorkbenchTab = 'ai' | 'requirements' | 'sources' | 'comments'
type OutlineFilter = 'all' | 'mine' | 'risk'
type SaveState = 'saved' | 'saving' | 'error'

interface SourcePreview {
  id: string
  kind: '招标原文' | '企业知识' | '项目资料'
  title: string
  location: string
  quote: string
  meta: string
  confidence?: number
}

const sourcePreviews: SourcePreview[] = [
  {
    id: 'req-024',
    kind: '招标原文',
    title: '附件2_评分办法.xlsx',
    location: '工作表“技术评分” · 第 18 行',
    quote: '总体技术架构合理、先进、完整，能够充分支撑平台持续演进和弹性扩展，最高得 8 分。',
    meta: '评分项 · REQ-024 · 8 分',
    confidence: 96,
  },
  {
    id: 'req-018',
    kind: '招标原文',
    title: '附件1_技术需求书.docx',
    location: '第 12 页 · 2.3.1 技术架构要求',
    quote: '平台应采用微服务架构，支持各业务模块独立部署、弹性扩展与独立升级。',
    meta: '强制技术要求 · REQ-018',
    confidence: 98,
  },
  {
    id: 'knowledge-arch',
    kind: '企业知识',
    title: '智慧园区平台技术架构白皮书',
    location: 'V3.2 · 第 4 章 · 已发布',
    quote: '企业标准架构采用云原生微服务体系，通过统一网关、服务治理、容器编排和可观测平台形成稳定的技术底座。',
    meta: '架构方案库 · 有效期至 2027-12-31',
  },
  {
    id: 'knowledge-security',
    kind: '企业知识',
    title: '平台安全与等保建设标准方案',
    location: 'V2.7 · 第 3 章 · 已发布',
    quote: '安全体系覆盖身份鉴别、访问控制、传输加密、数据脱敏、安全审计与持续运营六个控制域。',
    meta: '安全方案库 · 内部资料',
  },
]

const candidateHtml = `
  <h3>3.2.4 技术架构的先进性与完整性</h3>
  <p class="ai-inserted-paragraph">本项目技术架构以云原生和微服务为核心，按照“统一底座、领域解耦、弹性伸缩、持续演进”的原则构建。平台通过容器化编排实现服务实例按需扩缩，通过服务注册与配置中心实现运行期治理，并以统一 API 网关承接访问控制、流量调度和接口审计，从而满足业务模块独立部署、弹性扩展与独立升级要求。<span class="editor-citation" contenteditable="false" role="button" data-source-id="req-018">[REQ-018]</span></p>
  <p class="ai-inserted-paragraph">架构设计同时覆盖应用、数据、集成、安全和运维五个层面。各层之间通过标准接口形成清晰边界，并通过统一身份、统一日志、统一监控和统一数据标准建立横向治理能力，避免形成新的信息孤岛，为后续业务扩展和技术升级预留稳定演进空间。<span class="editor-citation citation-knowledge" contenteditable="false" role="button" data-source-id="knowledge-arch">[企业知识·架构白皮书]</span></p>
`

const initialDocumentHtml = `
  <div class="document-kicker">第三章&emsp;技术方案</div>
  <h1>3.2 总体技术方案</h1>
  <p class="document-lead">本章围绕智慧园区数字化平台的建设目标，说明总体架构、技术路线以及关键技术能力，确保方案完整响应招标文件关于架构先进性、开放性和可持续演进的要求。</p>
  <div class="document-callout">
    <strong>本章响应重点</strong>
    <span>已映射 12 项招标要求，其中评分项 3 项、强制项 5 项；当前覆盖率 91.7%。</span>
  </div>
  <h2>3.2.1 建设思路</h2>
  <p>平台建设坚持“业务牵引、数据驱动、平台支撑、安全可控”的总体思路。以园区运营服务场景为牵引，统一建设数字底座和能力中心，打通既有系统与新增业务之间的数据链路，形成可复用、可组合、可持续演进的平台能力。</p>
  <p>在总体设计中，我们将招标文件提出的业务目标、技术要求和评分要点逐项映射到架构能力与实施措施，保证每项关键要求均有明确响应位置和可验证的交付结果。<span class="editor-citation" contenteditable="false" role="button" data-source-id="req-024">[REQ-024]</span></p>
  <h2>3.2.2 总体架构</h2>
  <p>总体架构自下而上划分为基础设施层、平台支撑层、数据能力层、业务应用层和统一门户层，并由安全保障体系、标准规范体系和运维运营体系贯穿各层。各层职责边界明确，通过标准化接口协同，降低系统耦合度。</p>
  <figure class="document-figure">
    <div class="architecture-placeholder">
      <span>统一门户与场景应用</span>
      <span>业务中台 · 数据中台 · AI 能力中心</span>
      <span>云原生技术底座与基础设施</span>
    </div>
    <figcaption>图 3-2&emsp;智慧园区数字化平台总体技术架构</figcaption>
  </figure>
  <h2>3.2.3 微服务与弹性扩展设计</h2>
  <p>平台采用微服务架构，将业务能力按照领域边界拆分为可独立部署和升级的服务单元，并通过统一服务治理体系保障调用可靠性。容器编排平台可依据访问压力动态调整服务实例数量，在提升资源利用率的同时保障关键业务连续性。<span class="editor-citation" contenteditable="false" role="button" data-source-id="req-018">[REQ-018]</span></p>
  <table>
    <thead><tr><th>设计维度</th><th>关键机制</th><th>预期效果</th></tr></thead>
    <tbody>
      <tr><td>服务解耦</td><td>领域拆分、标准接口、独立部署</td><td>降低模块间影响范围</td></tr>
      <tr><td>弹性伸缩</td><td>容器编排、指标监测、自动扩缩</td><td>适应业务峰谷变化</td></tr>
      <tr><td>服务治理</td><td>注册发现、限流熔断、链路追踪</td><td>保障服务稳定运行</td></tr>
    </tbody>
  </table>
`

function getSectionDocumentHtml(section: OutlineSection, includeCandidate: boolean) {
  if (section.id === 's32') return `${initialDocumentHtml}${includeCandidate ? candidateHtml : ''}`
  return `
    <div class="document-kicker">投标文件&emsp;章节正文</div>
    <h1>${section.number} ${section.title}</h1>
    <p class="document-lead">本节围绕“${section.title}”说明我方对项目需求的理解、总体响应思路与具体实施安排，内容将结合已确认的招标要求和企业知识资料持续完善。</p>
    <div class="document-callout">
      <strong>章节任务</strong>
      <span>已映射 ${section.requirementCount} 项招标要求，目标篇幅约 ${section.targetWords.toLocaleString('zh-CN')} 字；负责人 ${section.owner}，审核人 ${section.reviewer}。</span>
    </div>
    <h2>${section.number}.1 响应思路</h2>
    <p>我方将严格依据招标文件要求组织本节内容，确保关键要求均有明确响应、重要结论均有资料支撑，并通过章节自检和人工审核保证内容完整、准确且可追溯。</p>
    <h2>${section.number}.2 方案说明</h2>
    <p>当前章节已建立基础结构。编写人可从右侧选择章节要求和企业资料，使用 AI 生成候选内容，经人工确认后插入正文并提交审核。</p>
  `
}

const tabItems: Array<{ id: WorkbenchTab; label: string; icon: typeof Sparkles }> = [
  { id: 'ai', label: 'AI 助手', icon: Sparkles },
  { id: 'requirements', label: '章节要求', icon: FileCheck2 },
  { id: 'sources', label: '来源资料', icon: BookOpen },
  { id: 'comments', label: '评论与检查', icon: MessageSquareText },
]

function SectionStateIcon({ status }: { status: OutlineSection['status'] }) {
  if (status === '已批准') return <CheckCircle2 className="section-state-approved" size={15} />
  if (status === '待审核') return <Clock3 className="section-state-review" size={15} />
  if (status === '编写中') return <CircleDot className="section-state-writing" size={15} />
  return <Circle className="section-state-empty" size={15} />
}

function ToolbarButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string
  children: ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return <button type="button" className="writing-tool-button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>
}

export function WritingPage() {
  const navigate = useNavigate()
  const { sectionId = 's32' } = useParams<{ sectionId: string }>()
  const {
    outline,
    requirements,
    issues,
    candidateInserted,
    sectionSubmitted,
    setCandidateInserted,
    setSectionSubmitted,
    notify,
  } = usePrototype()

  const editorRef = useRef<HTMLDivElement | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const generationTimerRef = useRef<number | null>(null)
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('ai')
  const [outlineFilter, setOutlineFilter] = useState<OutlineFilter>('all')
  const [outlineQuery, setOutlineQuery] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [generating, setGenerating] = useState(false)
  const [candidateVisible, setCandidateVisible] = useState(!candidateInserted)
  const [customPrompt, setCustomPrompt] = useState('结合评分项，补充本节架构先进性与完整性说明，控制在 500 字以内。')
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false)
  const [activeSource, setActiveSource] = useState<SourcePreview>(sourcePreviews[0])
  const [submitModalOpen, setSubmitModalOpen] = useState(false)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)

  const currentSection = outline.find((section) => section.id === sectionId) ?? outline.find((section) => section.id === 's32') ?? outline[0]

  const currentRequirements = useMemo(() => {
    if (!currentSection) return []
    const sectionLabel = `${currentSection.number} ${currentSection.title}`
    return requirements.filter((item) => item.section === sectionLabel)
  }, [currentSection, requirements])

  const currentIssues = useMemo(() => {
    if (!currentSection) return []
    return issues.filter((item) => item.location.includes(currentSection.number) || item.location.includes(currentSection.title))
  }, [currentSection, issues])

  const filteredOutline = useMemo(() => outline.filter((section) => {
    const matchesQuery = `${section.number} ${section.title}`.toLowerCase().includes(outlineQuery.trim().toLowerCase())
    if (!matchesQuery) return false
    if (outlineFilter === 'mine') return section.owner === '李明'
    if (outlineFilter === 'risk') return section.status === '待审核' || section.status === '未开始'
    return true
  }), [outline, outlineFilter, outlineQuery])

  const approvedCount = outline.filter((section) => section.status === '已批准').length
  const mobileReadOnly = isMobile || sectionSubmitted

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const updateMobileState = (event: MediaQueryListEvent) => setIsMobile(event.matches)
    media.addEventListener('change', updateMobileState)
    return () => media.removeEventListener('change', updateMobileState)
  }, [])

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (generationTimerRef.current !== null) window.clearTimeout(generationTimerRef.current)
  }, [])

  const markForAutosave = () => {
    if (mobileReadOnly) return
    setSaveState('saving')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      setSaveState('saved')
      saveTimerRef.current = null
    }, 900)
  }

  const saveImmediately = () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    setSaveState('saving')
    saveTimerRef.current = window.setTimeout(() => {
      setSaveState('saved')
      saveTimerRef.current = null
      notify({ title: '章节已保存', description: '已生成新的自动保存版本 V0.8.13。', tone: 'success' })
    }, 500)
  }

  const executeEditorCommand = (command: string, value?: string) => {
    if (mobileReadOnly) return
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    markForAutosave()
  }

  const insertTable = () => executeEditorCommand('insertHTML', '<table><tbody><tr><th>项目</th><th>说明</th></tr><tr><td>待填写</td><td>待填写</td></tr></tbody></table>')

  const handleGenerate = (instruction?: string) => {
    if (mobileReadOnly || generating) return
    if (instruction) setCustomPrompt(instruction)
    setGenerating(true)
    setCandidateVisible(false)
    generationTimerRef.current = window.setTimeout(() => {
      setGenerating(false)
      setCandidateVisible(true)
      generationTimerRef.current = null
      notify({ title: '候选内容已生成', description: '已使用 2 项招标要求和 2 份企业资料。', tone: 'success' })
    }, 1200)
  }

  const insertCandidate = () => {
    if (mobileReadOnly || !editorRef.current) return
    editorRef.current.insertAdjacentHTML('beforeend', candidateHtml)
    setCandidateInserted(true)
    setCandidateVisible(false)
    markForAutosave()
    notify({ title: '候选内容已插入', description: '来源引用与生成记录已同步保存。', tone: 'success' })
  }

  const openSource = (source: SourcePreview) => {
    setActiveSource(source)
    setSourceDrawerOpen(true)
  }

  const handleEditorClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const citation = target.closest<HTMLElement>('[data-source-id]')
    const sourceId = citation?.dataset.sourceId
    if (!sourceId) return
    const source = sourcePreviews.find((item) => item.id === sourceId)
    if (source) openSource(source)
  }

  const submitForReview = () => {
    setSectionSubmitted(true)
    setSubmitModalOpen(false)
    setReviewConfirmed(false)
    notify({ title: '已提交章节审核', description: '审核人张伟已收到 3.2 总体技术方案的审核任务。', tone: 'success' })
  }

  const renderSaveState = () => {
    if (saveState === 'saving') return <span className="writing-save-state is-saving"><LoaderCircle className="spin" size={15} />保存中</span>
    if (saveState === 'error') return <button className="writing-save-state is-error" onClick={saveImmediately}><CloudOff size={15} />保存失败，重试</button>
    return <span className="writing-save-state is-saved"><Cloud size={15} />已自动保存</span>
  }

  if (!currentSection) return null

  return (
    <div className={`writing-workbench ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <header className="writing-commandbar">
        <div className="writing-commandbar-left">
          <button className="writing-icon-action" type="button" aria-label="返回项目" onClick={() => navigate('/projects/demo/overview')}><ArrowLeft size={19} /></button>
          <div className="writing-breadcrumb">
            <span>{project.name}</span><ChevronRight size={14} /><strong>{currentSection.number} {currentSection.title}</strong>
          </div>
          <Badge tone="blue">{sectionSubmitted ? '待审核' : '编写中'}</Badge>
        </div>
        <div className="writing-commandbar-center">
          <span className="editing-lock"><LockKeyhole size={14} />李明正在编辑</span>
          {renderSaveState()}
        </div>
        <div className="writing-commandbar-actions">
          <button className="writing-icon-action" type="button" aria-label="版本历史" title="版本历史" onClick={() => notify({ title: '版本历史', description: '当前版本 V0.8.12，共 18 个历史版本。', tone: 'info' })}><History size={18} /></button>
          <Button variant="secondary" size="sm" icon={<ShieldCheck size={16} />} disabled={isMobile} onClick={() => { setActiveTab('comments'); setRightCollapsed(false) }}>运行检查</Button>
          <Button size="sm" icon={<Send size={16} />} disabled={isMobile || sectionSubmitted} onClick={() => setSubmitModalOpen(true)}>{sectionSubmitted ? '已提交审核' : '提交审核'}</Button>
          <button className="writing-icon-action" type="button" aria-label="更多操作"><MoreHorizontal size={18} /></button>
        </div>
      </header>

      {isMobile ? (
        <div className="writing-mobile-readonly">
          <LockKeyhole size={16} />移动端仅支持查看正文、要求和评论，请在桌面端进行编写与 AI 生成。
        </div>
      ) : null}

      <div className="writing-columns">
        <aside className="writing-outline-pane">
          <div className="writing-pane-header">
            <div><strong>投标书目录</strong><span>{approvedCount}/{outline.length} 章已批准</span></div>
            <button type="button" className="writing-icon-action" aria-label="收起目录" onClick={() => setLeftCollapsed(true)}><PanelLeftClose size={17} /></button>
          </div>
          <div className="writing-outline-tools">
            <label className="writing-search"><Search size={15} /><input value={outlineQuery} onChange={(event) => setOutlineQuery(event.target.value)} placeholder="搜索章节" /></label>
            <div className="writing-filter-tabs" role="tablist" aria-label="目录筛选">
              {([['all', '全部'], ['mine', '我的'], ['risk', '有风险']] as const).map(([id, label]) => (
                <button type="button" role="tab" aria-selected={outlineFilter === id} className={outlineFilter === id ? 'active' : ''} key={id} onClick={() => setOutlineFilter(id)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="writing-outline-tree">
            {filteredOutline.map((section) => {
              const active = section.id === currentSection.id
              return (
                <button
                  type="button"
                  key={section.id}
                  className={`writing-outline-item level-${section.level} ${active ? 'active' : ''}`}
                  onClick={() => navigate(`/projects/demo/write/${section.id}`)}
                >
                  <SectionStateIcon status={section.status} />
                  <span className="writing-outline-copy"><strong>{section.number} {section.title}</strong><small>{section.owner} · {section.requirementCount} 项要求</small></span>
                  {section.status === '待审核' ? <CircleAlert className="section-risk-icon" size={15} /> : null}
                </button>
              )
            })}
          </div>
          <div className="writing-outline-footer">
            <div><span>章节进度</span><strong>68%</strong></div>
            <div className="writing-progress"><span style={{ width: '68%' }} /></div>
            <small>17 章已完成 · 4 章待审核</small>
          </div>
        </aside>

        {leftCollapsed ? <button type="button" className="writing-restore-pane restore-left" aria-label="展开目录" onClick={() => setLeftCollapsed(false)}><BookOpen size={17} /></button> : null}

        <main className="writing-editor-pane">
          <div className="writing-editor-toolbar" aria-label="富文本工具栏">
            <div className="writing-tool-group">
              <ToolbarButton label="撤销" disabled={mobileReadOnly} onClick={() => executeEditorCommand('undo')}><Undo2 size={16} /></ToolbarButton>
              <ToolbarButton label="重做" disabled={mobileReadOnly} onClick={() => executeEditorCommand('redo')}><Redo2 size={16} /></ToolbarButton>
            </div>
            <div className="writing-tool-group">
              <button className="writing-style-select" type="button" disabled={mobileReadOnly}>正文 <ChevronDown size={13} /></button>
              <ToolbarButton label="一级标题" disabled={mobileReadOnly} onClick={() => executeEditorCommand('formatBlock', 'h2')}><Heading1 size={16} /></ToolbarButton>
              <ToolbarButton label="二级标题" disabled={mobileReadOnly} onClick={() => executeEditorCommand('formatBlock', 'h3')}><Heading2 size={16} /></ToolbarButton>
            </div>
            <div className="writing-tool-group">
              <ToolbarButton label="加粗" disabled={mobileReadOnly} onClick={() => executeEditorCommand('bold')}><Bold size={16} /></ToolbarButton>
              <ToolbarButton label="斜体" disabled={mobileReadOnly} onClick={() => executeEditorCommand('italic')}><Italic size={16} /></ToolbarButton>
              <ToolbarButton label="下划线" disabled={mobileReadOnly} onClick={() => executeEditorCommand('underline')}><Underline size={16} /></ToolbarButton>
              <ToolbarButton label="左对齐" disabled={mobileReadOnly} onClick={() => executeEditorCommand('justifyLeft')}><AlignLeft size={16} /></ToolbarButton>
            </div>
            <div className="writing-tool-group">
              <ToolbarButton label="无序列表" disabled={mobileReadOnly} onClick={() => executeEditorCommand('insertUnorderedList')}><List size={16} /></ToolbarButton>
              <ToolbarButton label="有序列表" disabled={mobileReadOnly} onClick={() => executeEditorCommand('insertOrderedList')}><ListOrdered size={16} /></ToolbarButton>
              <ToolbarButton label="引用" disabled={mobileReadOnly} onClick={() => executeEditorCommand('formatBlock', 'blockquote')}><Quote size={16} /></ToolbarButton>
            </div>
            <div className="writing-tool-group">
              <ToolbarButton label="插入表格" disabled={mobileReadOnly} onClick={insertTable}><Table2 size={16} /></ToolbarButton>
              <ToolbarButton label="插入图片" disabled={mobileReadOnly} onClick={() => notify({ title: '选择项目图片', description: '可从项目资料或本地上传图片。', tone: 'info' })}><Image size={16} /></ToolbarButton>
              <ToolbarButton label="插入链接" disabled={mobileReadOnly} onClick={() => executeEditorCommand('createLink', '#')}><Link2 size={16} /></ToolbarButton>
            </div>
            <div className="writing-toolbar-spacer" />
            <button type="button" className="writing-manual-save" disabled={mobileReadOnly} onClick={saveImmediately}><Cloud size={15} />保存</button>
          </div>

          {saveState === 'error' ? (
            <InlineMessage tone="error" title="自动保存失败">请检查网络连接后重试。离开页面前请确认内容已保存。</InlineMessage>
          ) : null}

          <div className="writing-document-stage">
            <div className="writing-document-meta">
              <div><Badge tone="blue">技术方案</Badge><span>负责人：李明</span><span>审核人：张伟</span></div>
              <div><span>3,248 / 5,200 字</span><span>版本 V0.8.12</span></div>
            </div>
            <article
              ref={editorRef}
              className={`writing-document ${mobileReadOnly ? 'is-readonly' : ''}`}
              contentEditable={!mobileReadOnly}
              suppressContentEditableWarning
              spellCheck={false}
              onInput={markForAutosave}
              onClick={handleEditorClick}
              dangerouslySetInnerHTML={{ __html: getSectionDocumentHtml(currentSection, candidateInserted) }}
            />
            <div className="writing-document-footer"><span>{project.code} · 技术标</span><span>第 18 页</span></div>
          </div>
        </main>

        {rightCollapsed ? <button type="button" className="writing-restore-pane restore-right" aria-label="展开辅助面板" onClick={() => setRightCollapsed(false)}><Sparkles size={17} /></button> : null}

        <aside className="writing-assistant-pane">
          <div className="writing-assistant-tabs" role="tablist" aria-label="写作辅助">
            {tabItems.map(({ id, label, icon: Icon }) => (
              <button type="button" role="tab" aria-selected={activeTab === id} className={activeTab === id ? 'active' : ''} key={id} onClick={() => setActiveTab(id)}>
                <Icon size={15} /><span>{label}</span>
                {id === 'requirements' ? <i>{currentRequirements.length}</i> : null}
                {id === 'comments' ? <i>{currentIssues.length + 1}</i> : null}
              </button>
            ))}
            <button type="button" className="writing-collapse-assistant" aria-label="收起辅助面板" onClick={() => setRightCollapsed(true)}><PanelRightClose size={17} /></button>
          </div>

          <div className="writing-assistant-content">
            {activeTab === 'ai' ? (
              <div className="writing-ai-panel">
                <section className="writing-context-card">
                  <header><div><Sparkles size={16} /><strong>当前生成上下文</strong></div><button type="button" onClick={() => setActiveTab('sources')}>管理</button></header>
                  <div className="writing-context-stats">
                    <span><FileCheck2 size={14} />{Math.max(currentRequirements.length, 2)} 项章节要求</span>
                    <span><BookOpen size={14} />2 份企业资料</span>
                  </div>
                  <div className="writing-context-chips"><Badge tone="blue">REQ-018</Badge><Badge tone="blue">REQ-024</Badge><Badge tone="teal">架构白皮书 V3.2</Badge></div>
                </section>

                <section className="writing-quick-actions">
                  <div className="writing-section-heading"><div><WandSparkles size={16} /><strong>快捷生成</strong></div></div>
                  <div className="writing-action-grid">
                    <button type="button" disabled={mobileReadOnly || generating} onClick={() => handleGenerate('根据本节要求生成完整初稿，突出架构完整性和先进性。')}><FileText size={16} /><span><strong>生成初稿</strong><small>按要求组织完整内容</small></span></button>
                    <button type="button" disabled={mobileReadOnly || generating} onClick={() => handleGenerate('扩写选中内容，补充技术机制与实施效果。')}><Sparkles size={16} /><span><strong>扩写内容</strong><small>补充机制与实施效果</small></span></button>
                    <button type="button" disabled={mobileReadOnly || generating} onClick={() => handleGenerate('将选中内容改写为正式投标语气。')}><RefreshCw size={16} /><span><strong>正式改写</strong><small>统一投标文件语气</small></span></button>
                    <button type="button" disabled={mobileReadOnly || generating} onClick={() => handleGenerate('将选中内容整理为对照表格。')}><Table2 size={16} /><span><strong>转为表格</strong><small>结构化呈现关键要点</small></span></button>
                  </div>
                </section>

                <section className="writing-prompt-box">
                  <textarea aria-label="AI 写作要求" value={customPrompt} readOnly={mobileReadOnly} onChange={(event) => setCustomPrompt(event.target.value)} />
                  <div className="writing-prompt-options">
                    <button type="button">正式严谨 <ChevronDown size={13} /></button>
                    <button type="button">约 500 字 <ChevronDown size={13} /></button>
                    <button type="button" className="writing-generate-button" disabled={mobileReadOnly || generating || customPrompt.trim().length === 0} onClick={() => handleGenerate()}>
                      {generating ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{generating ? '生成中' : '生成'}
                    </button>
                  </div>
                </section>

                {generating ? (
                  <section className="writing-generation-progress">
                    <div><LoaderCircle className="spin" size={18} /><strong>正在生成候选内容</strong></div>
                    <span>正在核对评分项与企业架构资料…</span>
                    <div className="writing-progress"><span style={{ width: '62%' }} /></div>
                    <button type="button" onClick={() => { if (generationTimerRef.current !== null) window.clearTimeout(generationTimerRef.current); generationTimerRef.current = null; setGenerating(false) }}>取消生成</button>
                  </section>
                ) : null}

                {candidateVisible && !generating ? (
                  <section className="writing-candidate-card">
                    <header><div><span className="ai-mark"><Sparkles size={14} /></span><div><strong>AI 生成候选</strong><small>刚刚 · 智能写作模型</small></div></div><Badge tone="teal">有来源</Badge></header>
                    <div className="writing-candidate-body">
                      <h4>3.2.4 技术架构的先进性与完整性</h4>
                      <p>本项目技术架构以云原生和微服务为核心，按照“统一底座、领域解耦、弹性伸缩、持续演进”的原则构建。平台通过容器化编排实现服务实例按需扩缩……</p>
                      <button type="button" className="writing-candidate-expand" onClick={() => openSource(sourcePreviews[1])}>查看完整内容与来源 <ChevronRight size={14} /></button>
                    </div>
                    <div className="writing-candidate-evidence"><Check size={14} /><span>引用 2 项要求、1 份企业资料</span><button type="button" onClick={() => setActiveTab('sources')}>查看来源</button></div>
                    <footer>
                      <Button variant="primary" size="sm" icon={<Check size={15} />} disabled={mobileReadOnly} onClick={insertCandidate}>插入正文</Button>
                      <Button variant="secondary" size="sm" disabled={mobileReadOnly} onClick={() => notify({ title: '请先在正文中选择内容', description: '选择需要替换的段落后，可再次执行替换。', tone: 'warning' })}>替换选中</Button>
                      <button type="button" className="writing-discard-candidate" onClick={() => setCandidateVisible(false)}>放弃</button>
                    </footer>
                  </section>
                ) : null}

                {candidateInserted && !candidateVisible ? (
                  <InlineMessage tone="success" title="候选内容已插入正文">生成记录和来源引用已同步保存，可在正文末尾继续调整。</InlineMessage>
                ) : null}

                <section className="writing-ai-history">
                  <button type="button"><History size={15} /><span>查看本章 6 条生成记录</span><ChevronRight size={14} /></button>
                </section>
              </div>
            ) : null}

            {activeTab === 'requirements' ? (
              <div className="writing-requirements-panel">
                <div className="writing-panel-summary">
                  <div><strong>章节覆盖率</strong><span>11 / 12 项已响应</span></div><strong>91.7%</strong>
                  <div className="writing-progress"><span style={{ width: '91.7%' }} /></div>
                </div>
                <div className="writing-list-toolbar"><span>映射到本章的要求</span><button type="button"><ListFilter size={14} />筛选</button></div>
                {(currentRequirements.length ? currentRequirements : requirements.slice(0, 2)).map((requirement) => {
                  const source = sourcePreviews.find((item) => item.id === requirement.id.toLowerCase()) ?? sourcePreviews[0]
                  return (
                    <article className="writing-requirement-card" key={requirement.id}>
                      <header><div><Badge tone={requirement.mandatory ? 'red' : 'blue'}>{requirement.mandatory ? '强制项' : requirement.type}</Badge><strong>{requirement.id}</strong></div><StatusBadge status={requirement.status} /></header>
                      <p>{requirement.summary}</p>
                      <div className="writing-requirement-meta"><span><FileSearch size={14} />{requirement.source} · P.{requirement.page}</span>{requirement.score ? <strong>{requirement.score} 分</strong> : null}</div>
                      <footer><button type="button" onClick={() => openSource(source)}>定位原文 <ExternalLink size={13} /></button><button type="button" onClick={() => notify({ title: '要求引用已插入', description: `${requirement.id} 已绑定到当前光标位置。`, tone: 'success' })}>插入引用</button></footer>
                    </article>
                  )
                })}
                <article className="writing-requirement-card is-warning">
                  <header><div><Badge tone="amber">待补充</Badge><strong>REQ-026</strong></div><StatusBadge status="待响应" /></header>
                  <p>说明系统在高并发情况下的容量规划、限流与降级策略。</p>
                  <div className="writing-requirement-meta"><span><FileSearch size={14} />技术需求书 · P.15</span></div>
                  <footer><button type="button" onClick={() => openSource(sourcePreviews[1])}>定位原文 <ExternalLink size={13} /></button><button type="button" onClick={() => { setActiveTab('ai'); setCustomPrompt('补充高并发场景下的容量规划、限流、熔断与降级策略。') }}>交给 AI</button></footer>
                </article>
              </div>
            ) : null}

            {activeTab === 'sources' ? (
              <div className="writing-sources-panel">
                <label className="writing-search"><Search size={15} /><input placeholder="搜索招标原文、企业知识或项目资料" /></label>
                <div className="writing-source-filter"><button className="active" type="button">已选 4</button><button type="button">招标原文</button><button type="button">企业知识</button><button type="button">项目资料</button></div>
                <div className="writing-source-note"><ShieldCheck size={16} /><span>仅展示当前用户有权访问且在有效期内的资料。</span></div>
                {sourcePreviews.map((source) => (
                  <article className="writing-source-card" key={source.id}>
                    <header><div className={`source-kind-icon source-kind-${source.kind === '招标原文' ? 'bid' : source.kind === '企业知识' ? 'knowledge' : 'project'}`}>{source.kind === '招标原文' ? <FileText size={16} /> : <BookOpen size={16} />}</div><div><strong>{source.title}</strong><span>{source.kind}</span></div><CheckCircle2 size={16} /></header>
                    <p>{source.quote}</p>
                    <div>{source.location}</div>
                    <footer><button type="button" onClick={() => openSource(source)}>预览</button><button type="button" onClick={() => notify({ title: '资料已加入上下文', description: `${source.title} 将用于下一次生成。`, tone: 'success' })}>加入上下文</button></footer>
                  </article>
                ))}
              </div>
            ) : null}

            {activeTab === 'comments' ? (
              <div className="writing-comments-panel">
                <section className="writing-check-summary">
                  <header><div><ShieldCheck size={17} /><strong>本章检查结果</strong></div><span>刚刚检查</span></header>
                  <div><button type="button"><strong>0</strong><span>阻断</span></button><button type="button"><strong>1</strong><span>重要</span></button><button type="button"><strong>2</strong><span>一般</span></button></div>
                  <Button variant="secondary" size="sm" icon={<RefreshCw size={15} />} onClick={() => notify({ title: '检查已完成', description: '发现 3 个需要关注的问题。', tone: 'info' })}>重新检查</Button>
                </section>
                <div className="writing-list-toolbar"><span>问题与评论</span><button type="button">全部</button></div>
                <article className="writing-comment-card severity-important">
                  <header><Badge tone="amber">重要</Badge><span>自动检查</span></header>
                  <strong>缺少高并发容量规划说明</strong>
                  <p>REQ-026 尚未在正文中形成明确响应，建议补充限流、熔断和降级机制。</p>
                  <footer><button type="button" onClick={() => { setActiveTab('ai'); setCustomPrompt('补充高并发场景下的容量规划、限流、熔断与降级策略。') }}>使用 AI 修复</button><button type="button">定位正文</button></footer>
                </article>
                {currentIssues.map((issue) => (
                  <article className={`writing-comment-card severity-${issue.severity === '阻断' ? 'blocker' : issue.severity === '重要' ? 'important' : 'normal'}`} key={issue.id}>
                    <header><Badge tone={issue.severity === '阻断' ? 'red' : issue.severity === '重要' ? 'amber' : 'blue'}>{issue.severity}</Badge><span>{issue.id}</span></header>
                    <strong>{issue.title}</strong><p>{issue.description}</p>
                    <div className="writing-comment-author"><span className="avatar avatar-blue">张</span><span>张伟 · 20 分钟前</span></div>
                    <footer><button type="button">回复</button><button type="button">定位正文</button></footer>
                  </article>
                ))}
                <div className="writing-new-comment"><textarea placeholder="添加章节评论，使用 @ 提及项目成员…" /><Button variant="secondary" size="sm" icon={<Send size={14} />} onClick={() => notify({ title: '评论已添加', description: '相关成员将收到提醒。', tone: 'success' })}>发送</Button></div>
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <Drawer
        open={sourceDrawerOpen}
        title={activeSource.title}
        subtitle={`${activeSource.kind} · ${activeSource.location}`}
        onClose={() => setSourceDrawerOpen(false)}
      >
        <div className="writing-source-drawer">
          <section className="writing-source-properties">
            <div><span>资料类型</span><Badge tone={activeSource.kind === '招标原文' ? 'blue' : 'teal'}>{activeSource.kind}</Badge></div>
            <div><span>来源信息</span><strong>{activeSource.meta}</strong></div>
            {activeSource.confidence ? <div><span>解析置信度</span><strong>{activeSource.confidence}%</strong></div> : null}
          </section>
          <section className="writing-original-preview">
            <header><strong>原文预览</strong><button type="button"><ExternalLink size={14} />在原文件中打开</button></header>
            <div className="writing-page-preview">
              <div className="writing-page-label">{activeSource.location}</div>
              <p>{activeSource.quote}</p>
            </div>
          </section>
          <section className="writing-source-usage">
            <h3>当前使用情况</h3>
            <div><CheckCircle2 size={16} /><span>已加入本章 AI 上下文</span></div>
            <div><Link2 size={16} /><span>正文中已有 1 处引用</span></div>
          </section>
          <div className="writing-drawer-actions">
            <Button variant="secondary" onClick={() => setSourceDrawerOpen(false)}>关闭</Button>
            <Button icon={<Link2 size={15} />} disabled={mobileReadOnly} onClick={() => { setSourceDrawerOpen(false); notify({ title: '来源引用已插入', description: '引用标记已插入到当前光标位置。', tone: 'success' }) }}>插入引用</Button>
          </div>
        </div>
      </Drawer>

      <Modal
        open={submitModalOpen}
        title="提交章节审核"
        description="提交后章节将进入只读状态，由审核人张伟进行内容和合规审核。"
        onClose={() => setSubmitModalOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setSubmitModalOpen(false)}>取消</Button><Button icon={<Send size={16} />} disabled={!reviewConfirmed} onClick={submitForReview}>确认提交</Button></>}
      >
        <div className="writing-submit-review">
          <section className="writing-review-target">
            <span className="avatar avatar-blue">张</span>
            <div><strong>张伟</strong><span>项目负责人 · 章节审核人</span></div>
            <Badge tone="blue">审核人</Badge>
          </section>
          <section className="writing-submit-checklist">
            <h3>提交前检查</h3>
            <div><CheckCircle2 size={17} /><span>章节内容已自动保存</span></div>
            <div><CheckCircle2 size={17} /><span>11 / 12 项要求已形成响应</span></div>
            <div><CheckCircle2 size={17} /><span>未发现阻断级合规问题</span></div>
            <div className="is-warning"><CircleAlert size={17} /><span>仍有 1 项重要问题，审核人可退回修改</span></div>
          </section>
          <label className="writing-review-confirm"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} /><span>我已检查本章内容、来源引用与待确认信息，确认提交审核。</span></label>
        </div>
      </Modal>
    </div>
  )
}
