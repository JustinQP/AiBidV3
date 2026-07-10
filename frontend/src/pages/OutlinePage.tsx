import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GripVertical,
  Link2,
  LockKeyhole,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, InlineMessage, Modal, PageHeader, ProgressBar, StatusBadge } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import type { OutlineSection } from '../types'

export function OutlinePage() {
  const navigate = useNavigate()
  const { outline, setOutline, requirements, outlineFrozen, setOutlineFrozen, notify } = usePrototype()
  const [selectedId, setSelectedId] = useState('s32')
  const [showFreeze, setShowFreeze] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const unmapped = useMemo(() => requirements.filter((item) => item.section === '未映射'), [requirements])
  const mapped = requirements.length - unmapped.length
  const selected = outline.find((item) => item.id === selectedId) ?? outline[0]

  const move = (id: string, direction: -1 | 1) => {
    if (outlineFrozen) {
      notify({ title: '目录已冻结', description: '解冻或填写变更原因后才能调整结构。', tone: 'warning' })
      return
    }
    setOutline((current) => {
      const index = current.findIndex((item) => item.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const addSection = () => {
    if (!newTitle.trim()) return
    const section: OutlineSection = {
      id: `s-${Date.now()}`,
      number: `${outline.filter((item) => item.level === 1).length + 1}`,
      title: newTitle.trim(),
      level: 1,
      owner: '未分配',
      reviewer: '张伟',
      targetWords: 3000,
      requirementCount: 0,
      status: '未开始',
    }
    setOutline((current) => [...current, section])
    setNewTitle('')
    setShowAdd(false)
    notify({ title: '已新增一级章节', description: '请继续分配编写人与映射要求。', tone: 'success' })
  }

  return (
    <div className="page outline-page">
      <PageHeader
        eyebrow="智慧园区数字化平台建设项目"
        title="目录规划"
        description="根据已确认要求规划章节结构、映射响应项并分配编写任务。"
        actions={<><Button variant="secondary" icon={<Sparkles size={16} />} onClick={() => notify({ title: '目录建议已更新', description: 'AI 根据 132 条要求生成了 3 处结构优化建议。', tone: 'success' })}>AI 优化目录</Button><Button variant="secondary" icon={<Plus size={16} />} onClick={() => setShowAdd(true)}>新增章节</Button><Button icon={<LockKeyhole size={16} />} onClick={() => setShowFreeze(true)}>{outlineFrozen ? '已冻结' : '冻结目录'}</Button></>}
      />

      <section className="outline-summary surface-flat">
        <div><span>目录版本</span><strong>V0.6</strong><small>{outlineFrozen ? '冻结于今天 14:26' : '编辑中'}</small></div>
        <div><span>章节总数</span><strong>36</strong><small>一级 6 章 · 二级 30 节</small></div>
        <div><span>要求映射</span><strong>{mapped}/{requirements.length}</strong><ProgressBar value={mapped / requirements.length * 100} tone={unmapped.length ? 'amber' : 'green'} /></div>
        <div><span>责任人覆盖</span><strong>34/36</strong><small>2 个章节待分配</small></div>
        <div className={unmapped.length ? 'summary-warning' : ''}><span>未映射强制项</span><strong>{unmapped.filter((item) => item.mandatory).length}</strong><small>冻结前必须清零</small></div>
      </section>

      {outlineFrozen ? <InlineMessage tone="success" title="目录已冻结">结构性修改会影响要求映射与章节任务，需要先记录变更原因。</InlineMessage> : null}

      <div className="outline-workspace">
        <section className="outline-tree-panel surface">
          <header className="panel-header"><div><h2>投标书目录</h2><p>拖拽或使用排序按钮调整章节</p></div><button className="text-button"><BookOpenCheck size={16} />展开全部</button></header>
          <div className="outline-column-head"><span>章节</span><span>要求</span><span>负责人 / 审核人</span><span>目标篇幅</span><span>状态</span><span /></div>
          <div className="outline-list">
            {outline.map((section) => (
              <div key={section.id} className={`outline-row ${selectedId === section.id ? 'selected' : ''} ${section.level === 2 ? 'outline-child' : ''}`} onClick={() => setSelectedId(section.id)}>
                <div className="outline-title-cell">
                  <GripVertical size={15} className="drag-handle" />
                  {section.level === 1 ? <ChevronDown size={15} /> : <ChevronRight size={14} />}
                  <span className="section-number">{section.number}</span>
                  <strong>{section.title}</strong>
                </div>
                <button className="requirement-count"><Link2 size={13} />{section.requirementCount}</button>
                <div className="assignee-cell"><span className="avatar avatar-sm">{section.owner.slice(0, 1)}</span><span>{section.owner}<small>{section.reviewer} 审核</small></span></div>
                <span className="target-words">{section.targetWords.toLocaleString()} 字</span>
                <StatusBadge status={section.status} />
                <div className="row-actions" onClick={(event) => event.stopPropagation()}><button onClick={() => move(section.id, -1)} aria-label="上移"><ArrowUp size={14} /></button><button onClick={() => move(section.id, 1)} aria-label="下移"><ArrowDown size={14} /></button></div>
              </div>
            ))}
          </div>
        </section>

        <aside className="outline-inspector surface">
          <header className="panel-header"><div><h2>章节设置</h2><p>{selected?.number} {selected?.title}</p></div></header>
          <div className="form-field"><label>章节标题</label><input value={selected?.title ?? ''} readOnly={outlineFrozen} onChange={(event) => setOutline((current) => current.map((item) => item.id === selected?.id ? { ...item, title: event.target.value } : item))} /></div>
          <div className="form-grid two"><div className="form-field"><label>编写人</label><button className="field-button"><UserRound size={15} />{selected?.owner}<ChevronDown size={14} /></button></div><div className="form-field"><label>审核人</label><button className="field-button"><UserRound size={15} />{selected?.reviewer}<ChevronDown size={14} /></button></div></div>
          <div className="form-field"><label>目标篇幅</label><div className="input-suffix"><input type="number" value={selected?.targetWords ?? 0} readOnly /><span>字</span></div></div>
          <div className="inspector-section"><div className="section-label"><span>已映射要求</span><button>管理映射</button></div><div className="mapped-requirements">{requirements.filter((item) => item.section.startsWith(selected?.number ?? '') || item.section.includes(selected?.title ?? '---')).slice(0, 3).map((item) => <button key={item.id}><span>{item.id}</span><p>{item.summary}</p><ChevronRight size={14} /></button>)}{selected?.requirementCount === 0 ? <div className="mini-empty">该章节暂未映射要求</div> : null}</div></div>
          <div className="inspector-footer"><Button variant="ghost" icon={<Trash2 size={15} />} disabled={outlineFrozen}>删除章节</Button><Button onClick={() => navigate('/projects/demo/write/s32')}>进入编写</Button></div>
        </aside>
      </div>

      {unmapped.length ? <section className="unmapped-strip"><CircleAlert size={18} /><div><strong>仍有 {unmapped.length} 条要求未映射</strong><p>其中 {unmapped.filter((item) => item.mandatory).length} 条为强制项，完成映射后才能冻结目录。</p></div><Button variant="secondary" onClick={() => navigate('/projects/demo/requirements')}>前往响应矩阵</Button></section> : null}

      <Modal open={showAdd} title="新增一级章节" description="新增后可继续创建子章节并映射招标要求。" onClose={() => setShowAdd(false)} footer={<><Button variant="ghost" onClick={() => setShowAdd(false)}>取消</Button><Button onClick={addSection}>确认新增</Button></>}>
        <div className="form-field"><label>章节名称</label><input autoFocus placeholder="例如：项目培训与知识转移" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} /></div>
      </Modal>

      <Modal open={showFreeze} title={outlineFrozen ? '目录已冻结' : '确认冻结目录'} description="冻结后目录将作为章节任务和要求映射的正式基线。" onClose={() => setShowFreeze(false)} footer={<><Button variant="ghost" onClick={() => setShowFreeze(false)}>取消</Button><Button disabled={unmapped.some((item) => item.mandatory) && !outlineFrozen} onClick={() => { setOutlineFrozen(!outlineFrozen); setShowFreeze(false); notify({ title: outlineFrozen ? '目录已解除冻结' : '目录冻结成功', description: outlineFrozen ? '现在可以调整目录结构。' : '已生成目录基线 V0.6。', tone: 'success' }) }}>{outlineFrozen ? '解除冻结' : '确认冻结'}</Button></>}>
        {unmapped.some((item) => item.mandatory) && !outlineFrozen ? <InlineMessage tone="error" title="冻结门禁未通过">存在未映射强制项，请先到响应矩阵完成章节映射。</InlineMessage> : <div className="confirm-list"><p><CheckCircle2 size={16} />所有强制要求均已映射</p><p><CheckCircle2 size={16} />章节负责人和审核人已确认</p><p><CheckCircle2 size={16} />冻结后修改将进入审计记录</p></div>}
      </Modal>
    </div>
  )
}
