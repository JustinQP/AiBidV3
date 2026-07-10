import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { initialExports, initialFiles, initialIssues, initialOutline, initialRequirements } from '../data/mock'
import type { BidFile, ExportRecord, OutlineSection, Requirement, ReviewIssue } from '../types'

interface ToastMessage {
  id: number
  title: string
  description?: string
  tone?: 'success' | 'info' | 'warning' | 'error'
}

interface PrototypeState {
  files: BidFile[]
  requirements: Requirement[]
  outline: OutlineSection[]
  issues: ReviewIssue[]
  exports: ExportRecord[]
  outlineFrozen: boolean
  candidateInserted: boolean
  sectionSubmitted: boolean
  sectionApproved: boolean
}

interface PrototypeContextValue extends PrototypeState {
  toasts: ToastMessage[]
  setFiles: React.Dispatch<React.SetStateAction<BidFile[]>>
  setOutline: React.Dispatch<React.SetStateAction<OutlineSection[]>>
  updateRequirement: (id: string, patch: Partial<Requirement>) => void
  assignRequirements: (ids: string[], owner: string, section: string) => void
  setOutlineFrozen: (value: boolean) => void
  setCandidateInserted: (value: boolean) => void
  setSectionSubmitted: (value: boolean) => void
  setSectionApproved: (value: boolean) => void
  closeIssue: (id: string) => void
  reopenIssue: (id: string) => void
  addExport: (record: ExportRecord) => void
  notify: (message: Omit<ToastMessage, 'id'>) => void
  resetDemo: () => void
}

const STORAGE_KEY = 'aibid-v3-prototype-state-v1'

const defaultState: PrototypeState = {
  files: initialFiles,
  requirements: initialRequirements,
  outline: initialOutline,
  issues: initialIssues,
  exports: initialExports,
  outlineFrozen: false,
  candidateInserted: false,
  sectionSubmitted: false,
  sectionApproved: false,
}

const PrototypeContext = createContext<PrototypeContextValue | null>(null)

function loadState(): PrototypeState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? { ...defaultState, ...JSON.parse(saved) as PrototypeState } : defaultState
  } catch {
    return defaultState
  }
}

export function PrototypeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PrototypeState>(loadState)
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])

  const notify = (message: Omit<ToastMessage, 'id'>) => {
    const id = Date.now()
    setToasts((current) => [...current, { ...message, id }])
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3200)
  }

  const value = useMemo<PrototypeContextValue>(() => ({
    ...state,
    toasts,
    setFiles: (updater) => setState((current) => ({
      ...current,
      files: typeof updater === 'function' ? updater(current.files) : updater,
    })),
    setOutline: (updater) => setState((current) => ({
      ...current,
      outline: typeof updater === 'function' ? updater(current.outline) : updater,
    })),
    updateRequirement: (id, patch) => setState((current) => ({
      ...current,
      requirements: current.requirements.map((item) => item.id === id ? { ...item, ...patch } : item),
    })),
    assignRequirements: (ids, owner, section) => setState((current) => ({
      ...current,
      requirements: current.requirements.map((item) => ids.includes(item.id)
        ? { ...item, owner, section, status: '编写中', confirmed: true }
        : item),
    })),
    setOutlineFrozen: (outlineFrozen) => setState((current) => ({ ...current, outlineFrozen })),
    setCandidateInserted: (candidateInserted) => setState((current) => ({ ...current, candidateInserted })),
    setSectionSubmitted: (sectionSubmitted) => setState((current) => ({ ...current, sectionSubmitted })),
    setSectionApproved: (sectionApproved) => setState((current) => ({ ...current, sectionApproved })),
    closeIssue: (id) => setState((current) => ({
      ...current,
      issues: current.issues.map((item) => item.id === id ? { ...item, status: '已解决' } : item),
    })),
    reopenIssue: (id) => setState((current) => ({
      ...current,
      issues: current.issues.map((item) => item.id === id ? { ...item, status: '待处理' } : item),
    })),
    addExport: (record) => setState((current) => ({ ...current, exports: [record, ...current.exports] })),
    notify,
    resetDemo: () => {
      setState(defaultState)
      localStorage.removeItem(STORAGE_KEY)
      notify({ title: '演示数据已重置', description: '所有页面已恢复到初始状态。', tone: 'success' })
    },
  }), [state, toasts])

  return <PrototypeContext.Provider value={value}>{children}</PrototypeContext.Provider>
}

// The hook intentionally lives beside its provider so prototype state stays in one focused module.
// eslint-disable-next-line react-refresh/only-export-components
export function usePrototype() {
  const context = useContext(PrototypeContext)
  if (!context) throw new Error('usePrototype must be used within PrototypeProvider')
  return context
}
