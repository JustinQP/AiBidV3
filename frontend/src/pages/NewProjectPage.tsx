import {
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  FileUp,
  FolderKanban,
  Save,
  ShieldCheck,
  Sparkles,
  UserRoundPlus,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useProjectList } from '../api/hooks'
import { projectRoute } from '../api/routing'
import { Badge, Button, InlineMessage, Modal, PageHeader, ProgressBar, Select } from '../components/ui'
import { usePrototype } from '../context/PrototypeContext'

interface ProjectDraft {
  name: string
  code: string
  purchaser: string
  tenderNo: string
  packageNo: string
  industry: string
  region: string
  budget: string
  deadline: string
  secrecy: string
  template: string
  model: string
  owner: string
  reviewer: string
  writers: string[]
}

interface CreationFailure {
  detail: string
  requestId?: string
}

const initialDraft: ProjectDraft = {
  name: '智慧园区数字化平台建设项目',
  code: 'ZHYQ-2026-017',
  purchaser: '城投数字科技有限公司',
  tenderNo: 'GZTC-2026-0421',
  packageNo: '01 包：平台软件与实施服务',
  industry: '数字政府 / 智慧园区',
  region: '广东省广州市',
  budget: '1280',
  deadline: '2026-07-22T09:30',
  secrecy: '机密',
  template: '企业技术标标准模板 V2.3',
  model: '企业写作模型（推荐）',
  owner: '张伟',
  reviewer: '王芳',
  writers: ['李明', '陈晨'],
}

const apiInitialDraft: ProjectDraft = {
  ...initialDraft,
  name: '',
  code: '',
  purchaser: '',
  tenderNo: '',
  packageNo: '',
  industry: '',
  region: '',
  budget: '',
  deadline: '',
  secrecy: '内部',
  template: '暂不选择模板',
  owner: '',
  reviewer: '',
  writers: [],
}

const steps = [
  { title: '项目信息', description: '基本信息与关键日期', icon: FolderKanban },
  { title: '模板与模型', description: '确定输出与 AI 策略', icon: Sparkles },
  { title: '成员与分工', description: '配置负责人和审核人', icon: UserRoundPlus },
]

const templates = [
  { name: '企业技术标标准模板 V2.3', meta: '标准封面 · 三级目录 · 企业页眉页脚', recommended: true },
  { name: '政企项目综合标模板 V1.8', meta: '技术商务合册 · 四级目录 · 附件清单', recommended: false },
  { name: '暂不选择模板', meta: '先完成内容规划，导出前再配置', recommended: false },
]

const availableWriters = ['李明', '陈晨', '周宁', '赵敏']

function localDateTimeToRfc3339(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!match) return null

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0'] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const date = new Date(year, month - 1, day, hour, minute, second)

  if (
    Number.isNaN(date.valueOf())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) return null

  return date.toISOString()
}

function toCreationFailure(error: unknown): CreationFailure {
  if (error instanceof ApiError) {
    return {
      detail: error.problem.detail || error.message || '请稍后重试。',
      requestId: error.problem.requestId,
    }
  }
  return { detail: error instanceof Error ? error.message : '请稍后重试。' }
}

export function NewProjectPage() {
  const navigate = useNavigate()
  const { notify } = usePrototype()
  const { source, creating, createProject } = useProjectList({ load: false })
  const mountedRef = useRef(true)
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<ProjectDraft>(() => source === 'api' ? apiInitialDraft : initialDraft)
  const [showValidation, setShowValidation] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [creationFailure, setCreationFailure] = useState<CreationFailure | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateDraft = <K extends keyof ProjectDraft>(field: K, value: ProjectDraft[K]) => {
    setCreationFailure(null)
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const requiredMissing = !draft.name.trim() || !draft.code.trim() || !draft.purchaser.trim() || !draft.deadline
  const deadlineInvalid = draft.deadline.length > 0 && localDateTimeToRfc3339(draft.deadline) === null
  const memberMissing = !draft.owner || (source === 'mock' && (!draft.reviewer || draft.writers.length === 0))

  const nextStep = () => {
    if (step === 0 && (requiredMissing || deadlineInvalid)) {
      setShowValidation(true)
      notify({ title: '请完善必填信息', description: deadlineInvalid ? '请填写有效的投标截止时间。' : '项目名称、项目编码、招标人和截止时间不能为空。', tone: 'warning' })
      return
    }
    setShowValidation(false)
    setStep((current) => Math.min(2, current + 1))
  }

  const toggleWriter = (name: string) => {
    updateDraft('writers', draft.writers.includes(name)
      ? draft.writers.filter((item) => item !== name)
      : [...draft.writers, name])
  }

  const saveDraft = () => {
    if (source === 'api') {
      notify({ title: '服务端草稿暂未接入', description: '当前内容仅在本次创建过程中保留，请完成创建后再上传文件。', tone: 'warning' })
      return
    }
    notify({ title: '草稿已保存', description: '项目配置已保存，可稍后从项目中心继续创建。', tone: 'success' })
  }

  const requestCreate = () => {
    if (deadlineInvalid) {
      setShowValidation(true)
      setStep(0)
      notify({ title: '截止时间无效', description: '请重新选择投标截止时间后再创建项目。', tone: 'warning' })
      return
    }
    if (memberMissing) {
      setShowValidation(true)
      notify({
        title: '请完成成员配置',
        description: source === 'api' ? '请选择将写入项目记录的负责人。' : '至少需要项目负责人、审核人和一名编写人。',
        tone: 'warning',
      })
      return
    }
    setCreationFailure(null)
    setConfirmOpen(true)
  }

  const confirmCreate = async () => {
    if (source === 'mock') {
      setConfirmOpen(false)
      notify({ title: '项目创建成功', description: '已建立项目空间，现在上传招标文件开始智能解析。', tone: 'success' })
      navigate(projectRoute('demo', 'files'))
      return
    }

    const deadline = localDateTimeToRfc3339(draft.deadline)
    if (!deadline) {
      setConfirmOpen(false)
      setShowValidation(true)
      setStep(0)
      notify({ title: '截止时间无效', description: '请重新选择投标截止时间。', tone: 'warning' })
      return
    }

    setCreationFailure(null)
    try {
      const created = await createProject({
        name: draft.name.trim(),
        code: draft.code.trim(),
        customerName: draft.purchaser.trim(),
        ownerName: draft.owner.trim(),
        deadline,
      })
      if (!mountedRef.current) return
      setConfirmOpen(false)
      notify({ title: '项目创建成功', description: '核心项目信息已保存，现在上传招标文件。', tone: 'success' })
      navigate(projectRoute(created.id, 'files'))
    } catch (error) {
      if (!mountedRef.current) return
      const failure = toCreationFailure(error)
      setCreationFailure(failure)
      notify({ title: '项目创建失败', description: failure.detail, tone: 'error' })
    }
  }

  return (
    <div className="page page-stack new-project-page">
      <PageHeader
        eyebrow="项目中心 / 新建项目"
        title="创建投标项目"
        description="先建立项目基线，后续解析、写作、评审和导出都将围绕该配置展开。"
        actions={<Badge tone="blue">步骤 {step + 1} / 3</Badge>}
      />

      <div className="wizard-layout">
        <aside className="wizard-sidebar panel">
          <div className="wizard-progress">
            <span>创建进度</span><strong>{Math.round(((step + 1) / 3) * 100)}%</strong>
            <ProgressBar value={((step + 1) / 3) * 100} tone="blue" />
          </div>
          <ol className="wizard-steps">
            {steps.map((item, index) => {
              const Icon = item.icon
              const state = index < step ? 'complete' : index === step ? 'active' : 'pending'
              return (
                <li key={item.title} className={`wizard-step ${state}`}>
                  <span>{index < step ? <Check size={17} /> : <Icon size={17} />}</span>
                  <button type="button" disabled={index > step} onClick={() => index < step && setStep(index)}>
                    <strong>{item.title}</strong><small>{item.description}</small>
                  </button>
                </li>
              )
            })}
          </ol>
          {source === 'api' ? (
            <InlineMessage tone="warning" title="当前持久化范围">
              本阶段仅保存项目名称、编码、招标人、负责人和截止时间；招标编号、标包、行业、地区、预算、保密等级、模板、模型、审核人和编写人暂不提交到后端。
            </InlineMessage>
          ) : (
            <InlineMessage tone="info" title="创建后仍可调整">
              模板、模型和项目成员可在项目设置中修改，关键变更会进入审计记录。
            </InlineMessage>
          )}
        </aside>

        <section className="wizard-form panel">
          {step === 0 ? (
            <>
              <header className="panel-header"><div><h2>项目信息</h2><p>带 * 的字段用于建立项目身份和截止提醒。</p></div><CalendarClock size={22} /></header>
              <div className="wizard-form-body form-grid two">
                <label className={`field field-wide ${showValidation && !draft.name.trim() ? 'field-error' : ''}`}>
                  <span>项目名称 *</span>
                  <input id="project-name" required aria-invalid={showValidation && !draft.name.trim()} aria-describedby={showValidation && !draft.name.trim() ? 'project-name-error' : undefined} value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="请输入正式项目名称" />
                  {showValidation && !draft.name.trim() ? <small id="project-name-error">请输入项目名称</small> : null}
                </label>
                <label className={`field ${showValidation && !draft.code.trim() ? 'field-error' : ''}`}>
                  <span>项目编码 *</span>
                  <input id="project-code" required aria-invalid={showValidation && !draft.code.trim()} aria-describedby={showValidation && !draft.code.trim() ? 'project-code-error' : undefined} value={draft.code} onChange={(event) => updateDraft('code', event.target.value)} />
                  {showValidation && !draft.code.trim() ? <small id="project-code-error">请输入企业内部项目编码</small> : null}
                </label>
                <label className="field">
                  <span>招标编号</span>
                  <input value={draft.tenderNo} onChange={(event) => updateDraft('tenderNo', event.target.value)} />
                </label>
                <label className={`field field-wide ${showValidation && !draft.purchaser.trim() ? 'field-error' : ''}`}>
                  <span>招标人 / 采购人 *</span>
                  <input id="project-customer" required aria-invalid={showValidation && !draft.purchaser.trim()} aria-describedby={showValidation && !draft.purchaser.trim() ? 'project-customer-error' : undefined} value={draft.purchaser} onChange={(event) => updateDraft('purchaser', event.target.value)} />
                  {showValidation && !draft.purchaser.trim() ? <small id="project-customer-error">请输入招标人或采购人</small> : null}
                </label>
                <label className="field field-wide">
                  <span>标包信息</span>
                  <input value={draft.packageNo} onChange={(event) => updateDraft('packageNo', event.target.value)} />
                </label>
                <label className="field">
                  <span>行业分类</span>
                  <input value={draft.industry} onChange={(event) => updateDraft('industry', event.target.value)} />
                </label>
                <label className="field">
                  <span>项目地区</span>
                  <input value={draft.region} onChange={(event) => updateDraft('region', event.target.value)} />
                </label>
                <label className="field">
                  <span>预算金额（万元）</span>
                  <div className="input-suffix"><input type="number" min="0" value={draft.budget} onChange={(event) => updateDraft('budget', event.target.value)} /><span>CNY</span></div>
                </label>
                <label className={`field ${showValidation && (!draft.deadline || deadlineInvalid) ? 'field-error' : ''}`}>
                  <span>投标截止时间 *</span>
                  <input id="project-deadline" type="datetime-local" required aria-invalid={showValidation && (!draft.deadline || deadlineInvalid)} aria-describedby={showValidation && (!draft.deadline || deadlineInvalid) ? 'project-deadline-error' : undefined} value={draft.deadline} onChange={(event) => updateDraft('deadline', event.target.value)} />
                  {showValidation && (!draft.deadline || deadlineInvalid) ? <small id="project-deadline-error">{deadlineInvalid ? '请选择有效的截止时间' : '请选择投标截止时间'}</small> : null}
                </label>
                <label className="field">
                  <span>保密等级</span>
                  <Select value={draft.secrecy} onChange={(event) => updateDraft('secrecy', event.target.value)}>
                    <option>内部</option><option>机密</option><option>绝密</option>
                  </Select>
                </label>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <header className="panel-header"><div><h2>模板与 AI 模型</h2><p>选择受控模板和默认模型，确保写作及导出规则一致。</p></div><Sparkles size={22} /></header>
              <div className="wizard-form-body choice-section">
                <div className="section-label"><strong>投标书模板</strong><span>后续可在项目设置中切换</span></div>
                <div className="choice-grid">
                  {templates.map((template) => (
                    <label key={template.name} className={`choice-card ${draft.template === template.name ? 'selected' : ''}`}>
                      <input type="radio" name="template" disabled={source === 'api'} checked={draft.template === template.name} onChange={() => updateDraft('template', template.name)} />
                      <span className="choice-card-icon"><FileUp size={21} /></span>
                      <span><strong>{template.name}</strong><small>{template.meta}</small></span>
                      {template.recommended ? <Badge tone="teal">推荐</Badge> : null}
                    </label>
                  ))}
                </div>
                <div className="form-grid compact-form-grid">
                  <label className="field field-wide">
                    <span>默认模型配置</span>
                    <Select value={draft.model} disabled={source === 'api'} onChange={(event) => updateDraft('model', event.target.value)}>
                      <option>企业写作模型（推荐）</option>
                      <option>高精度分析模型</option>
                      <option>私有化通用模型</option>
                    </Select>
                    <small className="field-help">{source === 'api' ? '模板与模型配置将在后续接口接入，当前不会保存。' : '用于解析、章节生成和合规检查；实际调用会记录模型与提示词版本。'}</small>
                  </label>
                </div>
                <InlineMessage tone="success" title="已启用来源追溯">
                  AI 候选内容将保留招标原文、企业资料和生成任务记录，不会直接覆盖正文。
                </InlineMessage>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <header className="panel-header"><div><h2>成员与初始分工</h2><p>项目负责人拥有目录规划、项目批准与正式导出权限。</p></div><UserRoundPlus size={22} /></header>
              <div className="wizard-form-body">
              <div className="form-grid two">
                <label className={`field ${showValidation && !draft.owner ? 'field-error' : ''}`}>
                  <span>项目负责人 *</span>
                  <Select required aria-invalid={showValidation && !draft.owner} value={draft.owner} onChange={(event) => updateDraft('owner', event.target.value)}>
                    <option value="" disabled>请选择负责人</option>
                    <option>张伟</option><option>赵敏</option><option>王芳</option>
                  </Select>
                </label>
                <label className={`field ${showValidation && source === 'mock' && !draft.reviewer ? 'field-error' : ''}`}>
                  <span>默认审核人{source === 'api' ? '（暂不保存）' : ' *'}</span>
                  <Select value={draft.reviewer} disabled={source === 'api'} onChange={(event) => updateDraft('reviewer', event.target.value)}>
                    <option value="" disabled>待后续配置</option>
                    <option>王芳</option><option>张伟</option><option>赵敏</option>
                  </Select>
                </label>
                <fieldset disabled={source === 'api'} className={`field field-wide member-picker ${showValidation && source === 'mock' && draft.writers.length === 0 ? 'field-error' : ''}`}>
                  <legend>章节编写人{source === 'api' ? '（暂不保存）' : ' *'}</legend>
                  <div className="member-options">
                    {availableWriters.map((name) => (
                      <label key={name} className={draft.writers.includes(name) ? 'selected' : ''}>
                        <input type="checkbox" checked={draft.writers.includes(name)} onChange={() => toggleWriter(name)} />
                        <i className="avatar avatar-soft">{name.slice(0, 1)}</i><span>{name}</span><Check size={15} />
                      </label>
                    ))}
                  </div>
                  {source === 'api' ? <small>成员分工接口将在后续阶段接入。</small> : showValidation && draft.writers.length === 0 ? <small>请至少选择一名章节编写人</small> : null}
                </fieldset>
              </div>

              <div className="creation-summary">
                <div><span>项目</span><strong>{draft.name}</strong><small>{draft.code} · {draft.secrecy}</small></div>
                <div><span>输出模板</span><strong>{source === 'api' ? '待后续配置' : draft.template}</strong><small>{source === 'api' ? '本阶段不保存模板与模型' : draft.model}</small></div>
                <div><span>初始团队</span><strong>{source === 'api' ? (draft.owner || '待选择负责人') : `${1 + draft.writers.length + 1} 人`}</strong><small>{source === 'api' ? '当前仅保存项目负责人' : `${draft.owner} 负责 · ${draft.reviewer} 审核`}</small></div>
              </div>
              </div>
            </>
          ) : null}

          <footer className="form-footer">
            <div>
              <Button variant="ghost" icon={<Save size={16} />} onClick={saveDraft}>保存草稿</Button>
              <Button variant="secondary" onClick={() => navigate('/projects')}>取消</Button>
            </div>
            <div>
              {step > 0 ? <Button variant="secondary" icon={<ChevronLeft size={16} />} onClick={() => setStep((current) => current - 1)}>上一步</Button> : null}
              {step < 2
                ? <Button icon={<ChevronRight size={16} />} onClick={nextStep}>下一步</Button>
                : <Button icon={<FileUp size={16} />} disabled={creating} onClick={requestCreate}>创建并上传</Button>}
            </div>
          </footer>
        </section>
      </div>

      <Modal
        open={confirmOpen}
        title="确认创建项目"
        description="创建后将建立项目空间，并进入招标文件上传流程。"
        closeDisabled={creating}
        onClose={() => { if (!creating) setConfirmOpen(false) }}
        footer={(
          <>
            <Button variant="secondary" disabled={creating} onClick={() => setConfirmOpen(false)}>返回检查</Button>
            <Button icon={<FileUp size={16} />} disabled={creating} onClick={confirmCreate}>{creating ? '正在创建…' : '确认并上传文件'}</Button>
          </>
        )}
      >
        <div className="confirm-object">
          <span className="confirm-object-icon"><ShieldCheck size={22} /></span>
          <div><strong>{draft.name}</strong><p>{draft.code} · 截止时间 {draft.deadline.replace('T', ' ')}</p></div>
        </div>
        {creationFailure ? (
          <InlineMessage tone="error" title="项目创建失败">
            {creationFailure.detail}{creationFailure.requestId ? ` 请求编号：${creationFailure.requestId}` : ''}
          </InlineMessage>
        ) : null}
        <InlineMessage tone="warning" title="AI 结果需人工确认">
          文件解析和正文生成默认均为候选结果，不会自动成为已批准内容。
        </InlineMessage>
      </Modal>
    </div>
  )
}
