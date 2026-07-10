import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { LoadingBlock } from './components/ui'

const AnalysisPage = lazy(() => import('./pages/AnalysisPage').then((module) => ({ default: module.AnalysisPage })))
const ExportPage = lazy(() => import('./pages/ExportPage').then((module) => ({ default: module.ExportPage })))
const FilesPage = lazy(() => import('./pages/FilesPage').then((module) => ({ default: module.FilesPage })))
const NewProjectPage = lazy(() => import('./pages/NewProjectPage').then((module) => ({ default: module.NewProjectPage })))
const OutlinePage = lazy(() => import('./pages/OutlinePage').then((module) => ({ default: module.OutlinePage })))
const OverviewPage = lazy(() => import('./pages/OverviewPage').then((module) => ({ default: module.OverviewPage })))
const PlaceholderPage = lazy(() => import('./pages/PlaceholderPage').then((module) => ({ default: module.PlaceholderPage })))
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })))
const RequirementsPage = lazy(() => import('./pages/RequirementsPage').then((module) => ({ default: module.RequirementsPage })))
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((module) => ({ default: module.ReviewPage })))
const WritingPage = lazy(() => import('./pages/WritingPage').then((module) => ({ default: module.WritingPage })))

export default function App() {
  return (
    <AppShell>
      <Suspense fallback={<LoadingBlock label="正在加载业务工作区…" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/workspace" element={<PlaceholderPage type="workspace" />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/projects/demo/overview" element={<OverviewPage />} />
          <Route path="/projects/demo/files" element={<FilesPage />} />
          <Route path="/projects/demo/analysis" element={<AnalysisPage />} />
          <Route path="/projects/demo/requirements" element={<RequirementsPage />} />
          <Route path="/projects/demo/outline" element={<OutlinePage />} />
          <Route path="/projects/demo/write/:sectionId" element={<WritingPage />} />
          <Route path="/projects/demo/review" element={<ReviewPage />} />
          <Route path="/projects/demo/export" element={<ExportPage />} />
          <Route path="/projects/demo/settings" element={<PlaceholderPage type="settings" />} />
          <Route path="/projects/:projectId/files" element={<FilesPage />} />
          <Route path="/projects/:projectId/analysis" element={<AnalysisPage />} />
          <Route path="/knowledge" element={<PlaceholderPage type="knowledge" />} />
          <Route path="/templates" element={<PlaceholderPage type="templates" />} />
          <Route path="/tasks" element={<PlaceholderPage type="tasks" />} />
          <Route path="/admin" element={<PlaceholderPage type="admin" />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  )
}
