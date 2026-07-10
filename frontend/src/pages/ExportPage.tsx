import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  Eye,
  FileCheck2,
  FileDown,
  FileText,
  History,
  LockKeyhole,
  RefreshCw,
  Settings2,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, InlineMessage, Modal, PageHeader, ProgressBar, Select } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'
import type { ExportRecord } from '../types'

export function ExportPage() {
  const navigate = useNavigate()
  const { requirements, outlineFrozen, issues, sectionApproved, exports, addExport, notify } = usePrototype()
  const [showConfirm, setShowConfirm] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const openBlockers = issues.filter((item) => item.severity === '阻断' && item.status === '待处理').length
  const unmappedMandatory = requirements.filter((item) => item.mandatory && item.section === '未映射').length
  const unconfirmedMandatory = requirements.filter((item) => item.mandatory && !item.confirmed).length

  const gates = useMemo(() => [
    { label: '强制要求已全部确认', passed: unconfirmedMandatory === 0, detail: unconfirmedMandatory ? `${unconfirmedMandatory} 条待确认` : '全部通过', route: '/projects/demo/analysis' },
    { label: '强制要求已映射章节', passed: unmappedMandatory === 0, detail: unmappedMandatory ? `${unmappedMandatory} 条未映射` : '全部通过', route: '/projects/demo/requirements' },
    { label: '目录基线已冻结', passed: outlineFrozen, detail: outlineFrozen ? 'V0.6' : '尚未冻结', route: '/projects/demo/outline' },
    { label: '阻断问题已关闭', passed: openBlockers === 0, detail: openBlockers ? `${openBlockers} 个待处理` : '全部通过', route: '/projects/demo/review' },
    { label: '关键章节已批准', passed: sectionApproved, detail: sectionApproved ? '已批准' : '3.2 章待批准', route: '/projects/demo/review' },
    { label: '模板预检通过', passed: true, detail: '企业技术标标准模板 V2.3', route: '/templates' },
  ], [unconfirmedMandatory, unmappedMandatory, outlineFrozen, openBlockers, sectionApproved])
  const gatePassed = gates.every((item) => item.passed)

  const downloadBlob = (record: ExportRecord) => {
    const blob = new Blob([`智标云 AiBid 原型导出文件\n${record.name}\n版本：${record.contentVersion}`], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = record.name
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const createExport = (formal: boolean) => {
    setShowConfirm(false)
    setExporting(true)
    setProgress(8)
    const steps = [24, 48, 72, 91, 100]
    steps.forEach((value, index) => window.setTimeout(() => {
      setProgress(value)
      if (value === 100) {
        const record: ExportRecord = {
          id: `EXP-${Date.now()}`,
          name: `智慧园区数字化平台建设项目_技术标_${formal ? '正式版V1.0' : '草稿V4'}.docx`,
          type: formal ? '正式版' : '草稿',
          template: '企业技术标标准模板 V2.3',
          contentVersion: formal ? 'V1.0.0' : 'V0.8.4',
          createdAt: '2026-07-10 16:48',
          owner: '张伟',
          size: formal ? '24.8 MB' : '19.1 MB',
        }
        addExport(record)
        setExporting(false)
        notify({ title: formal ? '正式投标书生成成功' : '草稿生成成功', description: '文件已加入导出历史，可立即下载。', tone: 'success' })
      }
    }, 380 * (index + 1)))
  }

  return (
    <div className="page export-page">
      <PageHeader
        eyebrow="智慧园区数字化平台建设项目"
        title="导出中心"
        description="基于批准内容快照和企业模板生成可编辑 DOCX，并保留完整导出记录。"
        actions={<><Button variant="secondary" icon={<Settings2 size={16} />} onClick={() => setShowConfig(true)}>导出设置</Button><Button variant="secondary" icon={<FileDown size={16} />} onClick={() => createExport(false)}>生成草稿</Button><Button icon={<ShieldCheck size={16} />} disabled={!gatePassed || exporting} onClick={() => setShowConfirm(true)}>生成正式版</Button></>}
      />

      {!gatePassed ? <InlineMessage tone="warning" title="正式导出门禁尚未通过">仍有 {gates.filter((item) => !item.passed).length} 项需要处理。草稿导出不受影响，正式版按钮将在全部通过后启用。</InlineMessage> : <InlineMessage tone="success" title="正式导出门禁已通过">内容版本、模板与评审状态均已锁定，可以生成正式投标书。</InlineMessage>}

      <div className="export-layout">
        <section className="export-main">
          {exporting ? <div className="export-progress-card surface"><div className="export-progress-icon"><FileText size={28} /></div><div className="export-progress-copy"><div><h2>正在生成 DOCX</h2><span>{progress}%</span></div><p>{progress < 30 ? '创建不可变内容快照…' : progress < 60 ? '装配章节、图片与表格…' : progress < 90 ? '应用标题编号和页眉页脚…' : '执行文件完整性校验…'}</p><ProgressBar value={progress} /><small>任务 EXP-20260710-1648 · 页面关闭后任务仍会继续</small></div><Button variant="ghost">查看任务</Button></div> : null}

          <section className="gate-panel surface">
            <header className="panel-header"><div><h2>正式导出门禁</h2><p>所有阻断条件通过后才能生成无水印正式版</p></div><Badge tone={gatePassed ? 'green' : 'amber'}>{gates.filter((item) => item.passed).length}/{gates.length} 已通过</Badge></header>
            <div className="gate-list">{gates.map((gate) => <div key={gate.label} className={gate.passed ? 'passed' : 'failed'}><span className="gate-icon">{gate.passed ? <Check size={16} /> : <XCircle size={16} />}</span><div><strong>{gate.label}</strong><small>{gate.detail}</small></div>{gate.passed ? <span className="gate-result">通过</span> : <button onClick={() => navigate(gate.route)}>去处理<ArrowRight size={14} /></button>}</div>)}</div>
          </section>

          <section className="export-history surface">
            <header className="panel-header"><div><h2>导出历史</h2><p>每次导出均记录内容快照、模板版本和操作人</p></div><Button size="sm" variant="ghost" icon={<RefreshCw size={14} />}>刷新</Button></header>
            <div className="table-scroll"><table className="data-table"><thead><tr><th>文件</th><th>类型</th><th>内容版本</th><th>模板</th><th>导出人</th><th>生成时间</th><th /></tr></thead><tbody>{exports.map((record) => <tr key={record.id}><td><div className="file-name-cell"><span className="docx-icon">W</span><div><strong>{record.name}</strong><small>{record.size} · SHA256 已记录</small></div></div></td><td><Badge tone={record.type === '正式版' ? 'green' : 'blue'}>{record.type}</Badge></td><td>{record.contentVersion}</td><td>{record.template}</td><td>{record.owner}</td><td>{record.createdAt}</td><td><div className="row-actions"><button title="预览"><Eye size={15} /></button><button title="下载" onClick={() => downloadBlob(record)}><Download size={15} /></button></div></td></tr>)}</tbody></table></div>
          </section>
        </section>

        <aside className="export-aside">
          <section className="surface export-config-summary"><header><h2>本次导出配置</h2><button onClick={() => setShowConfig(true)}>修改</button></header><dl><div><dt>内容版本</dt><dd>V0.8.4 · 最新批准内容</dd></div><div><dt>导出模板</dt><dd>企业技术标标准模板 V2.3</dd></div><div><dt>目录层级</dt><dd>显示至三级标题</dd></div><div><dt>页眉页脚</dt><dd>企业标准样式</dd></div><div><dt>附件规则</dt><dd>资质附件独立成册</dd></div></dl></section>
          <section className="surface export-version"><header><History size={18} /><h2>内容快照</h2></header><div className="version-node current"><i /><div><strong>V0.8.4</strong><p>36 个章节 · 128,640 字</p><small>今天 16:32 · 张伟</small></div><Badge tone="green">当前</Badge></div><div className="version-node"><i /><div><strong>V0.8.3</strong><p>关闭 2 个评审问题</p><small>昨天 21:12 · 张伟</small></div></div></section>
          <section className="export-note"><LockKeyhole size={17} /><div><strong>内容快照不可变</strong><p>导出过程中继续编辑不会影响本次文件，确保结果可审计、可复现。</p></div></section>
        </aside>
      </div>

      <Modal open={showConfirm} title="确认生成正式投标书" description="正式版不包含草稿水印，并将产生不可变导出记录。" onClose={() => setShowConfirm(false)} footer={<><Button variant="ghost" onClick={() => setShowConfirm(false)}>取消</Button><Button icon={<FileCheck2 size={16} />} onClick={() => createExport(true)}>确认生成正式版</Button></>}>
        <div className="formal-confirm"><div className="formal-file"><span className="docx-icon large">W</span><div><strong>智慧园区数字化平台建设项目_技术标_正式版V1.0.docx</strong><p>企业技术标标准模板 V2.3 · 内容版本 V1.0.0</p></div></div><div className="confirm-list"><p><CheckCircle2 size={16} />门禁检查 {gates.length}/{gates.length} 通过</p><p><CheckCircle2 size={16} />冻结内容快照与目录基线</p><p><CheckCircle2 size={16} />记录导出人、模板版本和文件哈希</p></div><div className="risk-notice"><AlertTriangle size={17} /><p>请确认本次内容已经过业务审核。正式导出不会替代投标人的最终人工复核责任。</p></div></div>
      </Modal>

      <Modal open={showConfig} title="导出设置" description="配置模板、封面、目录和附件装配规则。" onClose={() => setShowConfig(false)} width={620} footer={<><Button variant="ghost" onClick={() => setShowConfig(false)}>取消</Button><Button onClick={() => { setShowConfig(false); notify({ title: '导出设置已保存', tone: 'success' }) }}>保存设置</Button></>}>
        <div className="form-grid two"><div className="form-field full"><label>导出模板</label><Select><option>企业技术标标准模板 V2.3</option><option>智慧园区专项模板 V1.4</option></Select></div><div className="form-field"><label>目录层级</label><Select><option>显示至三级标题</option><option>显示至四级标题</option></Select></div><div className="form-field"><label>版本类型</label><Select><option>草稿版（含水印）</option><option>正式版</option></Select></div><div className="form-field"><label>页眉</label><Select><option>企业标准页眉</option><option>项目简称页眉</option></Select></div><div className="form-field"><label>页脚</label><Select><option>页码 + 保密标识</option><option>仅页码</option></Select></div></div>
      </Modal>
    </div>
  )
}
