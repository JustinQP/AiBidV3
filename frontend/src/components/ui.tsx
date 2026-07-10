import { Check, ChevronDown, CircleAlert, Info, LoaderCircle, X, XCircle } from 'lucide-react'
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { Tone } from '../types'

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'teal'
  size?: 'sm' | 'md'
  icon?: ReactNode
}) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...props}>
      {icon}<span>{children}</span>
    </button>
  )
}

export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return <span className={`badge badge-${tone}`}>{dot ? <i /> : null}{children}</span>
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status.includes('批准') || status.includes('完成') || status.includes('成功') || status.includes('响应') || status.includes('解决')
    ? 'green'
    : status.includes('编写') || status.includes('解析') || status.includes('处理中')
      ? 'blue'
      : status.includes('风险') || status.includes('待') || status.includes('确认')
        ? 'amber'
        : status.includes('失败') || status.includes('阻断') || status.includes('错误')
          ? 'red'
          : 'neutral'
  return <Badge tone={tone} dot>{status}</Badge>
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  )
}

export function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'green' | 'amber' | 'red' }) {
  const normalizedValue = Math.max(0, Math.min(100, value))
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={normalizedValue}>
      <span className={`progress-${tone}`} style={{ width: `${normalizedValue}%` }} />
    </div>
  )
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className="select-wrap"><select {...props}>{children}</select><ChevronDown size={14} /></div>
}

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  closeDisabled = false,
  width = 520,
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  closeDisabled?: boolean
  width?: number
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    const focusable = dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)) : []
    ;(focusable[0] ?? dialog)?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return

      const currentFocusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      if (currentFocusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = currentFocusable[0]
      const last = currentFocusable[currentFocusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !closeDisabled && onClose()}>
      <section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ maxWidth: width }}>
        <header><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div><button className="icon-button" disabled={closeDisabled} onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="modal-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  )
}

export function Drawer({ open, title, subtitle, onClose, children }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="overlay drawer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  )
}

export function InlineMessage({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'error'; title: string; children?: ReactNode }) {
  const Icon = tone === 'success' ? Check : tone === 'warning' ? CircleAlert : tone === 'error' ? XCircle : Info
  return <div className={`inline-message inline-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon size={18} /><div><strong>{title}</strong>{children ? <p>{children}</p> : null}</div></div>
}

export function LoadingBlock({ label = '正在加载数据…' }: { label?: string }) {
  return <div className="loading-block" role="status" aria-live="polite"><LoaderCircle className="spin" size={22} /><span>{label}</span></div>
}
