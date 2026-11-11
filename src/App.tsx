/**
 * 灵狐工坊壳层：无框标题栏、侧边栏和各功能页。
 * 设置、Toast、任务会话从这里向下提供，标题栏里的引擎状态和任务进度圆会用到它们。
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import ConvertPage from './pages/ConvertPage'
import VocalPage from './pages/VocalPage'
import SettingsPage from './pages/SettingsPage'
import MorePage from './pages/MorePage'
import { useSettings } from './hooks/useSettings'
import { SettingsProvider } from './hooks/SettingsContext'
import { ToastProvider } from './hooks/ToastContext'
import { JobSessionProvider } from './hooks/JobSessionContext'

/** 应用壳层。 */
export default function App() {
  const settingsApi = useSettings()

  return (
    <SettingsProvider value={settingsApi}>
      <ToastProvider>
      <JobSessionProvider>
      <div className="app-shell">
        <TitleBar />
        <div className="app-body">
          <Sidebar />
          <main className="content-pane">
            <Routes>
              <Route path="/" element={<Navigate to="/convert" replace />} />
              <Route path="/convert" element={<ConvertPage />} />
              <Route path="/vocal" element={<VocalPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/more" element={<MorePage />} />
            </Routes>
          </main>
        </div>
      </div>
      </JobSessionProvider>
      </ToastProvider>
    </SettingsProvider>
  )
}
