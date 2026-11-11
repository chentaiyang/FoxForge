/**
 * 向主进程探测引擎健康；不在 Electron 里时回退到 capabilities 里的静态清单。
 *
 * readyCount 只统计 status === 'ready' 的项，total 是清单长度。
 * 「特殊音乐模块」永远是 optional、从不 ready，但仍计入 total，不要从分母里拿掉。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ENGINE_HEALTH } from '../data/capabilities'

export type LiveEngine = {
  id: string
  name: string
  status: 'ready' | 'missing' | 'optional'
  covers: string
  version?: string
  path?: string
  detail?: string
}

/** 探测引擎健康。readyCount 不计 optional；total 含永远 optional 的「特殊音乐模块」。 */
export function useEngineHealth() {
  const [engines, setEngines] = useState<LiveEngine[]>(ENGINE_HEALTH)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    const api = typeof window !== 'undefined' ? window.mediaForge : undefined
    if (!api?.getEngineHealth) {
      setEngines(ENGINE_HEALTH)
      setError('不在 Electron 环境，显示静态清单。')
      setLoading(false)
      return { ok: false as const, error: '不在 Electron 环境，显示静态清单。', readyCount: 0, total: ENGINE_HEALTH.length }
    }
    try {
      const list = (await api.getEngineHealth()) as LiveEngine[]
      setEngines(list)
      const readyCount = list.filter((item) => item.status === 'ready').length
      return { ok: true as const, readyCount, total: list.length }
    } catch (err) {
      const message = String(err)
      setEngines(ENGINE_HEALTH)
      setError(message)
      return { ok: false as const, error: message, readyCount: 0, total: ENGINE_HEALTH.length }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const readyCount = engines.filter((e) => e.status === 'ready').length

  const statusOf = useCallback(
    (id: string): boolean | null => {
      if (loading) return null
      return engines.find((e) => e.id === id)?.status === 'ready'
    },
    [engines, loading],
  )

  const byId = useMemo(() => {
    const map = new Map<string, LiveEngine>()
    for (const e of engines) map.set(e.id, e)
    return map
  }, [engines])

  return {
    engines,
    loading,
    error,
    refresh,
    readyCount,
    total: engines.length,
    statusOf,
    byId,
  }
}
