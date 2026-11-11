/**
 * 标题栏引擎状态：点数和「就绪 n/总数」浮层。
 *
 * 浮层必须 createPortal(..., document.body) + useAnchoredPosition（z-index 400），
 * 否则会被标题栏/步骤条的 backdrop-filter 堆叠上下文挡住。
 *
 * 「特殊音乐模块」永远是 optional、从不 ready，但仍计入 total 分母，不要从计数里拿掉。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useEngineHealth } from '../hooks/useEngineHealth'
import { useAnchoredPosition } from '../hooks/useAnchoredPosition'

/** 标题栏引擎状态触发器与传送到 body 的浮层。 */
export default function EngineStatus() {
  const { engines, loading, readyCount, total } = useEngineHealth()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const leaveAnim = useRef<number | null>(null)
  const pos = useAnchoredPosition(open, rootRef)

  const cancelTimers = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (leaveAnim.current) {
      window.clearTimeout(leaveAnim.current)
      leaveAnim.current = null
    }
  }

  const openNow = () => {
    cancelTimers()
    setLeaving(false)
    setOpen(true)
  }

  const close = () => {
    cancelTimers()
    const reduced = document.documentElement.dataset.effects === 'off'
    if (reduced) {
      setOpen(false)
      setLeaving(false)
      return
    }
    setLeaving(true)
    leaveAnim.current = window.setTimeout(() => {
      setOpen(false)
      setLeaving(false)
    }, 180)
  }

  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => close(), 160)
  }

  useEffect(() => () => cancelTimers(), [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || popoverRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const missing = engines.filter((e) => e.status === 'missing').length
  const label = loading ? '探测中' : `引擎 ${readyCount}/${total}`

  return (
    <div
      className="title-engine"
      ref={rootRef}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={`title-engine-btn${missing ? ' is-warn' : ''}${loading ? ' is-loading' : ''}`}
        aria-label="引擎状态"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : openNow())}
      >
        <span className="title-engine-dots" aria-hidden>
          {loading
            ? Array.from({ length: Math.max(total, 8) }).map((_, i) => <i key={i} className="is-pending" />)
            : engines.map((e) => <i key={e.id} className={`is-${e.status}`} title={e.name} />)}
        </span>
        <span className="title-engine-label">{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className={`title-engine-popover${leaving ? ' is-leaving' : ''}`}
            role="dialog"
            aria-label="引擎状态"
            style={pos}
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
          >
            <div className="title-engine-head">
              <strong>引擎状态</strong>
              <span>{loading ? '正在探测…' : `${readyCount}/${total} 就绪`}</span>
            </div>
            <ul className="title-engine-list">
              {engines.map((e) => (
                <li key={e.id} className={`title-engine-item is-${e.status}`}>
                  <i />
                  <div>
                    <div className="title-engine-name">{e.name}</div>
                    <div className="title-engine-meta">
                      {e.status === 'ready' ? '就绪' : e.status === 'missing' ? '未检测到' : '可选'}
                      {e.covers ? ` · ${e.covers}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Link to="/settings" className="title-engine-foot" onClick={() => close()}>
              在设置中查看详情
            </Link>
          </div>,
          document.body,
        )}
    </div>
  )
}
