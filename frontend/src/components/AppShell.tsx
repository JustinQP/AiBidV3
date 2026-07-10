import {
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  ChevronLeft,
  CircleHelp,
  ClipboardCheck,
  FileOutput,
  Files,
  FolderKanban,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PenLine,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  TableProperties,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { project } from '../data/mock'
import { usePrototype } from '../context/PrototypeContext'
import { ToastViewport } from './ToastViewport'

const globalNav = [
  { label: '工作台', to: '/workspace', icon: LayoutDashboard },
  { label: '项目中心', to: '/projects', icon: FolderKanban },
  { label: '企业知识库', to: '/knowledge', icon: BookOpen },
  { label: '模板中心', to: '/templates', icon: Boxes },
  { label: '任务中心', to: '/tasks', icon: ClipboardCheck },
]

const projectNav = [
  { label: '项目概览', path: 'overview', icon: LayoutDashboard },
  { label: '招标文件', path: 'files', icon: Files },
  { label: '智能解析', path: 'analysis', icon: Bot },
  { label: '响应矩阵', path: 'requirements', icon: TableProperties },
  { label: '目录规划', path: 'outline', icon: BookOpen },
  { label: '写作工作台', path: 'write/s32', icon: PenLine },
  { label: '评审与合规', path: 'review', icon: ShieldCheck },
  { label: '导出中心', path: 'export', icon: FileOutput },
  { label: '项目设置', path: 'settings', icon: Settings },
]

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><Sparkles size={20} /></span>{compact ? null : <div><strong>智标云</strong><small>AiBid</small></div>}</div>
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { resetDemo } = usePrototype()
  const [mobileOpen, setMobileOpen] = useState(false)
  const inProject = /^\/projects\/demo\//.test(location.pathname)
  const writing = location.pathname.includes('/write/')

  return (
    <div className={`app-shell ${writing ? 'writing-shell' : ''}`}>
      <button className="mobile-menu-trigger" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu size={20} /></button>
      {mobileOpen ? <button className="mobile-nav-backdrop" onClick={() => setMobileOpen(false)} aria-label="关闭导航" /> : null}
      <aside className={`global-sidebar ${writing ? 'global-sidebar-compact' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="mobile-nav-close"><button onClick={() => setMobileOpen(false)}><X size={20} /></button></div>
        <Brand compact={writing} />
        <nav>
          {globalNav.map(({ label, to, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => isActive || (to === '/projects' && inProject) ? 'active' : ''} title={writing ? label : undefined} onClick={() => setMobileOpen(false)}>
              <Icon size={19} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="global-sidebar-bottom">
          <NavLink to="/admin" title={writing ? '企业管理' : undefined}><Building2 size={19} /><span>企业管理</span></NavLink>
          <button onClick={resetDemo} title={writing ? '重置演示' : undefined}><RotateCcw size={18} /><span>重置演示</span></button>
        </div>
      </aside>

      {inProject && !writing ? (
        <aside className="project-sidebar">
          <div className="project-switcher">
            <button onClick={() => navigate('/projects')}><ChevronLeft size={15} />返回项目中心</button>
            <h2>{project.name}</h2>
            <p>{project.code}</p>
          </div>
          <nav>
            {projectNav.map(({ label, path, icon: Icon }) => (
              <NavLink key={path} to={`/projects/demo/${path}`} className={({ isActive }) => isActive ? 'active' : ''}>
                <Icon size={18} /><span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <button className="project-collapse"><PanelLeftClose size={17} />收起项目导航</button>
        </aside>
      ) : null}

      <div className="app-main">
        {!writing ? (
          <header className="topbar">
            <div className="topbar-title">{inProject ? <><span>项目中心</span><i>/</i><strong>{project.name}</strong></> : <strong>智标云工作台</strong>}</div>
            <div className="topbar-actions">
              <button aria-label="通知"><Bell size={18} /><i className="notification-dot" /></button>
              <button aria-label="帮助"><CircleHelp size={18} /></button>
              <span className="avatar avatar-blue">张</span>
              <div className="user-name"><strong>张伟</strong><small>项目负责人</small></div>
            </div>
          </header>
        ) : null}
        <main className={writing ? 'writing-main' : 'content-main'}>{children}</main>
      </div>
      <ToastViewport />
    </div>
  )
}
