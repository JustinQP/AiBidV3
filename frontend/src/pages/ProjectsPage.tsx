import {
  Archive,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  FolderKanban,
  Plus,
  Search,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, LoadingBlock, Modal, PageHeader, ProgressBar, Select } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import { useProjectList } from '../api/hooks'
import { projectRoute } from '../api/routing'
import type { Tone } from '../types'

function stageTone(stage: string): Tone {
  if (stage.includes('编写')) return 'blue'
  if (stage.includes('解析')) return 'teal'
  if (stage.includes('规划')) return 'amber'
  if (stage.includes('待上传')) return 'amber'
  if (stage.includes('进行中')) return 'blue'
  return 'neutral'
}

function riskTone(risks: number): Tone {
  if (risks >= 10) return 'red'
  if (risks >= 5) return 'amber'
  return 'green'
}

function formatDeadline(deadline: string | null): string {
  if (!deadline) return '未设置'
  const date = new Date(deadline)
  if (Number.isNaN(date.valueOf())) return deadline
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const { notify } = usePrototype()
  const { source, projects, loading, error, refresh } = useProjectList()
  const [query, setQuery] = useState('')
  const [stage, setStage] = useState('全部阶段')
  const [risk, setRisk] = useState('全部风险')
  const [archivedIds, setArchivedIds] = useState<string[]>([])
  const [archiveProjectId, setArchiveProjectId] = useState<string | null>(null)

  const activeProjects = useMemo(
    () => projects.filter((item) => item.status !== 'archived' && (source === 'api' || !archivedIds.includes(item.id))),
    [archivedIds, projects, source],
  )
  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return activeProjects.filter((item) => {
      const matchesQuery = !keyword || [item.name, item.code ?? '', item.customerName ?? '', item.ownerName ?? '']
        .some((value) => value.toLowerCase().includes(keyword))
      const matchesStage = stage === '全部阶段' || item.stage === stage
      const matchesRisk = risk === '全部风险'
        || (risk === '高风险' && item.risks !== null && item.risks >= 10)
        || (risk === '存在风险' && item.risks !== null && item.risks > 0)
      return matchesQuery && matchesStage && matchesRisk
    })
  }, [activeProjects, query, risk, stage])

  const archiveProject = source === 'mock' ? projects.find((item) => item.id === archiveProjectId) : undefined
  const deadlineMetrics = useMemo(() => {
    if (source === 'mock') return { count: 2, nearest: '07-22 09:30' }
    const now = Date.now()
    const cutoff = now + 7 * 24 * 60 * 60 * 1000
    const deadlines = activeProjects
      .map((item) => item.deadline ? new Date(item.deadline).valueOf() : Number.NaN)
      .filter((value) => Number.isFinite(value) && value >= now && value <= cutoff)
      .sort((left, right) => left - right)
    return {
      count: deadlines.length,
      nearest: deadlines[0] === undefined ? null : formatDeadline(new Date(deadlines[0]).toISOString()),
    }
  }, [activeProjects, source])

  const confirmArchive = () => {
    if (source !== 'mock' || !archiveProject) return
    setArchivedIds((current) => [...current, archiveProject.id])
    setArchiveProjectId(null)
    notify({
      title: '项目已归档',
      description: `${archiveProject.name} 已进入只读归档，可由项目负责人恢复。`,
      tone: 'success',
    })
  }

  const clearFilters = () => {
    setQuery('')
    setStage('全部阶段')
    setRisk('全部风险')
  }

  return (
    <div className="page page-stack projects-page">
      <PageHeader
        eyebrow="项目中心"
        title="投标项目"
        description="集中管理项目进度、要求覆盖和交付风险，优先处理临近截止与阻断事项。"
        actions={<Button icon={<Plus size={17} />} onClick={() => navigate('/projects/new')}>新建项目</Button>}
      />

      <section className="metric-grid" aria-label="项目概况">
        <article className="metric-card">
          <span className="metric-icon metric-icon-blue"><FolderKanban size={20} /></span>
          <div><small>{source === 'api' ? '未归档项目' : '进行中项目'}</small><strong>{loading ? '—' : activeProjects.length}</strong><p>{source === 'api' ? '来自项目服务' : '本周新增 1 个'}</p></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon metric-icon-amber"><CalendarClock size={20} /></span>
          <div><small>7 天内截止</small><strong>{loading ? '—' : deadlineMetrics.count}</strong><p>{deadlineMetrics.nearest ? `最近：${deadlineMetrics.nearest}` : '暂无临近截止项目'}</p></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon metric-icon-teal"><Users size={20} /></span>
          <div><small>待我审核</small><strong>{source === 'api' ? '—' : 6}</strong><p>{source === 'api' ? '审核指标待接入' : '3 个章节今日到期'}</p></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon metric-icon-red"><ShieldAlert size={20} /></span>
          <div><small>阻断级风险</small><strong>{source === 'api' ? '—' : 2}</strong><p>{source === 'api' ? '风险指标待接入' : '需在正式导出前关闭'}</p></div>
        </article>
      </section>

      <section className="panel projects-panel">
        <header className="panel-header">
          <div><h2>{source === 'api' ? '未归档项目' : '全部项目'}</h2><p>共 {activeProjects.length} 个{source === 'api' ? '未归档' : '进行中'}项目</p></div>
          {error
            ? <Badge tone="red" dot>加载失败</Badge>
            : <Badge tone={source === 'api' ? 'teal' : 'blue'} dot>{loading ? '正在更新' : source === 'api' ? 'API 实时数据' : '数据已更新'}</Badge>}
        </header>

        <div className="toolbar">
          <label className="search-box">
            <Search size={17} />
            <input
              aria-label="搜索项目"
              placeholder="搜索项目名称、编号、招标人或负责人"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Select aria-label="按阶段筛选" value={stage} onChange={(event) => setStage(event.target.value)}>
            <option>全部阶段</option>
            {source === 'api' ? <><option>待上传</option><option>进行中</option></> : <><option>智能解析</option><option>目录规划</option><option>协同编写</option></>}
          </Select>
          <Select aria-label="按风险筛选" value={risk} disabled={source === 'api'} title={source === 'api' ? '风险指标待接入' : undefined} onChange={(event) => setRisk(event.target.value)}>
            <option>全部风险</option>
            <option>存在风险</option>
            <option>高风险</option>
          </Select>
        </div>

        {loading ? <LoadingBlock label="正在加载项目…" /> : error ? (
          <div className="empty-state" role="alert">
            <CircleAlert size={30} />
            <h3>项目加载失败</h3>
            <p>{error.problem.detail || error.message}{error.problem.requestId ? ` · 请求编号 ${error.problem.requestId}` : ''}</p>
            <Button variant="secondary" onClick={refresh}>重新加载</Button>
          </div>
        ) : filteredProjects.length > 0 ? (
          <div className="table-scroll">
            <table className="data-table projects-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>当前阶段</th>
                  <th>负责人</th>
                  <th>投标截止</th>
                  <th>整体进度</th>
                  <th>要求覆盖</th>
                  <th>风险</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="project-cell">
                        <span className="project-avatar"><Sparkles size={18} /></span>
                        <div><strong>{item.name}</strong><small>{item.code || '未设置编码'} · {item.customerName || '未设置招标人'}</small></div>
                      </div>
                    </td>
                    <td><Badge tone={stageTone(item.stage)} dot>{item.stage}</Badge></td>
                    <td>{item.ownerName ? <span className="person-cell"><i className="avatar avatar-soft">{item.ownerName.slice(0, 1)}</i>{item.ownerName}</span> : <span className="muted-cell">未设置</span>}</td>
                    <td><span className="deadline-cell"><CalendarClock size={15} />{formatDeadline(item.deadline)}</span></td>
                    <td>
                      {item.progress === null
                        ? <span className="muted-cell">—</span>
                        : <div className="progress-cell"><span>{item.progress}%</span><ProgressBar value={item.progress} tone={item.progress >= 60 ? 'blue' : 'amber'} /></div>}
                    </td>
                    <td>{item.coverage === null ? <span className="muted-cell">—</span> : <strong className={item.coverage < 80 ? 'text-amber' : 'text-green'}>{item.coverage}%</strong>}</td>
                    <td>{item.risks === null ? <Badge tone="neutral">待接入</Badge> : <Badge tone={riskTone(item.risks)}>{item.risks} 项</Badge>}</td>
                    <td>
                      <div className="action-cluster">
                        <button className="icon-button" aria-label={`归档 ${item.name}`} title={source === 'api' ? '归档接口尚未开放' : undefined} disabled={source === 'api'} onClick={() => setArchiveProjectId(item.id)}><Archive size={16} /></button>
                        <Button size="sm" variant="ghost" icon={<ChevronRight size={16} />} onClick={() => {
                          if (source === 'api') {
                            navigate(projectRoute(item.id, 'files'))
                            return
                          }
                          if (item.id !== 'demo') notify({ title: '已切换到高保真演示项目', description: '当前原型使用统一业务数据演示完整投标闭环。', tone: 'info' })
                          navigate(projectRoute('demo', 'overview'))
                        }}>{source === 'api' ? '上传文件' : '进入项目'}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <CircleAlert size={30} />
            {activeProjects.length === 0 ? (
              <><h3>还没有投标项目</h3><p>创建第一个项目后，即可上传招标文件并开始解析。</p><Button icon={<Plus size={16} />} onClick={() => navigate('/projects/new')}>新建项目</Button></>
            ) : (
              <><h3>没有匹配的项目</h3><p>请调整搜索条件或清除筛选后重试。</p><Button variant="secondary" onClick={clearFilters}>清除筛选</Button></>
            )}
          </div>
        )}
      </section>

      <Modal
        open={Boolean(archiveProject)}
        title="归档项目"
        description="归档后项目进入只读状态，仍可由项目负责人恢复。"
        onClose={() => setArchiveProjectId(null)}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setArchiveProjectId(null)}>取消</Button>
            <Button variant="danger" icon={<Archive size={16} />} onClick={confirmArchive}>确认归档</Button>
          </>
        )}
      >
        <div className="confirm-object">
          <span className="confirm-object-icon"><FolderKanban size={22} /></span>
          <div><strong>{archiveProject?.name}</strong><p>{archiveProject?.code} · 当前阶段：{archiveProject?.stage}</p></div>
        </div>
      </Modal>
    </div>
  )
}
