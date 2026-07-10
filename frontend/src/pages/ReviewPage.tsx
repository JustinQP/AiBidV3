import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FileCheck2,
  Filter,
  MessageSquareText,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Drawer, InlineMessage, PageHeader, ProgressBar, Select, StatusBadge } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import type { ReviewIssue } from '../types'

const chapterRows = [
  { name: '1 项目理解与整体方案', owner: '李明', status: '已批准', coverage: 100, issues: 0 },
  { name: '2 建设方案', owner: '李明', status: '待审核', coverage: 96, issues: 2 },
  { name: '3.2 总体技术方案', owner: '李明', status: '待审核', coverage: 92, issues: 1 },
  { name: '3.4 数据架构设计', owner: '王芳', status: '已退回', coverage: 86, issues: 3 },
  { name: '4 实施计划', owner: '周宁', status: '编写中', coverage: 78, issues: 1 },
]

export function ReviewPage() {
  const navigate = useNavigate()
  const { issues, closeIssue, reopenIssue, sectionSubmitted, sectionApproved, setSectionApproved, requirements, notify } = usePrototype()
  const [tab, setTab] = useState<'issues' | 'chapters' | 'checks'>('issues')
  const [severity, setSeverity] = useState('全部级别')
  const [selected, setSelected] = useState<ReviewIssue | null>(null)
  const [checking, setChecking] = useState(false)
  const openIssues = issues.filter((item) => item.status === '待处理')
  const blockerCount = openIssues.filter((item) => item.severity === '阻断').length
  const filteredIssues = useMemo(() => issues.filter((item) => severity === '全部级别' || item.severity === severity), [issues, severity])

  const rerun = () => {
    setChecking(true)
    window.setTimeout(() => {
      setChecking(false)
      notify({ title: '合规检查完成', description: `检查 36 个章节，发现 ${openIssues.length} 个待处理问题。`, tone: blockerCount ? 'warning' : 'success' })
    }, 1100)
  }

  const approve = () => {
    if (!sectionSubmitted) {
      notify({ title: '章节尚未提交', description: '请先在写作工作台提交审核。', tone: 'warning' })
      navigate('/projects/demo/write/s32')
      return
    }
    if (blockerCount) {
      notify({ title: '存在阻断问题', description: '关闭阻断问题后才能批准章节。', tone: 'error' })
      return
    }
    setSectionApproved(true)
    notify({ title: '章节已批准', description: '3.2 总体技术方案已进入正式导出版本。', tone: 'success' })
  }

  return (
    <div className="page review-page">
      <PageHeader
        eyebrow="智慧园区数字化平台建设项目"
        title="评审与合规"
        description="集中处理自动检查结果和人工评审问题，确保正式导出前风险闭环。"
        actions={<><Button variant="secondary" icon={<RefreshCw className={checking ? 'spin' : ''} size={16} />} onClick={rerun}>{checking ? '正在检查' : '重新检查'}</Button><Button icon={<ShieldCheck size={16} />} onClick={approve}>{sectionApproved ? '章节已批准' : '批准当前章节'}</Button></>}
      />

      {blockerCount ? <InlineMessage tone="error" title={`${blockerCount} 个阻断问题尚未关闭`}>阻断问题会拦截章节批准和正式导出，请优先处理。</InlineMessage> : <InlineMessage tone="success" title="正式导出阻断项已清零">当前自动检查与人工评审均无未关闭阻断问题。</InlineMessage>}

      <section className="review-scoreboard">
        <div className="review-score-main surface-flat"><div className="score-ring"><strong>86</strong><span>质量得分</span></div><div><h2>整体质量良好，仍有 3 项建议处理</h2><p>基于要求覆盖、内容完整性、事实来源和评审问题综合计算。</p><ProgressBar value={86} tone="green" /></div></div>
        <div className="review-metric surface-flat"><span>要求覆盖</span><strong>{requirements.filter((item) => item.section !== '未映射').length}/{requirements.length}</strong><small>95.5% 项目总覆盖率</small></div>
        <div className="review-metric surface-flat danger"><span>阻断问题</span><strong>{blockerCount}</strong><small>{blockerCount ? '必须在正式导出前关闭' : '已全部关闭'}</small></div>
        <div className="review-metric surface-flat"><span>待审核章节</span><strong>{sectionApproved ? 3 : 4}</strong><small>36 个章节 · 24 个已批准</small></div>
      </section>

      <section className="review-workbench surface">
        <div className="tabs review-tabs"><button className={tab === 'issues' ? 'active' : ''} onClick={() => setTab('issues')}><MessageSquareText size={16} />问题清单 <span>{openIssues.length}</span></button><button className={tab === 'chapters' ? 'active' : ''} onClick={() => setTab('chapters')}><FileCheck2 size={16} />章节评审</button><button className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}><ClipboardCheck size={16} />自动检查</button></div>

        {tab === 'issues' ? <>
          <div className="table-toolbar"><div className="search-input"><Search size={16} /><input placeholder="搜索问题或章节" /></div><Select value={severity} onChange={(event) => setSeverity(event.target.value)}><option>全部级别</option><option>阻断</option><option>重要</option><option>一般</option></Select><Button variant="secondary" size="sm" icon={<Filter size={14} />}>更多筛选</Button><span className="toolbar-spacer" /><Button size="sm" variant="secondary">新建评审问题</Button></div>
          <div className="table-scroll"><table className="data-table"><thead><tr><th>级别</th><th>问题</th><th>定位</th><th>责任人</th><th>状态</th><th>最近更新</th><th /></tr></thead><tbody>{filteredIssues.map((issue) => <tr key={issue.id}><td><Badge tone={issue.severity === '阻断' ? 'red' : issue.severity === '重要' ? 'amber' : 'blue'}>{issue.severity}</Badge></td><td><button className="table-title" onClick={() => setSelected(issue)}>{issue.title}<small>{issue.id} · {issue.description}</small></button></td><td><button className="source-link">{issue.location}</button></td><td><span className="person"><span className="avatar avatar-sm">{issue.owner.slice(0, 1)}</span>{issue.owner}</span></td><td><StatusBadge status={issue.status} /></td><td className="muted-cell">今天 14:32</td><td><Button size="sm" variant={issue.status === '待处理' ? 'secondary' : 'ghost'} onClick={() => issue.status === '待处理' ? closeIssue(issue.id) : reopenIssue(issue.id)}>{issue.status === '待处理' ? '标记解决' : '重新打开'}</Button></td></tr>)}</tbody></table></div>
        </> : null}

        {tab === 'chapters' ? <div className="table-scroll"><table className="data-table"><thead><tr><th>章节</th><th>编写人</th><th>要求覆盖</th><th>未关闭问题</th><th>状态</th><th /></tr></thead><tbody>{chapterRows.map((row) => <tr key={row.name}><td><button className="table-title" onClick={() => navigate('/projects/demo/write/s32')}>{row.name}</button></td><td><span className="person"><span className="avatar avatar-sm">{row.owner.slice(0, 1)}</span>{row.owner}</span></td><td><div className="coverage-cell"><ProgressBar value={row.coverage} tone={row.coverage > 90 ? 'green' : 'amber'} /><span>{row.coverage}%</span></div></td><td>{row.issues}</td><td><StatusBadge status={row.status} /></td><td><Button size="sm" variant="ghost" onClick={() => navigate('/projects/demo/write/s32')}>进入评审<ArrowRight size={14} /></Button></td></tr>)}</tbody></table></div> : null}

        {tab === 'checks' ? <div className="check-grid">{[
          ['要求覆盖检查', '126/132 条要求已映射，6 条需要确认', 'warning'],
          ['占位符检查', '发现 2 处【待补充】内容', 'error'],
          ['关键字段一致性', '项目名称、招标编号与日期均一致', 'success'],
          ['无来源事实检查', '3 条事实性表述需要补充来源', 'warning'],
          ['敏感词与承诺检查', '未发现越权承诺或高风险敏感词', 'success'],
          ['重复内容检查', '2 个章节相似度超过 80%', 'info'],
        ].map(([title, description, tone]) => <div key={title} className="check-item">{tone === 'success' ? <CheckCircle2 size={21} /> : tone === 'error' ? <XCircle size={21} /> : tone === 'warning' ? <AlertTriangle size={21} /> : <CircleAlert size={21} />}<div><h3>{title}</h3><p>{description}</p></div><Button variant="ghost" size="sm">查看结果</Button></div>)}</div> : null}
      </section>

      <Drawer open={Boolean(selected)} title={selected?.title ?? ''} subtitle={selected ? `${selected.id} · ${selected.severity}问题` : ''} onClose={() => setSelected(null)}>
        {selected ? <div className="issue-detail"><div className="issue-detail-meta"><Badge tone={selected.severity === '阻断' ? 'red' : 'amber'}>{selected.severity}</Badge><StatusBadge status={selected.status} /></div><section><h3>问题说明</h3><p>{selected.description}</p></section><section><h3>正文定位</h3><button className="location-card" onClick={() => navigate('/projects/demo/write/s32')}><span>章节</span><strong>{selected.location}</strong><ArrowRight size={15} /></button></section><section><h3>责任与进度</h3><div className="meta-list"><p><UserRound size={15} /><span>责任人</span><strong>{selected.owner}</strong></p><p><MessageSquareText size={15} /><span>创建人</span><strong>张伟</strong></p></div></section><section><h3>处理记录</h3><div className="comment-thread"><span className="avatar avatar-sm">张</span><div><strong>张伟</strong><small>今天 11:24</small><p>请补充对应的数据脱敏机制，并明确与招标要求的映射。</p></div></div></section><div className="drawer-actions"><Button variant="secondary" onClick={() => navigate('/projects/demo/write/s32')}>定位正文</Button><Button onClick={() => { closeIssue(selected.id); setSelected({ ...selected, status: '已解决' }); notify({ title: '问题已标记为解决', tone: 'success' }) }}>标记解决</Button></div></div> : null}
      </Drawer>
    </div>
  )
}
