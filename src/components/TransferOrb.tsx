/**
 * 标题栏任务进度圆和任务列表浮层，数据来自 JobSessionContext。
 *
 * 浮层必须 createPortal(..., document.body) + useAnchoredPosition（z-index 400），
 * 否则会被标题栏/步骤条的 backdrop-filter 堆叠上下文挡住。
 * 打包中（packing）对应主进程的原子 pack/finalize：不要当成可以立刻暂停的普通步骤。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import FailureNotice from './FailureNotice'
import { useJobSession, type ConversionJob, type JobStatus } from '../hooks/JobSessionContext'
import { formatBytes } from '../data/capabilities'
import { useAnchoredPosition } from '../hooks/useAnchoredPosition'

const SIZE = 30
const STROKE = 3
const R = (SIZE - STROKE) / 2
const C = 2 * Math.PI * R

function statusLabel(s: JobStatus) {
  switch (s) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'paused':
      return '已暂停'
    case 'packing':
      return '打包中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return s
  }
}

function overallPercent(jobs: ConversionJob[]) {
  if (!jobs.length) return 0
  const active = jobs.filter((j) => j.status !== 'cancelled')
  const pool = active.length ? active : jobs
  const sum = pool.reduce((n, j) => n + (j.status === 'completed' ? 100 : j.percent || 0), 0)
  return Math.max(0, Math.min(100, sum / pool.length))
}

/** 标题栏任务进度圆与传送到 body 的任务列表。 */
export default function TransferOrb() {
  const {
    jobs,
    counts,
    queuePaused,
    popoverOpen,
    focusJobId,
    openPopover,
    closePopover,
    pauseJob,
    resumeJob,
    cancelJob,
    pauseAll,
    resumeAll,
    cancelAll,
  } = useJobSession()
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const leaveTimer = useRef<number | null>(null)
  const pos = useAnchoredPosition(visible || popoverOpen, rootRef)

  const pct = overallPercent(jobs)
  const remaining = counts.pending + counts.running
  const hasFailure = jobs.some((j) => j.status === 'failed')
  const allDone = jobs.length > 0 && counts.running === 0 && counts.pending === 0
  const ringOffset = C * (1 - pct / 100)

  useEffect(() => {
    if (popoverOpen) {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
      setLeaving(false)
      setVisible(true)
    } else if (visible) {
      setLeaving(true)
      leaveTimer.current = window.setTimeout(() => {
        setVisible(false)
        setLeaving(false)
      }, 240)
    }
  }, [popoverOpen, visible])

  useEffect(() => {
    if (!popoverOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePopover()
    }
    const onDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      closePopover()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [popoverOpen, closePopover])

  useEffect(() => {
    if (!focusJobId || !visible) return
    const el = rootRef.current?.querySelector(`[data-job-id="${CSS.escape(focusJobId)}"]`)
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' })
  }, [focusJobId, visible, jobs])

  const center = useMemo(() => {
    if (!jobs.length) return '–'
    if (hasFailure && allDone) return '!'
    if (allDone) return '✓'
    if (remaining > 0 && remaining <= 99) return String(remaining)
    return `${Math.round(pct)}`
  }, [jobs.length, hasFailure, allDone, remaining, pct])

  const stateClass = !jobs.length
    ? 'is-idle'
    : hasFailure
      ? 'is-error'
      : allDone
        ? 'is-success'
        : queuePaused
          ? 'is-paused'
          : 'is-active'

  const onOrbClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (popoverOpen) closePopover()
    else openPopover()
  }

  const canBatch = counts.running + counts.pending > 0

  return (
    <div className="transfer-orb-wrap" ref={rootRef}>
      <button
        type="button"
        className={`transfer-orb ${stateClass}`}
        onClick={onOrbClick}
        aria-label="转换任务"
        aria-expanded={popoverOpen}
        title="转换任务"
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden>
          <circle className="orb-track" cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} />
          <circle
            className="orb-ring"
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={C}
            strokeDashoffset={jobs.length ? ringOffset : C}
            strokeLinecap="round"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </svg>
        <span className="orb-center">{center}</span>
      </button>

      {visible &&
        createPortal(
        <div
          ref={popoverRef}
          className={`transfer-popover${leaving ? ' is-leaving' : ''}`}
          role="dialog"
          aria-label="转换任务"
          style={pos}
        >
          <div className="transfer-popover-head">
            <strong>转换任务</strong>
            {canBatch && (
              <div className="transfer-batch-ops">
                {queuePaused ? (
                  <button type="button" className="btn ghost btn-xs" onClick={() => void resumeAll()}>
                    全部继续
                  </button>
                ) : (
                  <button type="button" className="btn ghost btn-xs" onClick={() => void pauseAll()}>
                    全部暂停
                  </button>
                )}
                <button type="button" className="btn ghost btn-xs danger-text" onClick={() => void cancelAll()}>
                  全部取消
                </button>
              </div>
            )}
          </div>
          {jobs.length === 0 ? (
            <p className="transfer-empty">还没有转换任务</p>
          ) : (
            <ul className="transfer-list">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  data-job-id={job.id}
                  className={`transfer-item is-${job.status}${focusJobId === job.id ? ' is-focus' : ''}`}
                >
                  <div className="transfer-item-main">
                    <div className="transfer-item-title">
                      <span className="transfer-item-name" title={job.name}>
                        {job.name}
                      </span>
                      <span className={`transfer-badge is-${job.status}`}>{statusLabel(job.status)}</span>
                    </div>
                    <div className="transfer-item-sub">
                      {job.target ? `${job.target.toUpperCase()} · ` : ''}
                      {job.estimatedBytes ? `预计 ${formatBytes(job.estimatedBytes)} · ` : ''}
                      {job.label || statusLabel(job.status)}
                    </div>
                    {(job.status === 'running' || job.status === 'packing' || job.status === 'paused') && (
                      <div className="transfer-mini">
                        <div className="transfer-mini-fill" style={{ width: `${Math.min(100, job.percent)}%` }} />
                      </div>
                    )}
                    {job.status === 'failed' && (
                      <FailureNotice
                        compact
                        message={job.errorDetail || job.label}
                        code={job.errorCode}
                        detail={job.errorDetail}
                      />
                    )}
                  </div>
                  <div className="transfer-item-ops">
                    {(job.status === 'running' || job.status === 'packing' || job.status === 'queued') && (
                      <button type="button" className="icon-btn" title="暂停" onClick={() => void pauseJob(job.id)}>
                        暂停
                      </button>
                    )}
                    {job.status === 'paused' && (
                      <button type="button" className="icon-btn" title="继续" onClick={() => void resumeJob(job.id)}>
                        继续
                      </button>
                    )}
                    {(job.status === 'running' ||
                      job.status === 'packing' ||
                      job.status === 'queued' ||
                      job.status === 'paused') && (
                      <button type="button" className="icon-btn" title="取消" onClick={() => void cancelJob(job.id)}>
                        取消
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="transfer-footer">
            <span>总项目 {counts.total}</span>
            <span>已完成 {counts.completed}</span>
            <span>进行中 {counts.running}</span>
            <span>未完成 {counts.pending}</span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
