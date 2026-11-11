/**
 * 跨页面的转换任务会话：队列、暂停/继续/取消，以及标题栏进度圆的弹层状态。
 *
 * 暂停会交给主进程。Windows 没有可靠 SIGSTOP，当前进程可能跑完；
 * pack/finalize 是原子的，界面上的 packing 表示「写完、校验后再处理取消」。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'packing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ConversionJob {
  id: string
  name: string
  sourcePath?: string
  target?: string
  status: JobStatus
  percent: number
  label: string
  errorCode?: string
  errorReason?: string
  errorDetail?: string
  outputPath?: string
  estimatedBytes?: number
  createdAt: number
}

export interface JobDraft {
  id: string
  name: string
  sourcePath?: string
  target?: string
  label?: string
}

export interface JobCounts {
  total: number
  completed: number
  running: number
  pending: number
  failed: number
  cancelled: number
}

interface JobSessionApi {
  jobs: ConversionJob[]
  counts: JobCounts
  queuePaused: boolean
  popoverOpen: boolean
  focusJobId: string | null
  registerJobs: (drafts: JobDraft[], opts?: { reset?: boolean }) => void
  updateJob: (id: string, patch: Partial<ConversionJob>) => void
  pauseJob: (id: string) => Promise<void>
  resumeJob: (id: string) => Promise<void>
  cancelJob: (id: string) => Promise<void>
  pauseAll: () => Promise<void>
  resumeAll: () => Promise<void>
  cancelAll: () => Promise<void>
  setQueuePaused: (paused: boolean) => void
  openPopover: (focusId?: string) => void
  closePopover: () => void
  isJobCancelled: (id: string) => boolean
  shouldHoldQueue: () => boolean
}

const JobSessionContext = createContext<JobSessionApi | null>(null)

const ACTIVE: JobStatus[] = ['queued', 'running', 'paused', 'packing']

/** 跨页保存转换队列，并把暂停/取消转发到 window.mediaForge。 */
export function JobSessionProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ConversionJob[]>([])
  const [queuePaused, setQueuePaused] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [focusJobId, setFocusJobId] = useState<string | null>(null)
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const cancelledRef = useRef(new Set<string>())
  const api = typeof window !== 'undefined' ? window.mediaForge : undefined

  const updateJob = useCallback((id: string, patch: Partial<ConversionJob>) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)))
  }, [])

  useEffect(() => {
    if (!api?.onConvertProgress) return
    return api.onConvertProgress((ev) => {
      setJobs((list) =>
        list.map((j) => {
          if (j.id !== ev.jobId) return j
          if (j.status === 'cancelled' || j.status === 'completed' || j.status === 'failed') return j
          const packing = ev.phase === 'pack' || ev.phase === 'finalize' || /打包|校验|压缩包/.test(ev.message || '')
          let status: JobStatus = j.status
          if (packing) status = 'packing'
          else if (j.status === 'queued' || j.status === 'paused') status = 'running'
          else if (j.status !== 'packing') status = 'running'
          if (j.status === 'paused' && !packing) status = 'paused'
          return {
            ...j,
            percent: ev.percent,
            label: ev.message || j.label,
            status,
            estimatedBytes: ev.estimatedBytes ?? j.estimatedBytes,
          }
        }),
      )
    })
  }, [api])

  const registerJobs = useCallback((drafts: JobDraft[], opts?: { reset?: boolean }) => {
    const now = Date.now()
    const additions: ConversionJob[] = drafts.map((d, i) => ({
      id: d.id,
      name: d.name,
      sourcePath: d.sourcePath,
      target: d.target,
      status: 'queued',
      percent: 0,
      label: d.label || '排队中',
      createdAt: now + i,
    }))
    setJobs((prev) => (opts?.reset ? additions : [...prev, ...additions]))
  }, [])

  const isJobCancelled = useCallback((id: string) => cancelledRef.current.has(id), [])

  const pauseJob = useCallback(
    async (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job) return
      if (job.status === 'queued') {
        updateJob(id, { status: 'paused', label: '已暂停' })
        setQueuePaused(true)
        return
      }
      if (job.status === 'running' || job.status === 'packing') {
        setQueuePaused(true)
        const res = await api?.pauseConvert?.(id)
        if (job.status === 'packing' || res?.deferred) {
          updateJob(id, { label: res?.message || '打包完成后暂停' })
        } else {
          updateJob(id, { status: 'paused', label: res?.message || '已暂停' })
        }
      }
    },
    [api, updateJob],
  )

  const resumeJob = useCallback(
    async (id: string) => {
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job) return
      await api?.resumeConvert?.(id)
      if (job.status === 'paused' || job.status === 'queued') {
        updateJob(id, {
          status: job.status === 'paused' && job.percent > 0 ? 'running' : 'queued',
          label: job.percent > 0 ? '继续转换…' : '排队中',
        })
      }
      setQueuePaused(false)
    },
    [api, updateJob],
  )

  const cancelJob = useCallback(
    async (id: string) => {
      cancelledRef.current.add(id)
      const job = jobsRef.current.find((j) => j.id === id)
      if (!job) {
        return
      }
      if (job.status === 'queued' || job.status === 'paused') {
        updateJob(id, { status: 'cancelled', label: '已取消', errorCode: 'E-CANCELLED', errorReason: '任务已取消' })
        return
      }
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return
      const res = await api?.cancelConvert?.(id)
      if (job.status === 'packing' || res?.deferred) {
        updateJob(id, { label: res?.message || '打包完成后取消并清理' })
      } else {
        updateJob(id, { status: 'cancelled', label: '已取消', errorCode: 'E-CANCELLED', errorReason: '任务已取消' })
      }
    },
    [api, updateJob],
  )

  const pauseAll = useCallback(async () => {
    setQueuePaused(true)
    const targets = jobsRef.current.filter((j) => ACTIVE.includes(j.status))
    for (const j of targets) await pauseJob(j.id)
  }, [pauseJob])

  const resumeAll = useCallback(async () => {
    setQueuePaused(false)
    const targets = jobsRef.current.filter((j) => j.status === 'paused' || j.status === 'running' || j.status === 'packing')
    for (const j of targets) await api?.resumeConvert?.(j.id)
    setJobs((list) =>
      list.map((j) =>
        j.status === 'paused'
          ? { ...j, status: j.percent > 0 ? 'running' : 'queued', label: j.percent > 0 ? '继续转换…' : '排队中' }
          : j,
      ),
    )
  }, [api])

  const cancelAll = useCallback(async () => {
    const targets = jobsRef.current.filter((j) => ACTIVE.includes(j.status))
    for (const j of targets) await cancelJob(j.id)
  }, [cancelJob])

  const openPopover = useCallback((focusId?: string) => {
    setFocusJobId(focusId ?? null)
    setPopoverOpen(true)
  }, [])

  const closePopover = useCallback(() => {
    setPopoverOpen(false)
  }, [])

  const shouldHoldQueue = useCallback(() => queuePaused, [queuePaused])

  const counts = useMemo<JobCounts>(() => {
    const total = jobs.length
    const completed = jobs.filter((j) => j.status === 'completed').length
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'packing').length
    const pending = jobs.filter((j) => j.status === 'queued' || j.status === 'paused').length
    const failed = jobs.filter((j) => j.status === 'failed').length
    const cancelled = jobs.filter((j) => j.status === 'cancelled').length
    return { total, completed, running, pending, failed, cancelled }
  }, [jobs])

  const value = useMemo<JobSessionApi>(
    () => ({
      jobs,
      counts,
      queuePaused,
      popoverOpen,
      focusJobId,
      registerJobs,
      updateJob,
      pauseJob,
      resumeJob,
      cancelJob,
      pauseAll,
      resumeAll,
      cancelAll,
      setQueuePaused,
      openPopover,
      closePopover,
      isJobCancelled,
      shouldHoldQueue,
    }),
    [
      jobs,
      counts,
      queuePaused,
      popoverOpen,
      focusJobId,
      registerJobs,
      updateJob,
      pauseJob,
      resumeJob,
      cancelJob,
      pauseAll,
      resumeAll,
      cancelAll,
      openPopover,
      closePopover,
      isJobCancelled,
      shouldHoldQueue,
    ],
  )

  return <JobSessionContext.Provider value={value}>{children}</JobSessionContext.Provider>
}

/** 读取任务会话；必须包在 JobSessionProvider 内。 */
export function useJobSession() {
  const ctx = useContext(JobSessionContext)
  if (!ctx) throw new Error('useJobSession must be used within JobSessionProvider')
  return ctx
}
