import { CheckCircle2, CircleAlert, Info, XCircle } from 'lucide-react'
import { usePrototype } from '../context/PrototypeContext'

export function ToastViewport() {
  const { toasts } = usePrototype()
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'warning' ? CircleAlert : toast.tone === 'error' ? XCircle : Info
        return <div key={toast.id} className={`toast toast-${toast.tone ?? 'info'}`}><Icon size={19} /><div><strong>{toast.title}</strong>{toast.description ? <p>{toast.description}</p> : null}</div></div>
      })}
    </div>
  )
}
