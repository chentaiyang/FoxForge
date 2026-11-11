/**
 * 读写本机设置（localStorage 键 mediaforge-settings），并同步主题与「高级渲染」到 documentElement。
 *
 * concurrency 为 0 表示自动：min(8, max(2, hardwareConcurrency-1))。
 * 产品名变更会让设置看起来像第一次打开，主题不对时让用户再选一次即可。
 */
import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppSettings {
  theme: ThemeMode
  reduceEffects: boolean
  language: string
  /** 0 表示自动：min(8, max(2, hardwareConcurrency-1))。 */
  concurrency: number
}

const STORAGE_KEY = 'mediaforge-settings'

const defaults: AppSettings = {
  theme: 'system',
  reduceEffects: false,
  language: 'zh-CN',
  concurrency: 0,
}

/** 自动并发：min(8, max(2, hardwareConcurrency-1))。 */
export function defaultConcurrency(): number {
  const n = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.min(8, Math.max(2, n - 1))
}

/** 把设置值变成实际并发；0 或未填则走 defaultConcurrency()。Office/图片仍由主进程串行。 */
export function resolveConcurrency(value?: number): number {
  if (!value || value < 1) return defaultConcurrency()
  return Math.min(16, Math.max(1, Math.round(value)))
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaults }
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return { ...defaults }
  }
}

function applyTheme(theme: ThemeMode, reduceEffects: boolean) {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  root.dataset.theme = isDark ? 'dark' : 'light'
  root.dataset.effects = reduceEffects ? 'off' : 'on'
}

/** 读写 mediaforge-settings，并同步主题和高级渲染到 <html> 的 data 属性。 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())

  useEffect(() => {
    applyTheme(settings.theme, settings.reduceEffects)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (settings.theme === 'system') {
        applyTheme('system', settings.reduceEffects)
      }
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme, settings.reduceEffects])

  const update = useCallback((patch: Partial<AppSettings>): AppSettings => {
    let next: AppSettings = { ...defaults }
    setSettings((prev) => {
      next = { ...prev, ...patch }
      applyTheme(next.theme, next.reduceEffects)
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        /* 忽略配额 */
      }
      return next
    })
    return next
  }, [])

  const reset = useCallback((): AppSettings => {
    const next = { ...defaults }
    applyTheme(next.theme, next.reduceEffects)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* 忽略配额 */
    }
    setSettings(next)
    return next
  }, [])

  return { settings, update, reset }
}
