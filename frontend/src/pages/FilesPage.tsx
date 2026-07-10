import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { useMemo, useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePrototype } from '../context/PrototypeContext'
import type { BidFile } from '../types'
import { Badge, Button, Drawer, InlineMessage, PageHeader, ProgressBar, StatusBadge } from '../components/ui'

const ACCEPTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'zip'])

function getExtension(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? ''
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function getCategory(name: string) {
  const extension = getExtension(name)
  if (extension === 'zip') return '文件包'
  if (extension === 'xls' || extension === 'xlsx') return '评分附件'
  if (extension === 'doc' || extension === 'docx') return '技术附件'
  return '招标正文'
}

function getFileIcon(name: string) {
  const extension = getExtension(name)
  if (extension === 'xls' || extension === 'xlsx') return FileSpreadsheet
  if (extension === 'zip') return Archive
  return FileText
}

function statusLabel(status: BidFile['status']) {
  if (status === 'ready') return '解析完成'
  if (status === 'parsing') return '解析中'
  return '解析失败'
}

export function FilesPage() {
  const navigate = useNavigate()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const { files, setFiles, notify } = usePrototype()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部文件')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const previewFile = files.find((file) => file.id === previewId)
  const readyCount = files.filter((file) => file.status === 'ready').length
  const parsingCount = files.filter((file) => file.status === 'parsing').length
  const errorCount = files.filter((file) => file.status === 'error').length
  const totalPages = files.reduce((sum, file) => sum + (typeof file.pages === 'number' ? file.pages : 0), 0)
  const categories = useMemo(() => ['全部文件', ...new Set(files.map((file) => file.category))], [files])
  const filteredFiles = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.filter((file) => {
      const matchesCategory = category === '全部文件' || file.category === category
      const matchesQuery = keyword.length === 0 || `${file.name} ${file.category} ${file.owner}`.toLowerCase().includes(keyword)
      return matchesCategory && matchesQuery
    })
  }, [category, files, query])

  const completeUpload = (id: string) => {
    window.setTimeout(() => {
      setFiles((current) => current.map((file) => file.id === id
        ? { ...file, status: 'ready', pages: file.category === '评分附件' ? '3 个工作表' : 38 }
        : file))
      notify({ title: '文件解析完成', description: '已生成结构化内容与原文定位信息。', tone: 'success' })
    }, 1200)
  }

  const addFiles = (selectedFiles: File[]) => {
    const supported = selectedFiles.filter((file) => ACCEPTED_EXTENSIONS.has(getExtension(file.name)))
    const rejected = selectedFiles.length - supported.length

    if (rejected > 0) {
      notify({
        title: `${rejected} 个文件未上传`,
        description: '仅支持 PDF、DOC/DOCX、XLS/XLSX 与 ZIP 文件。',
        tone: 'error',
      })
    }
    if (supported.length === 0) return

    const now = new Date()
    const uploaded: BidFile[] = supported.map((file, index) => ({
      id: `upload-${now.getTime()}-${index}`,
      name: file.name,
      category: getCategory(file.name),
      size: formatFileSize(file.size),
      pages: '等待识别',
      version: 'V1',
      status: 'parsing',
      updatedAt: `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      owner: '张伟',
    }))

    setFiles((current) => [...uploaded, ...current])
    notify({
      title: `已接收 ${uploaded.length} 个文件`,
      description: '安全检查已通过，正在提取正文、表格与原文锚点。',
      tone: 'info',
    })
    uploaded.forEach((file) => completeUpload(file.id))
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    addFiles(Array.from(event.dataTransfer.files))
  }

  const retryFile = (id: string) => {
    const target = files.find((file) => file.id === id)
    if (!target) return
    setFiles((current) => current.map((file) => file.id === id ? { ...file, status: 'parsing' } : file))
    notify({ title: '已重新提交解析', description: `${target.name} 将从失败节点继续处理。`, tone: 'info' })
    completeUpload(id)
  }

  return (
    <div className="page page-stack files-page">
      <PageHeader
        eyebrow="项目 / 招标文件"
        title="招标文件"
        description="集中管理招标正文、技术附件、评分办法与资质材料，解析过程可恢复、可追溯。"
        actions={(
          <>
            <Button variant="secondary" icon={<ShieldCheck size={16} />} onClick={() => notify({ title: '安全检查正常', description: '当前文件均已通过扩展名、MIME 与病毒扫描策略。', tone: 'success' })}>安全检查</Button>
            <Button icon={<Upload size={16} />} onClick={() => uploadInputRef.current?.click()}>上传文件</Button>
          </>
        )}
      />

      <section className="metric-strip" aria-label="文件处理概览">
        <article className="metric-card"><span className="metric-icon metric-icon-blue"><FileText size={19} /></span><div><small>文件总数</small><strong>{files.length}</strong><p>共 {totalPages} 页可定位内容</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-green"><CheckCircle2 size={19} /></span><div><small>解析完成</small><strong>{readyCount}</strong><p>正文、表格与附件已入库</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-blue"><Clock3 size={19} /></span><div><small>处理中</small><strong>{parsingCount}</strong><p>任务可在后台继续运行</p></div></article>
        <article className="metric-card"><span className="metric-icon metric-icon-red"><AlertTriangle size={19} /></span><div><small>需要处理</small><strong>{errorCount}</strong><p>可从失败节点安全重试</p></div></article>
      </section>

      {errorCount > 0 ? (
        <InlineMessage tone="warning" title={`${errorCount} 个文件需要处理`}>
          扫描件 OCR 任务连接超时，已完成的页面不会重复解析，可直接点击“重试”。
        </InlineMessage>
      ) : null}

      <section className="panel upload-panel">
        <div
          className={`file-dropzone ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <input
            ref={uploadInputRef}
            id="bid-file-upload"
            className="sr-only"
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.xls,.xlsx,.zip"
            onChange={(event) => {
              addFiles(Array.from(event.currentTarget.files ?? []))
              event.currentTarget.value = ''
            }}
          />
          <span className="upload-icon"><Upload size={24} /></span>
          <div>
            <strong>拖拽文件到此处，或选择本地文件</strong>
            <p>支持 PDF、DOCX、XLSX、ZIP，单文件最大 200 MB；ZIP 内异常文件会单独列出。</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => uploadInputRef.current?.click()}>选择文件</Button>
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">
          <div><h2 className="panel-title">项目文件</h2><p className="panel-subtitle">{filteredFiles.length} 个结果 · 最近更新于今天 09:46</p></div>
          <div className="filter-bar compact-filter-bar">
            <label className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或上传人" /></label>
            <div className="filter-tabs" role="tablist" aria-label="文件分类">
              {categories.map((item) => <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}
            </div>
          </div>
        </header>

        <div className="table-wrap">
          <table className="data-table file-table">
            <thead><tr><th>文件名称</th><th>分类</th><th>页数 / 工作表</th><th>版本</th><th>处理状态</th><th>更新时间</th><th>上传人</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {filteredFiles.map((file) => {
                const FileIcon = getFileIcon(file.name)
                return (
                  <tr key={file.id} className={file.status === 'error' ? 'row-error' : ''}>
                    <td><div className="file-name"><span className={`file-type-icon file-${getExtension(file.name)}`}><FileIcon size={19} /></span><div><strong>{file.name}</strong><small>{file.size}</small></div></div></td>
                    <td><Badge tone="blue">{file.category}</Badge></td>
                    <td>{file.pages}</td>
                    <td><span className="version-chip">{file.version}</span></td>
                    <td>
                      <div className="status-stack">
                        <StatusBadge status={statusLabel(file.status)} />
                        {file.status === 'parsing' ? <ProgressBar value={64} /> : null}
                        {file.status === 'error' ? <small>OCR 服务连接超时</small> : null}
                      </div>
                    </td>
                    <td>{file.updatedAt}</td>
                    <td><div className="owner-cell"><span className="avatar avatar-soft">{file.owner.slice(0, 1)}</span>{file.owner}</div></td>
                    <td>
                      <div className="row-actions align-right">
                        {file.status === 'error' ? <Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => retryFile(file.id)}>重试</Button> : null}
                        <button className="icon-button" aria-label={`预览 ${file.name}`} onClick={() => setPreviewId(file.id)} disabled={file.status === 'parsing'}><Eye size={16} /></button>
                        <button className="icon-button" aria-label={`下载 ${file.name}`} onClick={() => notify({ title: '已创建安全下载链接', description: '链接将在 10 分钟后失效。', tone: 'success' })}><Download size={16} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filteredFiles.length === 0 ? <div className="empty-state"><Search size={24} /><strong>没有匹配的文件</strong><p>调整关键词或文件分类后重试。</p></div> : null}
        </div>
        <footer className="panel-footer"><span>已显示 {filteredFiles.length} / {files.length} 个文件</span><Button variant="teal" icon={<ArrowRight size={15} />} onClick={() => navigate('/projects/demo/analysis')}>继续智能解析</Button></footer>
      </section>

      <Drawer
        open={Boolean(previewFile)}
        title={previewFile?.name ?? '文件预览'}
        subtitle={previewFile ? `${previewFile.category} · ${previewFile.pages} · ${previewFile.version}` : undefined}
        onClose={() => setPreviewId(null)}
      >
        {previewFile ? (
          <div className="drawer-stack">
            <section className="drawer-section drawer-meta-grid">
              <div><small>处理状态</small><StatusBadge status={statusLabel(previewFile.status)} /></div>
              <div><small>上传人</small><strong>{previewFile.owner}</strong></div>
              <div><small>文件大小</small><strong>{previewFile.size}</strong></div>
              <div><small>更新时间</small><strong>{previewFile.updatedAt}</strong></div>
            </section>
            <section className="drawer-section">
              <header><div><h3>原文预览</h3><p>已保留页码、段落与表格坐标，可供解析结果追溯。</p></div><Badge tone="green" dot>可定位</Badge></header>
              <div className="document-preview">
                <div className="document-page-label">第 87 页 / 共 {typeof previewFile.pages === 'number' ? previewFile.pages : 286} 页</div>
                <h4>3.2 数据安全要求</h4>
                <p>投标人应充分考虑平台建设过程中的数据安全与业务连续性要求，建立覆盖数据全生命周期的安全管理机制。</p>
                <p className="source-highlight">平台须满足分级保护、传输加密、访问控制与全流程审计要求，并形成完整的制度、技术和运维保障体系。</p>
                <p>相关响应内容应在技术方案中单独成章，并提供可验证的产品能力说明与实施计划。</p>
              </div>
            </section>
            <section className="drawer-section">
              <header><div><h3>页面缩略图</h3><p>点击可快速切换原文位置。</p></div></header>
              <div className="page-thumbnails">{[85, 86, 87, 88].map((page) => <button key={page} className={page === 87 ? 'active' : ''}><FileText size={18} /><span>{page}</span></button>)}</div>
            </section>
            <div className="drawer-actions"><Button variant="secondary" onClick={() => notify({ title: '文件已加入对照视图', description: '可在智能解析页查看结构化结果与原文。', tone: 'info' })}>加入对照</Button><Button icon={<ArrowRight size={15} />} onClick={() => navigate('/projects/demo/analysis')}>查看解析结果</Button></div>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

export default FilesPage
