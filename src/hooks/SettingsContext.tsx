/**
 * 把 useSettings() 的结果提供给整棵渲染树，避免各页各自再读一份 mediaforge-settings。
 */
import { createContext, useContext, type ReactNode } from 'react'
import type { AppSettings } from './useSettings'

interface SettingsContextValue {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => AppSettings
  reset: () => AppSettings
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({
  value,
  children,
}: {
  value: SettingsContextValue
  children: ReactNode
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

/** 读取设置上下文；必须包在 SettingsProvider 内。 */
export function useSettingsContext() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettingsContext must be used within SettingsProvider')
  return ctx
}
