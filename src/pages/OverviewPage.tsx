import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  ListChecks,
  PenLine,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, InlineMessage, Modal, PageHeader, ProgressBar, StatusBadge } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import { project } from '../data/mock'

export function OverviewPage() {
  const navigate = useNavigate()
  const {
    files,
    requirements,
    outline,
    issues,
    candidateInserted,
    sectionSubmitted,
    sectionApproved,
    setSectionSubmitted,
    notify,
  } = usePrototype()
  const [reviewModalOpen, setReviewModalOpen] = useState(false)

  const metrics = useMemo(() => {
    const confirmed = requirements.filter((item) => item.confirmed).length
    const mapped = requirements.filter((item) => item.section !== '未映射').length
    const approved = outline.filter((item) => item.status === '已批准').length
    const openIssues = issues.filter((item) => item.status === '待处理')
    return {
      readyFiles: files.filter((item) => item.status === 'ready').length,
      errorFiles: files.filter((item) => item.status === 'error').length,
      confirmed,
      confirmationRate: Math.round((confirmed / Math.max(1, requirements.length)) * 100),
      mapped,
      mappingRate: Math.round((mapped / Math.max(1, requirements.length)) * 100),
      approved,
      chapterRate: Math.round((approved / Math.max(1, outline.length)) * 100),
      openIssues: openIssues.length,
      blockers: openIssues.filter((item) => item.severity === '阻断').length,
    }
  }, [files, issues, outline, requirements])

  const stage = sectionApproved ? '已批准' : sectionSubmitted ? '评审中' : '协同编写'

  const startReview = () => {
    setSectionSubmitted(true)
    setReviewModalOpen(false)
    notify({ title: '已发起项目评审', description: '审核人已收到待办，当前内容版本进入评审状态。', tone: 'success' })
    navigate('/projects/demo/review')
  }

  const quickActions = [
    { title: '处理解析异常', description: `${metrics.errorFiles} 个文件需要重试`, icon: FileText, tone: 'red', to: '/projects/demo/files' },
    { title: '完善响应映射', description: `${requirements.length - metrics.mapped} 项要求尚未映射`, icon: ListChecks, tone: 'amber', to: '/projects/demo/requirements' },
    { title: '继续章节编写', description: candidateInserted ? '候选内容已插入，继续完善正文' : '3.2 总体技术方案待完善', icon: PenLine, tone: 'blue', to: '/projects/demo/write/s32' },
    { title: '查看合规问题', description: `${metrics.openIssues} 个问题待处理`, icon: ShieldCheck, tone: 'teal', to: '/projects/demo/review' },
  ]

  return (
    <div className="page page-stack overview-page">
      <PageHeader
        eyebrow={`${project.code} / 项目概览`}
        title={project.name}
        description={`${project.purchaser} · ${project.package}`}
        actions={(
          <>
            <Button variant="secondary" icon={<PenLine size={16} />} onClick={() => navigate('/projects/demo/write/s32')}>继续编写</Button>
            <Button icon={<ShieldCheck size={16} />} onClick={() => setReviewModalOpen(true)}>发起项目评审</Button>
          </>
        )}
      />

      <section className="project-status-strip">
        <div><span>当前阶段</span><StatusBadge status={stage} /></div>
        <div><span>项目负责人</span><strong><i className="avatar avatar-soft">张</i>{project.owner}</strong></div>
        <div><span>投标截止</span><strong className="deadline-urgent"><CalendarClock size={16} />{project.deadline}</strong></div>
        <div><span>剩余时间</span><strong>11 天 18 小时</strong></div>
        <div><span>保密等级</span><Badge tone="red">{project.secrecy}</Badge></div>
      </section>

      {metrics.blockers > 0 ? (
        <button className="risk-banner" onClick={() => navigate('/projects/demo/review')}>
          <span><AlertTriangle size={20} /></span>
          <div><strong>存在 {metrics.blockers} 个阻断问题，当前不能正式导出</strong><p>数据安全要求尚未完整响应，点击进入评审与合规页面处理。</p></div>
          <ArrowRight size={18} />
        </button>
      ) : (
        <InlineMessage tone="success" title="正式导出门禁无阻断项">当前项目可以进入批准与正式导出流程。</InlineMessage>
      )}

      <section className="health-grid" aria-label="项目关键指标">
        <button className="health-card" onClick={() => navigate('/projects/demo/files')}>
          <span className="health-card-icon health-card-icon-blue"><FileCheck2 size={20} /></span>
          <div className="health-card-heading"><span>招标文件</span><strong>{metrics.readyFiles} / {files.length}</strong></div>
          <ProgressBar value={(metrics.readyFiles / Math.max(1, files.length)) * 100} tone={metrics.errorFiles ? 'amber' : 'green'} />
          <small>{metrics.errorFiles ? `${metrics.errorFiles} 个文件解析异常` : '全部文件解析可用'}</small>
        </button>
        <button className="health-card" onClick={() => navigate('/projects/demo/analysis')}>
          <span className="health-card-icon health-card-icon-teal"><Sparkles size={20} /></span>
          <div className="health-card-heading"><span>关键要求确认</span><strong>{metrics.confirmationRate}%</strong></div>
          <ProgressBar value={metrics.confirmationRate} tone="blue" />
          <small>{requirements.length - metrics.confirmed} 项仍需人工确认</small>
        </button>
        <button className="health-card" onClick={() => navigate('/projects/demo/requirements')}>
          <span className="health-card-icon health-card-icon-amber"><ListChecks size={20} /></span>
          <div className="health-card-heading"><span>要求映射覆盖</span><strong>{metrics.mappingRate}%</strong></div>
          <ProgressBar value={metrics.mappingRate} tone={metrics.mappingRate >= 90 ? 'green' : 'amber'} />
          <small>{metrics.mapped} / {requirements.length} 项已映射章节</small>
        </button>
        <button className="health-card" onClick={() => navigate('/projects/demo/outline')}>
          <span className="health-card-icon health-card-icon-green"><BookOpenCheck size={20} /></span>
          <div className="health-card-heading"><span>章节审核进度</span><strong>{metrics.chapterRate}%</strong></div>
          <ProgressBar value={metrics.chapterRate} tone="green" />
          <small>{metrics.approved} / {outline.length} 个章节已批准</small>
        </button>
      </section>

      <div className="overview-grid">
        <section className="panel progress-panel">
          <header className="panel-header"><div><h2>端到端进度</h2><p>按正式投标书交付门禁跟踪</p></div><Badge tone="blue">整体 68%</Badge></header>
          <div className="progress-list">
            <button className="progress-row" onClick={() => navigate('/projects/demo/files')}>
              <span className="progress-step completed"><CheckCircle2 size={17} /></span>
              <div><strong>文件导入与预处理</strong><small>3 个文件可用，1 个 OCR 文件待重试</small></div>
              <Badge tone="green">基本完成</Badge>
            </button>
            <button className="progress-row" onClick={() => navigate('/projects/demo/analysis')}>
              <span className="progress-step active"><Sparkles size={17} /></span>
              <div><strong>智能解析与人工确认</strong><small>{metrics.confirmed} / {requirements.length} 项已确认</small></div>
              <Badge tone="blue">进行中</Badge>
            </button>
            <button className="progress-row" onClick={() => navigate('/projects/demo/requirements')}>
              <span className="progress-step active"><ListChecks size={17} /></span>
              <div><strong>响应矩阵与目录映射</strong><small>{requirements.length - metrics.mapped} 项要求未映射</small></div>
              <Badge tone="amber">需处理</Badge>
            </button>
            <button className="progress-row" onClick={() => navigate('/projects/demo/write/s32')}>
              <span className="progress-step active"><PenLine size={17} /></span>
              <div><strong>章节协同编写</strong><small>5 个章节编写中，1 个章节待审核</small></div>
              <Badge tone="blue">进行中</Badge>
            </button>
            <button className="progress-row" onClick={() => navigate('/projects/demo/review')}>
              <span className="progress-step pending"><ShieldCheck size={17} /></span>
              <div><strong>评审、批准与正式导出</strong><small>{metrics.openIssues} 个问题未关闭</small></div>
              <Badge tone="neutral">未完成</Badge>
            </button>
          </div>
        </section>

        <section className="panel quick-actions-panel">
          <header className="panel-header"><div><h2>优先待办</h2><p>按交付风险和截止时间排序</p></div><Badge tone="red">4 项</Badge></header>
          <div className="quick-actions">
            {quickActions.map(({ title, description, icon: Icon, tone, to }) => (
              <button key={title} className="action-card" onClick={() => navigate(to)}>
                <span className={`action-card-icon action-card-${tone}`}><Icon size={18} /></span>
                <span><strong>{title}</strong><small>{description}</small></span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="overview-grid overview-secondary-grid">
        <section className="panel activity-panel">
          <header className="panel-header"><div><h2>最近动态</h2><p>项目关键操作与协作记录</p></div><button className="text-button" onClick={() => notify({ title: '已加载全部动态', description: '演示数据已是最新状态。', tone: 'info' })}>查看全部</button></header>
          <div className="activity-list">
            <article className="activity-item"><span className="activity-icon"><FileCheck2 size={16} /></span><div><strong>张伟替换了技术需求书</strong><p>附件1_技术需求书.docx 已更新至 V2</p><small>今天 09:44</small></div></article>
            <article className="activity-item"><span className="activity-icon"><PenLine size={16} /></span><div><strong>李明更新了 3.2 总体技术方案</strong><p>插入 AI 候选内容，并补充了 3 条来源引用</p><small>昨天 21:32</small></div></article>
            <article className="activity-item"><span className="activity-icon"><ShieldCheck size={16} /></span><div><strong>王芳提出阻断问题</strong><p>数据安全要求未完整响应</p><small>昨天 18:06</small></div></article>
          </div>
        </section>

        <section className="panel project-info-panel">
          <header className="panel-header"><div><h2>项目基线</h2><p>来自创建信息与已确认解析结果</p></div><UsersRound size={21} /></header>
          <dl className="info-list">
            <div><dt>招标编号</dt><dd>{project.tenderNo}</dd></div>
            <div><dt>预算金额</dt><dd>{project.budget}</dd></div>
            <div><dt>项目负责人</dt><dd>{project.owner}</dd></div>
            <div><dt>当前内容版本</dt><dd>V0.8.3</dd></div>
            <div><dt>默认模板</dt><dd>企业技术标标准模板 V2.3</dd></div>
          </dl>
        </section>
      </div>

      <Modal
        open={reviewModalOpen}
        title="发起项目评审"
        description="当前内容版本将进入评审状态，审核人可以创建问题并批准章节。"
        onClose={() => setReviewModalOpen(false)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setReviewModalOpen(false)}>取消</Button>
            <Button icon={<ShieldCheck size={16} />} onClick={startReview}>确认发起评审</Button>
          </>
        )}
      >
        <div className="review-summary">
          <div><span>内容版本</span><strong>V0.8.3</strong></div>
          <div><span>审核章节</span><strong>{outline.length} 个</strong></div>
          <div><span>默认审核人</span><strong>王芳、张伟</strong></div>
        </div>
        {metrics.blockers > 0 ? (
          <InlineMessage tone="warning" title={`仍有 ${metrics.blockers} 个阻断问题`}>
            可以发起评审，但阻断问题关闭前不能批准项目或生成正式版。
          </InlineMessage>
        ) : null}
        <div className="modal-note"><Clock3 size={16} /><span>发起后会通知审核人，并记录本次内容快照和操作人。</span></div>
      </Modal>
    </div>
  )
}
