/**
 * 全局 Toast：固定在窗口右上角，对标「绿框白字 + 对勾 + 关闭 + 底部倒计时」的提示条。
 *
 * 成功/失败都是深色玻璃底和白字；绿色或红色只用在描边、图标和倒计时条上，
 * 不要再把整块背景填成实心绿/红。底部进度条从右往左收，收完后渐隐消失。
 * 多条竖着叠放；文案过长换行，不要把卡片拉得很宽。
 *
 * 设置页应在改动写入 mediaforge-settings 并应用到 DOM 后再提示成功。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'

export type ToastKind = 'success' | 'error'

export interface ToastOptions {
  duration?: number
  actionLabel?: string
  onAction?: () => void
}

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  duration: number
  actionLabel?: string
  onAction?: () => void
}

interface ToastApi {
  success: (message: string, duration?: number) => void
  error: (message: string, durationOrOpts?: number | ToastOptions) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const DEFAULT_DURATION = 4200
const LEAVE_MS = 320

/** 提供全局 Toast。设置项应在落盘并生效后再调用 success。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [leaving, setLeaving] = useState<Record<string, true>>({})
  const seq = useRef(0)
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving

  const dismiss = useCallback((id: string) => {
    if (leavingRef.current[id]) return
    setLeaving((prev) => ({ ...prev, [id]: true }))
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id))
      setLeaving((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }, LEAVE_MS)
  }, [])

  const show = useCallback((kind: ToastKind, message: string, opts?: number | ToastOptions) => {
    const text = String(message ?? '').trim()
    if (!text) return
    const options: ToastOptions = typeof opts === 'number' ? { duration: opts } : opts || {}
    const duration = options.duration ?? DEFAULT_DURATION
    seq.current += 1
    const id = `toast-${Date.now()}-${seq.current}`
    setToasts((list) => [
      ...list,
      { id, kind, message: text, duration, actionLabel: options.actionLabel, onAction: options.onAction },
    ])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (message, duration) => show('success', message, duration),
      error: (message, durationOrOpts) => show('error', message, durationOrOpts),
      dismiss,
    }),
    [show, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastHost toasts={toasts} leaving={leaving} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

/** 读取 Toast API；必须包在 ToastProvider 内。 */
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

function ToastHost({
  toasts,
  leaving,
  onDismiss,
}: {
  toasts: ToastItem[]
  leaving: Record<string, true>
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" aria-live="polite" aria-relevant="additions">
      {toasts.map((item) => (
        <ToastCard
          key={item.id}
          item={item}
          leaving={Boolean(leaving[item.id])}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  )
}

/** 成功画对勾，失败画感叹号，颜色跟描边一致。 */
function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'error') {
    return (
      <span className="toast-icon" aria-hidden>
        <svg viewBox="0 0 20 20" width="18" height="18">
          <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 6.2v5.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="14.2" r="1.05" fill="currentColor" />
        </svg>
      </span>
    )
  }
  return (
    <span className="toast-icon" aria-hidden>
      <svg viewBox="0 0 20 20" width="18" height="18">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M6 10.2l2.4 2.4L14 7.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function ToastCard({
  item,
  leaving,
  onDismiss,
}: {
  item: ToastItem
  leaving: boolean
  onDismiss: (id: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [remain, setRemain] = useState(1)
  const [hover, setHover] = useState(false)
  const pausedRef = useRef(false)
  const leavingRef = useRef(leaving)
  const remainMs = useRef(item.duration)
  const lastTs = useRef<number | null>(null)
  leavingRef.current = leaving

  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      const prev = lastTs.current ?? now
      lastTs.current = now
      if (!pausedRef.current && !leavingRef.current) {
        remainMs.current -= now - prev
        const ratio = Math.max(0, remainMs.current / item.duration)
        setRemain(ratio)
        if (remainMs.current <= 0) {
          onDismiss(item.id)
          return
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [item.duration, item.id, onDismiss])

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = rootRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    el.style.setProperty('--spot-x', `${e.clientX - box.left}px`)
    el.style.setProperty('--spot-y', `${e.clientY - box.top}px`)
  }

  return (
    <div
      ref={rootRef}
      className={`toast toast-${item.kind}${hover ? ' is-hover' : ''}${leaving ? ' is-leaving' : ''}`}
      role={item.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => {
        pausedRef.current = true
        setHover(true)
      }}
      onMouseLeave={() => {
        pausedRef.current = false
        setHover(false)
        lastTs.current = null
      }}
      onMouseMove={onMove}
    >
      <div className="toast-sheen" aria-hidden />
      <div className="toast-body">
        <ToastIcon kind={item.kind} />
        <p className="toast-msg">{item.message}</p>
        {item.actionLabel && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              item.onAction?.()
              onDismiss(item.id)
            }}
          >
            {item.actionLabel}
          </button>
        )}
        <button
          type="button"
          className="toast-close"
          aria-label="关闭"
          onClick={() => onDismiss(item.id)}
        >
          ×
        </button>
      </div>
      <div className="toast-bar" aria-hidden>
        <div className="toast-bar-fill" style={{ transform: `scaleX(${remain})` }} />
      </div>
    </div>
  )
}
