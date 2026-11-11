/**
 * 格式转换工作台：投放文件、识别分组、按目标格式调用 window.mediaForge 各转换接口。
 *
 * 空投放区显示吉祥物灵灵全身；队列有文件后改回向上箭头。点击框选文件，
 * 右上角「选择文件夹」胶囊单独选目录（要点击时 stopPropagation，避免再弹出选文件）。
 * 并行度取 settings.concurrency，0 表示自动 min(8, max(2, hardwareConcurrency-1))；
 * Office 与图片仍由主进程 limiter 串行。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import ProgressMock from '../components/ProgressMock'
import StepStrip, { type WorkbenchStep } from '../components/workbench/StepStrip'
import FormatMatrix from '../components/workbench/FormatMatrix'
import {
  VIDEO_CODECS,
  PDF_ACTIONS,
  detectGroup,
  extOf,
  formatBytes,
  estimateExportBytes,
  groupById,
  targetsForFile,
  type SourceGroup,
  type ExportEstimateKind,
} from '../data/capabilities'
import { useEngineHealth } from '../hooks/useEngineHealth'
import { useToast } from '../hooks/ToastContext'
import { useJobSession, type JobDraft } from '../hooks/JobSessionContext'
import { useSettingsContext } from '../hooks/SettingsContext'
import { resolveConcurrency } from '../hooks/useSettings'
import { classifyError, shortFailureToast } from '../data/errorCatalog'
import FailureNotice from '../components/FailureNotice'

interface QueueItem {
  id: string
  name: string
  size: number
  path: string
  group: SourceGroup
  ext: string
  pdfPassword?: string
}

function makeId(name: string, size: number, idx: number) {
  return `${name}-${size}-${idx}-${Math.random().toString(36).slice(2, 8)}`
}

function pathBaseName(p: string) {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(i + 1) : norm
}

function isAvGroup(g: SourceGroup) {
  return g === 'audio' || g === 'video'
}

function isDocGroup(g: SourceGroup) {
  return g === 'document' || g === 'spreadsheet' || g === 'presentation'
}

function isPdfGroup(g: SourceGroup) {
  return g === 'pdf'
}

function isImageGroup(g: SourceGroup) {
  return g === 'image'
}

function isEbookGroup(g: SourceGroup) {
  return g === 'ebook'
}

function isArchiveGroup(g: SourceGroup) {
  return g === 'archive'
}

function isSubtitleGroup(g: SourceGroup) {
  return g === 'subtitle'
}

function isUnpackTarget(t: string) {
  const v = t.toLowerCase()
  return t === '解压' || v === 'unzip' || v === 'extract' || v === 'dir' || v === 'folder'
}

function isOcrTextTarget(t: string) {
  return ['txt', 'md', 'docx'].includes(t.toLowerCase())
}

function estimateKindForItem(item: QueueItem, target: string, pdfAction: string): ExportEstimateKind {
  if (isAvGroup(item.group)) return item.group === 'video' ? 'video' : 'audio'
  if (isDocGroup(item.group)) return 'document'
  if (isImageGroup(item.group)) return isOcrTextTarget(target) ? 'ocr' : 'image'
  if (isEbookGroup(item.group)) return 'ebook'
  if (isArchiveGroup(item.group)) return 'archive'
  if (isSubtitleGroup(item.group)) return 'subtitle'
  if (isPdfGroup(item.group)) return pdfAction === 'ocr' ? 'ocr' : 'pdf'
  return 'generic'
}

function estimateItemsBytes(items: QueueItem[], target: string, pdfAction: string): number {
  return items.reduce(
    (sum, item) => sum + estimateExportBytes(item.size || 0, estimateKindForItem(item, target, pdfAction)),
    0,
  )
}

function withEstimate(label: string, bytes?: number) {
  if (!bytes || bytes <= 0) return label
  return `${label} · 预计 ${formatBytes(bytes)}`
}

async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = cursor
        cursor += 1
        if (i >= items.length) return
        await worker(items[i], i)
      }
    }),
  )
}

function engineTagFor(item: { group: SourceGroup; path: string }) {
  if (isAvGroup(item.group)) return item.path ? ' · FFmpeg' : ' · 缺路径'
  if (isDocGroup(item.group)) return item.path ? ' · LibreOffice' : ' · 缺路径'
  if (isPdfGroup(item.group)) return item.path ? ' · PDF 引擎' : ' · 缺路径'
  if (isImageGroup(item.group)) return item.path ? ' · Sharp/OCR' : ' · 缺路径'
  if (isEbookGroup(item.group)) return item.path ? ' · Pandoc' : ' · 缺路径'
  if (isArchiveGroup(item.group)) return item.path ? ' · 压缩包' : ' · 缺路径'
  if (isSubtitleGroup(item.group)) return item.path ? ' · 字幕' : ' · 缺路径'
  if (item.group === 'specialMusic') return ' · 需外部合法工具（应用内不破解）'
  return ' · 引擎未接入'
}

/** 格式转换工作台页。 */
export default function ConvertPage() {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [videoCodec, setVideoCodec] = useState<(typeof VIDEO_CODECS)[number]['id']>('h264')
  const [pdfAction, setPdfAction] = useState<(typeof PDF_ACTIONS)[number]['id']>('convert')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [doneMsg, setDoneMsgState] = useState('')
  const [lastOutput, setLastOutput] = useState<string | null>(null)
  const [errorMsg, setErrorMsgState] = useState('')
  const [errorInfo, setErrorInfo] = useState<{
    message: string
    code?: string
    detail?: string
    jobId?: string
  } | null>(null)
  const [batchIds, setBatchIds] = useState<string[]>([])
  const toast = useToast()
  const { settings } = useSettingsContext()
  const jobSession = useJobSession()
  const jobSessionRef = useRef(jobSession)
  jobSessionRef.current = jobSession
  const setDoneMsg = (msg: string) => {
    setDoneMsgState(msg)
    if (msg) toast.success(msg)
  }
  const setErrorMsg = (msg: string, extra?: { code?: string; detail?: string; jobId?: string }) => {
    setErrorMsgState(msg)
    if (!msg) {
      setErrorInfo(null)
      return
    }
    const entry = classifyError(msg, extra?.code)
    setErrorInfo({
      message: msg,
      code: extra?.code || entry.code,
      detail: extra?.detail || msg,
      jobId: extra?.jobId,
    })
    toast.error(shortFailureToast(msg, extra?.code || entry.code), {
      actionLabel: '查看详情',
      onAction: () => jobSessionRef.current.openPopover(extra?.jobId),
    })
  }
  const [dragOver, setDragOver] = useState(false)
  const [pdfPassword, setPdfPassword] = useState('')
  const [pdfApplyPasswordToAll, setPdfApplyPasswordToAll] = useState(true)
  const { statusOf } = useEngineHealth()
  const ffmpegReady = statusOf('ffmpeg')
  const loReady = statusOf('libreoffice')
  const popplerReady = statusOf('poppler')
  const qpdfReady = statusOf('qpdf')
  const sharpReady = statusOf('sharp')
  const tesseractReady = statusOf('tesseract')
  const pandocReady = statusOf('pandoc')
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const jobIdRef = useRef<string>('')
  const batchIdsRef = useRef<string[]>([])
  const api = typeof window !== 'undefined' ? window.mediaForge : undefined

  const applyJobResult = (
    jobId: string,
    result: { ok: boolean; outputPath?: string; error?: string; errorCode?: string; errorDetail?: string },
  ) => {
    const sess = jobSessionRef.current
    if (result.ok) {
      sess.updateJob(jobId, {
        status: 'completed',
        percent: 100,
        label: '完成',
        outputPath: result.outputPath,
      })
      return
    }
    if (result.errorCode === 'E-CANCELLED' || /任务已取消/.test(result.error || '')) {
      sess.updateJob(jobId, {
        status: 'cancelled',
        label: '已取消',
        errorCode: 'E-CANCELLED',
        errorReason: '任务已取消',
        errorDetail: result.errorDetail || result.error,
      })
      return
    }
    const entry = classifyError(result.error, result.errorCode)
    sess.updateJob(jobId, {
      status: 'failed',
      label: entry.reason,
      errorCode: entry.code,
      errorReason: entry.reason,
      errorDetail: result.errorDetail || result.error,
    })
  }

  const waitIfQueuePaused = async () => {
    while (jobSessionRef.current.queuePaused) {
      const ids = batchIdsRef.current
      const allGone = ids.every((id) => {
        const j = jobSessionRef.current.jobs.find((x) => x.id === id)
        return !j || j.status === 'cancelled' || jobSessionRef.current.isJobCancelled(id)
      })
      if (allGone) break
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  const runEngineJob = async (
    draft: JobDraft,
    exec: () => Promise<{
      ok: boolean
      outputPath?: string
      error?: string
      errorCode?: string
      errorDetail?: string
      engineUsed?: string
    }>,
  ) => {
    const sess = jobSessionRef.current
    if (sess.isJobCancelled(draft.id)) {
      applyJobResult(draft.id, { ok: false, errorCode: 'E-CANCELLED', error: '任务已取消' })
      return { ok: false, errorCode: 'E-CANCELLED', error: '任务已取消' }
    }
    await waitIfQueuePaused()
    if (sess.isJobCancelled(draft.id)) {
      applyJobResult(draft.id, { ok: false, errorCode: 'E-CANCELLED', error: '任务已取消' })
      return { ok: false, errorCode: 'E-CANCELLED', error: '任务已取消' }
    }
    jobIdRef.current = draft.id
    sess.updateJob(draft.id, { status: 'running', percent: 1, label: draft.label || '转换中…' })
    const result = await exec()
    applyJobResult(draft.id, result)
    return result
  }

  useEffect(() => {
    const el = folderRef.current
    if (!el) return
    el.setAttribute('webkitdirectory', '')
    el.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    if (!api?.onConvertProgress) return
    return api.onConvertProgress((ev) => {
      const inBatch = batchIdsRef.current.includes(ev.jobId)
      if (!inBatch && ev.jobId !== jobIdRef.current) return
      if (ev.jobId === jobIdRef.current || (inBatch && batchIdsRef.current.length === 1)) {
        setProgress(ev.percent)
      }
      const est = ev.estimatedBytes
      if (ev.message) setProgressLabel(withEstimate(ev.message, est))
      else if (ev.durationSec && ev.timeSec != null) {
        setProgressLabel(withEstimate(`${ev.timeSec.toFixed(1)}s / ${ev.durationSec.toFixed(1)}s`, est))
      } else {
        setProgressLabel(withEstimate('转换中…', est))
      }
    })
  }, [api])

  const selected = useMemo(() => {
    if (!queue.length) return null
    return queue.find((q) => q.id === selectedId) ?? queue[0]
  }, [queue, selectedId])

  const targets = useMemo(() => {
    if (!selected) return [] as string[]
    const out = [...targetsForFile(selected.name)]
    if (selected.ext !== 'zip' && !out.includes('zip')) out.push('zip')
    if (selected.ext === 'zip' && !out.includes('解压')) out.unshift('解压')
    return out
  }, [selected])

  const step: WorkbenchStep = useMemo(() => {
    if (doneMsg && progress >= 100) return 'save'
    if (running || progress > 0) return 'convert'
    if (queue.length > 0) return 'detect'
    return 'select'
  }, [queue.length, running, progress, doneMsg])

  const applySelection = useCallback((item: QueueItem | null) => {
    if (!item) {
      setSelectedId(null)
      setTarget('')
      return
    }
    setSelectedId(item.id)
    const opts = targetsForFile(item.name)
    setTarget((cur) => (opts.includes(cur) ? cur : opts[0] ?? ''))
  }, [])

  const ingestPaths = useCallback(
    (paths: string[]) => {
      const clean = paths.filter(Boolean)
      if (!clean.length) return
      const additions: QueueItem[] = clean.map((p, i) => {
        const name = pathBaseName(p)
        return {
          id: makeId(name, 0, i),
          name,
          size: 0,
          path: p,
          group: detectGroup(name),
          ext: extOf(name) || '?',
        }
      })
      setQueue((prev) => {
        const wasEmpty = prev.length === 0
        const next = [...prev, ...additions]
        if (wasEmpty && additions[0]) {
          queueMicrotask(() => applySelection(additions[0]))
        }
        return next
      })
      setDoneMsg('')
      setErrorMsg('')
      setLastOutput(null)
      setProgress(0)
      setProgressLabel('')
    },
    [applySelection],
  )

  const ingestFiles = useCallback(
    (list: File[]) => {
      if (!list.length) return
      const additions: QueueItem[] = list.map((file, i) => {
        const pathFromApi = api?.getPathForFile?.(file) || ''
        const legacy = (file as File & { path?: string }).path || ''
        const filePath = pathFromApi || legacy
        return {
          id: makeId(file.name, file.size, i),
          name: file.name,
          size: file.size,
          path: filePath,
          group: detectGroup(file.name),
          ext: extOf(file.name) || '?',
        }
      })
      setQueue((prev) => {
        const wasEmpty = prev.length === 0
        const next = [...prev, ...additions]
        if (wasEmpty && additions[0]) {
          queueMicrotask(() => applySelection(additions[0]))
        }
        return next
      })
      setDoneMsg('')
      setErrorMsg('')
      setLastOutput(null)
      setProgress(0)
      setProgressLabel('')
    },
    [api, applySelection],
  )

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    ingestFiles(Array.from(e.dataTransfer.files || []))
  }

  const pickFiles = async () => {
    if (api?.openFiles) {
      const paths = await api.openFiles([
        { name: 'Media', extensions: ['*'] },
      ])
      ingestPaths(paths)
      return
    }
    inputRef.current?.click()
  }

  const moveItem = (id: string, dir: -1 | 1) => {
    setQueue((prev) => {
      const idx = prev.findIndex((x) => x.id === id)
      if (idx < 0) return prev
      const j = idx + dir
      if (j < 0 || j >= prev.length) return prev
      const copy = [...prev]
      ;[copy[idx], copy[j]] = [copy[j], copy[idx]]
      return copy
    })
  }

  const removeItem = (id: string) => {
    setQueue((prev) => {
      const next = prev.filter((x) => x.id !== id)
      if ((selectedId ?? prev[0]?.id) === id) {
        applySelection(next[0] ?? null)
      }
      return next
    })
  }

  const clearAll = () => {
    setQueue([])
    applySelection(null)
    setProgress(0)
    setProgressLabel('')
    setDoneMsg('')
    setErrorMsg('')
    setErrorInfo(null)
    setLastOutput(null)
    setRunning(false)
    setBatchIds([])
    batchIdsRef.current = []
  }

  const startConvert = async () => {
    if (!queue.length || running) return
    // PDF 专项操作可不依赖「目标格式」下拉（合并/拆分/加密）
    const pdfOpsNeedNoTarget = pdfAction !== 'convert' && pdfAction !== 'ocr'
    if (!target && !pdfOpsNeedNoTarget && selected?.group !== 'pdf') return
    if (selected?.group === 'pdf' && pdfAction === 'convert' && !target) return

    setRunning(true)
    setDoneMsg('')
    setErrorMsg('')
    setLastOutput(null)
    setProgress(0)
    setProgressLabel('准备中…') // estimate added once work items are known

    const avItems = queue.filter((q) => isAvGroup(q.group))
    const docItems = queue.filter((q) => isDocGroup(q.group))
    const pdfItems = queue.filter((q) => isPdfGroup(q.group))
    const imageItems = queue.filter((q) => isImageGroup(q.group))
    const ebookItems = queue.filter((q) => isEbookGroup(q.group))
    const archiveItems = queue.filter((q) => isArchiveGroup(q.group))
    const subtitleItems = queue.filter((q) => isSubtitleGroup(q.group))
    const otherItems = queue.filter(
      (q) =>
        !isAvGroup(q.group) &&
        !isDocGroup(q.group) &&
        !isPdfGroup(q.group) &&
        !isImageGroup(q.group) &&
        !isEbookGroup(q.group) &&
        !isArchiveGroup(q.group) &&
        !isSubtitleGroup(q.group),
    )
    const canUseFfmpeg = Boolean(api?.convertMedia) && ffmpegReady !== false
    const canUseLo = Boolean(api?.convertDocument) && loReady !== false
    const canUsePdf = Boolean(api?.convertPdf)
    const canUseSharp = Boolean(api?.convertImage) && sharpReady !== false
    const canUseOcr = Boolean(api?.convertOcr) && tesseractReady !== false
    const canUseEbook = Boolean(api?.convertEbook) && pandocReady !== false
    const canUseArchive = Boolean(api?.convertArchive)
    const canUseSubtitle = Boolean(api?.convertSubtitle)

    if (
      !avItems.length &&
      !docItems.length &&
      !pdfItems.length &&
      !imageItems.length &&
      !ebookItems.length &&
      !archiveItems.length &&
      !subtitleItems.length &&
      !(target.toLowerCase() === 'zip' && queue.some((q) => q.ext !== 'zip' && q.group !== 'archive'))
    ) {
      const special = queue.some((q) => q.group === 'specialMusic')
      setProgress(100)
      setRunning(false)
      setProgressLabel('')
      if (special) {
        setErrorMsg('特殊音乐：需外部合法工具处理你有权使用的文件；应用内不内置破解/解密。未执行任何转换。', { code: 'E-SPECIAL-MUSIC' })
      } else {
        setErrorMsg(
          `「${selected?.group ?? '该类型'}」引擎未接入。音视频→FFmpeg；Office→LibreOffice；PDF→Poppler/qpdf/pdf-lib；图片→Sharp；OCR→Tesseract；电子书→Pandoc；字幕/压缩包→内置。`,
          { code: 'E-ENGINE-UNAVAILABLE' },
        )
      }
      return
    }

    if (avItems.length && !canUseFfmpeg) {
      setRunning(false)
      setProgress(0)
      setErrorMsg(
        ffmpegReady === false
          ? '未检测到 FFmpeg。请安装并加入 PATH，或放入 resources/bin 后重启。'
          : '当前不在 Electron 环境，无法调用本机 FFmpeg。请用 npm run dev 启动桌面端。',
        { code: ffmpegReady === false ? 'E-FFMPEG-MISSING' : 'E-ENGINE-UNAVAILABLE' },
      )
      return
    }
    if (docItems.length && !canUseLo) {
      setRunning(false)
      setProgress(0)
      setErrorMsg(
        loReady === false
          ? '未检测到 LibreOffice（soffice）。请安装并加入 PATH，或放入 resources/bin。开发机可运行: node scripts/ensure-libreoffice.mjs'
          : '当前不在 Electron 环境，无法调用本机 LibreOffice。请用 npm run dev 启动桌面端。',
        { code: loReady === false ? 'E-LO-MISSING' : 'E-ENGINE-UNAVAILABLE' },
      )
      return
    }
    if (pdfItems.length && !canUsePdf) {
      setRunning(false)
      setProgress(0)
      setErrorMsg('当前不在 Electron 环境，无法调用本机 PDF 引擎。请用 npm run dev 启动桌面端。', { code: 'E-ENGINE-UNAVAILABLE' })
      return
    }
    if (imageItems.length && !canUseSharp) {
      // 图片只做 OCR 输出文本时不需要 Sharp
      const onlyOcr =
        imageItems.length > 0 &&
        !avItems.length &&
        !docItems.length &&
        !pdfItems.length &&
        isOcrTextTarget(target)
      if (!onlyOcr) {
        setRunning(false)
        setProgress(0)
        setErrorMsg(
          sharpReady === false
            ? '未检测到 Sharp。请 npm install sharp（需允许 install scripts）后重启。'
            : '当前不在 Electron 环境，无法调用本机图片引擎。请用 npm run dev 启动桌面端。',
          { code: sharpReady === false ? 'E-IMAGE-SHARP' : 'E-ENGINE-UNAVAILABLE' },
        )
        return
      }
    }
    const needsOcr =
      (pdfItems.length && pdfAction === 'ocr') ||
      (imageItems.length > 0 && isOcrTextTarget(target) && !avItems.length && !docItems.length)
    if (needsOcr && !canUseOcr) {
      setRunning(false)
      setProgress(0)
      setErrorMsg(
        tesseractReady === false
          ? '未检测到 Tesseract OCR（或缺少 chi_sim/eng 语言包）。请安装 tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng，或运行 node scripts/ensure-tesseract.mjs。'
          : '当前不在 Electron 环境，无法调用本机 OCR。请用 npm run dev 启动桌面端。',
        { code: tesseractReady === false ? 'E-OCR-MISSING' : 'E-ENGINE-UNAVAILABLE' },
      )
      return
    }
    if (ebookItems.length && !canUseEbook) {
      // pdf/docx 可能仍要 LibreOffice；电子书核心路径缺 Pandoc 才是硬失败
      setRunning(false)
      setProgress(0)
      setErrorMsg(
        pandocReady === false
          ? '未检测到 Pandoc。请安装并加入 PATH，或放入 resources/bin。开发机可运行: node scripts/ensure-pandoc.mjs --install'
          : '当前不在 Electron 环境，无法调用本机电子书引擎。请用 npm run dev 启动桌面端。',
        { code: pandocReady === false ? 'E-EBOOK-PANDOC' : 'E-ENGINE-UNAVAILABLE' },
      )
      return
    }
    if (pdfItems.length && (pdfAction === 'encrypt' || pdfAction === 'decrypt')) {
      if (pdfApplyPasswordToAll && !pdfPassword) {
        setRunning(false)
        setProgress(0)
        setErrorMsg('加密/解密需要填写密码。', { code: 'E-PDF-PASSWORD' })
        return
      }
      if (!pdfApplyPasswordToAll) {
        const missingPwd = pdfItems.find((q) => !q.pdfPassword)
        if (missingPwd) {
          setRunning(false)
          setProgress(0)
          setErrorMsg(
            `请为「${missingPwd.name}」填写密码，或勾选「其他加密 PDF 都使用此密码」。`,
            { code: 'E-PDF-PASSWORD' },
          )
          return
        }
      }
    }
    if (pdfItems.length && pdfAction === 'merge' && pdfItems.length < 2) {
      setRunning(false)
      setProgress(0)
      setErrorMsg('合并至少需要队列中有 2 个 PDF。', { code: 'E-PDF-MERGE-MIN' })
      return
    }


    const wantPackZip =
      target.toLowerCase() === 'zip' &&
      queue.some((q) => q.ext !== 'zip') &&
      !isUnpackTarget(target)

    if ((archiveItems.length || wantPackZip) && !canUseArchive) {
      setRunning(false)
      setProgress(0)
      setErrorMsg('当前不在 Electron 环境，无法调用本机压缩包引擎。请用 npm run dev 启动桌面端。', { code: 'E-ENGINE-UNAVAILABLE' })
      return
    }
    if (subtitleItems.length && !canUseSubtitle) {
      setRunning(false)
      setProgress(0)
      setErrorMsg('当前不在 Electron 环境，无法调用本机字幕引擎。请用 npm run dev 启动桌面端。', { code: 'E-ENGINE-UNAVAILABLE' })
      return
    }

    // 多文件 / 非 zip → 打一个 ZIP
    if (wantPackZip) {
      const packItems = queue.filter((q) => q.ext !== 'zip')
      const missing = packItems.find((q) => !q.path)
      if (missing) {
        setRunning(false)
        setErrorMsg(`文件「${missing.name}」没有本地路径。请用「选择文件」对话框添加。`, { code: 'E-PATH-MISSING' })
        return
      }
      if (!packItems.length) {
        setRunning(false)
        setErrorMsg('没有可打包的文件。', { code: 'E-ARCHIVE' })
        return
      }
      const jobId = `job-${Date.now()}-zip`
      const draft = {
        id: jobId,
        name: packItems.length === 1 ? packItems[0].name : `打包 ${packItems.length} 个文件`,
        target: 'zip',
        sourcePath: packItems[0].path,
        label: withEstimate(
          `打包 ${packItems.length} 个文件 → ZIP…`,
          estimateExportBytes(packItems.reduce((s, q) => s + (q.size || 0), 0), 'archive', packItems.length),
        ),
      }
      batchIdsRef.current = [jobId]
      setBatchIds([jobId])
      jobSessionRef.current.setQueuePaused(false)
      jobSessionRef.current.registerJobs([draft])
      setProgressLabel(draft.label!)
      const result = await runEngineJob(draft, () =>
        api!.convertArchive({
          jobId,
          inputPath: packItems[0].path,
          inputPaths: packItems.map((q) => q.path),
          target: 'zip',
        }),
      )
      setRunning(false)
      if (!result.ok || !result.outputPath) {
        if (result.errorCode !== 'E-CANCELLED') {
          setErrorMsg(result.error || '打包失败', {
            code: result.errorCode,
            detail: result.errorDetail || result.error,
            jobId,
          })
        }
        setProgressLabel(result.errorCode === 'E-CANCELLED' ? '已取消' : '')
        return
      }
      setLastOutput(result.outputPath)
      setProgress(100)
      setProgressLabel('完成')
      setDoneMsg(`已打包 ${packItems.length} 个文件 → ZIP → ${result.outputPath}`)
      return
    }

    const workItems = [...avItems, ...docItems, ...pdfItems, ...imageItems, ...ebookItems, ...archiveItems, ...subtitleItems]

    const missingPath = workItems.find((q) => !q.path)
    if (missingPath) {
      setRunning(false)
      setErrorMsg(
        `文件「${missingPath.name}」没有本地路径。请用「选择文件」对话框添加（不要只用无路径的浏览器文件）。`,
        { code: 'E-PATH-MISSING' },
      )
      return
    }

    const outputs: string[] = []
    const notes: string[] = []
    let failed: string | null = null

    // 合并 PDF 是覆盖队列里全部 PDF 的一个任务
    if (pdfItems.length && pdfAction === 'merge') {
      const jobId = `job-${Date.now()}-merge`
      const draft = {
        id: jobId,
        name: `合并 ${pdfItems.length} 个 PDF`,
        target: 'pdf',
        sourcePath: pdfItems[0].path,
        label: withEstimate(`合并 ${pdfItems.length} 个 PDF…`, estimateItemsBytes(pdfItems, 'pdf', 'merge')),
      }
      batchIdsRef.current = [jobId]
      setBatchIds([jobId])
      jobSessionRef.current.setQueuePaused(false)
      jobSessionRef.current.registerJobs([draft])
      setProgressLabel(draft.label!)
      const result = await runEngineJob(draft, () =>
        api!.convertPdf({
          jobId,
          inputPath: pdfItems[0].path,
          inputPaths: pdfItems.map((q) => q.path),
          action: 'merge',
          target: 'pdf',
          password: (pdfApplyPasswordToAll ? pdfPassword : pdfItems[0].pdfPassword) || undefined,
        }),
      )
      setRunning(false)
      if (!result.ok || !result.outputPath) {
        if (result.errorCode !== 'E-CANCELLED') {
          setErrorMsg(result.error || '合并失败', {
            code: result.errorCode,
            detail: result.errorDetail || result.error,
            jobId,
          })
        }
        setProgressLabel(result.errorCode === 'E-CANCELLED' ? '已取消' : '')
        return
      }
      setLastOutput(result.outputPath)
      setProgress(100)
      setProgressLabel('完成')
      setDoneMsg(`pdf-lib 合并完成 → ${result.outputPath}`)
      return
    }

    // Multi/single image → one PDF（队列里若只有图片且目标 PDF）
    if (
      imageItems.length &&
      target.toLowerCase() === 'pdf' &&
      !avItems.length &&
      !docItems.length &&
      !pdfItems.length
    ) {
      const missingImg = imageItems.find((q) => !q.path)
      if (missingImg) {
        setRunning(false)
        setErrorMsg(`文件「${missingImg.name}」没有本地路径。请用「选择文件」对话框添加。`, { code: 'E-PATH-MISSING' })
        return
      }
      const jobId = `job-${Date.now()}-imgpdf`
      const label = withEstimate(
        imageItems.length === 1
          ? `图片→PDF：${imageItems[0].name}`
          : `多图合并 PDF（${imageItems.length}）…`,
        estimateItemsBytes(imageItems, 'pdf', pdfAction),
      )
      const draft = {
        id: jobId,
        name: imageItems.length === 1 ? imageItems[0].name : `图片合并 PDF（${imageItems.length}）`,
        target: 'pdf',
        sourcePath: imageItems[0].path,
        label,
      }
      batchIdsRef.current = [jobId]
      setBatchIds([jobId])
      jobSessionRef.current.setQueuePaused(false)
      jobSessionRef.current.registerJobs([draft])
      setProgressLabel(label)
      const result = await runEngineJob(draft, () =>
        api!.convertImage({
          jobId,
          inputPath: imageItems[0].path,
          inputPaths: imageItems.map((q) => q.path),
          target: 'pdf',
        }),
      )
      setRunning(false)
      if (!result.ok || !result.outputPath) {
        if (result.errorCode !== 'E-CANCELLED') {
          setErrorMsg(result.error || '图片→PDF 失败', {
            code: result.errorCode,
            detail: result.errorDetail || result.error,
            jobId,
          })
        }
        setProgressLabel(result.errorCode === 'E-CANCELLED' ? '已取消' : '')
        return
      }
      setLastOutput(result.outputPath)
      setProgress(100)
      setProgressLabel('完成')
      const skipped =
        otherItems.length + avItems.length + docItems.length + pdfItems.length > 0
          ? `；其它类型 ${otherItems.length + avItems.length + docItems.length + pdfItems.length} 个已跳过（本次仅处理图片→PDF）`
          : ''
      setDoneMsg(
        `Sharp + pdf-lib：${imageItems.length} 张图 → PDF → ${result.outputPath}${skipped}`,
      )
      return
    }


    // 图片 OCR → txt/md/docx
    if (
      imageItems.length &&
      isOcrTextTarget(target) &&
      !avItems.length &&
      !docItems.length &&
      !pdfItems.length
    ) {
      const missingImg = imageItems.find((q) => !q.path)
      if (missingImg) {
        setRunning(false)
        setErrorMsg(`文件「${missingImg.name}」没有本地路径。请用「选择文件」对话框添加。`, { code: 'E-PATH-MISSING' })
        return
      }
      const outputs: string[] = []
      let failed: string | null = null
      let failedMeta: { code?: string; detail?: string; jobId?: string } | undefined
      const stamp = Date.now()
      const drafts = imageItems.map((item, i) => ({
        id: `job-${stamp}-ocr-${i}`,
        name: item.name,
        sourcePath: item.path,
        target: target.toLowerCase(),
        label: `OCR ${i + 1}/${imageItems.length}（Tesseract）：${item.name}`,
      }))
      batchIdsRef.current = drafts.map((d) => d.id)
      setBatchIds(batchIdsRef.current)
      jobSessionRef.current.setQueuePaused(false)
      jobSessionRef.current.registerJobs(drafts)
      const concurrency = resolveConcurrency(settings.concurrency)
      const totalEst = estimateItemsBytes(imageItems, target, pdfAction)
      let done = 0
      setProgressLabel(withEstimate(`并行 OCR（${Math.min(concurrency, imageItems.length)} 路）`, totalEst))
      await runPool(imageItems, concurrency, async (item, i) => {
        const draft = drafts[i]
        const result = await runEngineJob(draft, () =>
          api!.convertOcr({
            jobId: draft.id,
            inputPath: item.path,
            target: target.toLowerCase(),
          }),
        )
        done += 1
        if (!result.ok || !result.outputPath) {
          if (!failed) {
            failed = result.error || `OCR 失败：${item.name}`
            failedMeta = { code: result.errorCode, detail: result.errorDetail || result.error, jobId: draft.id }
          }
        } else {
          outputs.push(result.outputPath)
        }
        setProgress((done / imageItems.length) * 100)
        setProgressLabel(withEstimate(`已完成 ${done}/${imageItems.length}：${item.name}`, totalEst))
      })
      setRunning(false)
      if (failed) {
        if (failedMeta?.code !== 'E-CANCELLED') setErrorMsg(failed, failedMeta)
        setProgressLabel(failedMeta?.code === 'E-CANCELLED' ? '已取消' : '')
        return
      }
      setLastOutput(outputs[outputs.length - 1] || null)
      setProgress(100)
      setProgressLabel('完成')
      setDoneMsg(`Tesseract OCR：${outputs.length} 个文件 → ${target.toUpperCase()}`)
      return
    }

    const total = workItems.length
    const stamp = Date.now()
    const drafts = workItems.map((item, i) => {
      const itemTarget =
        targetsForFile(item.name).includes(target) ? target : targetsForFile(item.name)[0] || target
      return {
        id: `job-${stamp}-${i}`,
        name: item.name,
        sourcePath: item.path,
        target: itemTarget,
        label: withEstimate(
          `转换 ${i + 1}/${total}：${item.name}`,
          estimateExportBytes(item.size || 0, estimateKindForItem(item, itemTarget, pdfAction)),
        ),
      }
    })
    batchIdsRef.current = drafts.map((d) => d.id)
    setBatchIds(batchIdsRef.current)
    jobSessionRef.current.setQueuePaused(false)
    jobSessionRef.current.registerJobs(drafts)
    let failedMeta: { code?: string; detail?: string; jobId?: string } | undefined
    const concurrency = resolveConcurrency(settings.concurrency)
    const totalEst = estimateItemsBytes(workItems, target, pdfAction)
    let done = 0
    setProgressLabel(
      withEstimate(
        workItems.length > 1
          ? `并行转换（${Math.min(concurrency, total)} 路）共 ${total} 个文件`
          : `转换：${workItems[0].name}`,
        totalEst,
      ),
    )
    await runPool(workItems, concurrency, async (item, i) => {
      const jobId = drafts[i].id
      const itemTarget = drafts[i].target || target

      let engine = '引擎'
      if (isAvGroup(item.group)) engine = 'FFmpeg'
      else if (isDocGroup(item.group)) engine = 'LibreOffice'
      else if (isImageGroup(item.group)) engine = 'Sharp'
      else if (isEbookGroup(item.group)) engine = 'Pandoc'
      else if (isArchiveGroup(item.group)) engine = '压缩包'
      else if (isSubtitleGroup(item.group)) engine = '字幕'
      else if (isPdfGroup(item.group)) {
        if (pdfAction === 'ocr') engine = 'Tesseract OCR'
        else if (pdfAction === 'encrypt' || pdfAction === 'decrypt') engine = 'qpdf'
        else if (pdfAction === 'split') engine = 'pdf-lib'
        else if (['png', 'jpg', 'jpeg', 'txt'].includes(itemTarget)) engine = 'Poppler'
        else if (itemTarget === 'webp') engine = 'Poppler+Sharp'
        else engine = 'PDF/LibreOffice'
      }

      const result = await runEngineJob(drafts[i], async () => {
        if (isAvGroup(item.group)) {
          return api!.convertMedia({
            jobId,
            inputPath: item.path,
            target: itemTarget,
            videoCodec:
              item.group === 'video' || ['mp4', 'mkv', 'webm', 'mov'].includes(itemTarget)
                ? videoCodec
                : undefined,
          })
        }
        if (isDocGroup(item.group)) {
          return api!.convertDocument({
            jobId,
            inputPath: item.path,
            target: itemTarget,
          })
        }
        if (isImageGroup(item.group)) {
          if (isOcrTextTarget(itemTarget)) {
            return api!.convertOcr({
              jobId,
              inputPath: item.path,
              target: itemTarget,
            })
          }
          return api!.convertImage({
            jobId,
            inputPath: item.path,
            target: itemTarget,
          })
        }
        if (isEbookGroup(item.group)) {
          return api!.convertEbook({
            jobId,
            inputPath: item.path,
            target: itemTarget,
          })
        }
        if (isArchiveGroup(item.group)) {
          return api!.convertArchive({
            jobId,
            inputPath: item.path,
            target: itemTarget,
          })
        }
        if (isSubtitleGroup(item.group)) {
          return api!.convertSubtitle({
            jobId,
            inputPath: item.path,
            target: itemTarget,
          })
        }
        return api!.convertPdf({
          jobId,
          inputPath: item.path,
          target: itemTarget,
          action: pdfAction,
          password: (pdfApplyPasswordToAll ? pdfPassword : item.pdfPassword || pdfPassword) || undefined,
        })
      })
      if (result.engineUsed) engine = result.engineUsed

      done += 1
      if (!result.ok || !result.outputPath) {
        if (!failed) {
          failed = result.error || `转换失败：${item.name}`
          failedMeta = { code: result.errorCode, detail: result.errorDetail || result.error, jobId }
        }
      } else {
        outputs.push(result.outputPath)
        notes.push(engine)
      }
      setProgress((done / total) * 100)
      setProgressLabel(withEstimate(`已完成 ${done}/${total}（${engine}）：${item.name}`, totalEst))
    })

    setRunning(false)
    if (failed) {
      if (failedMeta?.code !== 'E-CANCELLED') setErrorMsg(failed, failedMeta)
      setProgressLabel(failedMeta?.code === 'E-CANCELLED' ? '已取消' : '')
      return
    }

    const last = outputs[outputs.length - 1] || null
    setLastOutput(last)
    setProgress(100)
    setProgressLabel('完成')
    const enginesUsed = Array.from(new Set(notes)).join(' + ')
    const extra =
      otherItems.length > 0
        ? `；另有 ${otherItems.length} 个其它类型已跳过（引擎未接入）`
        : ''
    const targetLabel =
      pdfItems.length && pdfAction !== 'convert' ? pdfAction.toUpperCase() : target.toUpperCase()
    setDoneMsg(`${enginesUsed} 完成：${outputs.length} 个文件 → ${targetLabel}${extra}`)
  }

  const primaryGroup = selected?.group
  const primaryMeta = primaryGroup ? groupById(primaryGroup) : undefined
  const showVideoCodec =
    primaryGroup === 'video' || target === 'mp4' || target === 'webm' || target === 'mkv' || target === 'mov'
  const showPdfActions = primaryGroup === 'pdf'
  const showSpecialLegal = queue.some((q) => q.group === 'specialMusic')
  const activeId = selected?.id
  const avInQueue = queue.some((q) => isAvGroup(q.group))
  const docInQueue = queue.some((q) => isDocGroup(q.group))
  const pdfInQueue = queue.some((q) => isPdfGroup(q.group))
  const imageInQueue = queue.some((q) => isImageGroup(q.group))
  const ebookInQueue = queue.some((q) => isEbookGroup(q.group))
  const archiveInQueue = queue.some((q) => isArchiveGroup(q.group))
  const subtitleInQueue = queue.some((q) => isSubtitleGroup(q.group))
  const exportEstimateBytes = useMemo(() => {
    const items = queue.filter(
      (q) =>
        isAvGroup(q.group) ||
        isDocGroup(q.group) ||
        isPdfGroup(q.group) ||
        isImageGroup(q.group) ||
        isEbookGroup(q.group) ||
        isArchiveGroup(q.group) ||
        isSubtitleGroup(q.group),
    )
    if (!items.length) return 0
    return estimateItemsBytes(items, target, pdfAction)
  }, [queue, target, pdfAction])
  const needPdfPassword = pdfInQueue && (pdfAction === 'encrypt' || pdfAction === 'decrypt')
  const batchJobs = jobSession.jobs.filter((j) => batchIds.includes(j.id))
  const canPauseBatch =
    running &&
    !jobSession.queuePaused &&
    batchJobs.some((j) => j.status === 'running' || j.status === 'packing' || j.status === 'queued')
  const canResumeBatch =
    running &&
    (jobSession.queuePaused || batchJobs.some((j) => j.status === 'paused'))
  const canCancelBatch = running && batchJobs.some((j) =>
    j.status === 'queued' || j.status === 'running' || j.status === 'paused' || j.status === 'packing',
  )

  const pauseBatch = () => {
    jobSession.setQueuePaused(true)
    for (const id of batchIds) void jobSession.pauseJob(id)
  }
  const resumeBatch = () => {
    jobSession.setQueuePaused(false)
    for (const id of batchIds) void jobSession.resumeJob(id)
  }
  const cancelBatch = () => {
    for (const id of batchIds) void jobSession.cancelJob(id)
  }

  return (
    <div className="page page-wide">
      <header className="page-header">
        <div>
          <h1>格式转换工作台</h1>
          <p>拖入文件，选择目标格式，在本机完成转换。引擎状态在标题栏进度圆左侧。</p>
        </div>
      </header>

      <StepStrip active={step} />

      <section className="workbench panel">
        <div className="workbench-main">
          <div
            className={`dropzone workbench-drop${dragOver ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => void pickFiles()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && void pickFiles()}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                ingestFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                ingestFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="drop-folder-btn"
              onClick={(e) => {
                e.stopPropagation()
                folderRef.current?.click()
              }}
            >
              选择文件夹
            </button>
            {/* 空队列展示灵灵全身；有文件后改回向上箭头。点击框选文件，右上角胶囊选文件夹。 */}
            {queue.length === 0 ? (
              <img className="dropzone-mascot" src="/mascot-full.png" alt="灵灵" />
            ) : (
              <div className="dropzone-icon">↑</div>
            )}
            <h3>点击选择文件，或拖放到此处</h3>
            <p>支持多文件批量；右上角可以一次导入整个文件夹。</p>
          </div>

          {queue.length > 0 && (
            <div className="batch-list">
              <div className="batch-list-head">
                <strong>批量队列 · {queue.length}</strong>
                <div className="batch-list-tools">
                  <span className="muted">点击选中；可上下调整顺序</span>
                  <button type="button" className="btn ghost btn-xs danger-text" onClick={clearAll}>
                    清空队列
                  </button>
                </div>
              </div>
              <ul>
                {queue.map((item, idx) => {
                  const g = groupById(item.group)
                  const engineTag = engineTagFor(item)
                  return (
                    <li key={item.id} className={item.id === activeId ? 'active' : ''}>
                      <button type="button" className="batch-select" onClick={() => applySelection(item)}>
                        <span className="batch-idx">{idx + 1}</span>
                        <span className="batch-meta">
                          <span className="batch-name">{item.name}</span>
                          <span className="batch-sub">
                            .{item.ext} · {g?.title ?? '未知类型'}
                            {item.size ? ` · ${formatBytes(item.size)}` : ''}
                            {item.group === 'specialMusic' ? ' · 特殊音乐' : ''}
                            {engineTag}
                          </span>
                        </span>
                      </button>
                      <div className="batch-ops">
                        <button type="button" className="icon-btn" title="上移" onClick={() => moveItem(item.id, -1)}>
                          ↑
                        </button>
                        <button type="button" className="icon-btn" title="下移" onClick={() => moveItem(item.id, 1)}>
                          ↓
                        </button>
                        <button type="button" className="icon-btn" title="移除" onClick={() => removeItem(item.id)}>
                          ×
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>

        <aside className="workbench-aside">
          <h3>转换设置</h3>

          {!selected ? (
            <p className="hint">先选择文件后会显示可用目标格式。</p>
          ) : (
            <>
              <div className="detect-card">
                <div className="detect-label">已识别</div>
                <strong>
                  {primaryMeta?.title ?? '未知'} · .{selected.ext}
                </strong>
                <p className="muted">{selected.name}</p>
                {selected.path ? (
                  <p className="muted" style={{ wordBreak: 'break-all' }}>
                    {selected.path}
                  </p>
                ) : (
                  <p className="muted">无本地路径 — 请用「选择文件」重加</p>
                )}
              </div>

              <label className="field">
                <span>目标格式</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  disabled={running || !targets.length}
                >
                  {targets.length === 0 && <option value="">无可转格式</option>}
                  {targets.map((f) => (
                    <option key={f} value={f}>
                      {f === '解压' ? '解压（到文件夹）' : f === 'zip' && selected.ext !== 'zip' ? 'ZIP（打包）' : f.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              {showVideoCodec && (
                <label className="field">
                  <span>视频编码</span>
                  <select
                    value={videoCodec}
                    onChange={(e) => setVideoCodec(e.target.value as typeof videoCodec)}
                    disabled={running}
                  >
                    {VIDEO_CODECS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} — {c.hint}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {showPdfActions && (
                <>
                  <label className="field">
                    <span>PDF 操作</span>
                    <select
                      value={pdfAction}
                      onChange={(e) => setPdfAction(e.target.value as typeof pdfAction)}
                      disabled={running}
                    >
                      {PDF_ACTIONS.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {needPdfPassword && (
                    <div className="field-stack">
                      <label className="field">
                        <span>PDF 密码</span>
                        <input
                          type="password"
                          value={
                            pdfApplyPasswordToAll
                              ? pdfPassword
                              : (selected?.pdfPassword ?? '')
                          }
                          onChange={(e) => {
                            const v = e.target.value
                            if (pdfApplyPasswordToAll) {
                              setPdfPassword(v)
                              return
                            }
                            if (!selected) {
                              setPdfPassword(v)
                              return
                            }
                            setQueue((prev) =>
                              prev.map((q) => (q.id === selected.id ? { ...q, pdfPassword: v } : q)),
                            )
                          }}
                          disabled={running}
                          placeholder="加密或解密所需密码"
                          autoComplete="off"
                        />
                      </label>
                      {queue.filter((q) => isPdfGroup(q.group)).length > 1 && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={pdfApplyPasswordToAll}
                            disabled={running}
                            onChange={(e) => {
                              const on = e.target.checked
                              setPdfApplyPasswordToAll(on)
                              if (on) {
                                const from =
                                  selected?.pdfPassword ||
                                  queue.find((q) => q.pdfPassword)?.pdfPassword ||
                                  pdfPassword
                                setPdfPassword(from)
                              }
                            }}
                          />
                          <span>其他加密 PDF 都使用此密码</span>
                        </label>
                      )}
                    </div>
                  )}
                  {pdfAction === 'ocr' && (
                    <p className="hint">
                      OCR 走本机 Tesseract（扫描 PDF 先 pdftoppm）。目标选 TXT / MD / DOCX；缺 chi_sim/eng 会报错。
                    </p>
                  )}
                  {pdfAction === 'merge' && (
                    <p className="hint">合并会按队列顺序拼接所有 PDF。</p>
                  )}
                </>
              )}

              {primaryGroup === 'specialMusic' && (
                <div className="legal-banner compact">
                  特殊音乐（NCM/MGG/KGM 等）需你自行使用<strong>外部合法工具</strong>处理有权文件；
                  <strong>应用内不内置破解/解密</strong>。
                </div>
              )}
            </>
          )}

          <div className="convert-controls">
          <button
            type="button"
            className="btn primary block"
            disabled={
              !queue.length ||
              running ||
              (pdfInQueue && pdfAction === 'convert' && !target) ||
              (!pdfInQueue && !target)
            }
            onClick={() => void startConvert()}
          >
            {running
              ? jobSession.queuePaused
                ? '已暂停'
                : '转换中…'
              : pdfInQueue && pdfAction !== 'convert'
                ? `开始（PDF ${pdfAction}）`
                : [avInQueue && 'FFmpeg', docInQueue && 'LibreOffice', pdfInQueue && 'PDF', imageInQueue && 'Sharp', ebookInQueue && 'Pandoc', archiveInQueue && '压缩包', subtitleInQueue && '字幕']
                    .filter(Boolean)
                    .join(' + ')
                  ? `开始转换（${[avInQueue && 'FFmpeg', docInQueue && 'LibreOffice', pdfInQueue && 'PDF', imageInQueue && 'Sharp', ebookInQueue && 'Pandoc', archiveInQueue && '压缩包', subtitleInQueue && '字幕'].filter(Boolean).join(' + ')}）`
                  : '开始转换'}
          </button>
          {canPauseBatch && (
            <button type="button" className="btn ghost" onClick={pauseBatch}>
              暂停
            </button>
          )}
          {canResumeBatch && (
            <button type="button" className="btn ghost" onClick={resumeBatch}>
              继续
            </button>
          )}
          {canCancelBatch && (
            <button type="button" className="btn ghost danger-text" onClick={cancelBatch}>
              取消
            </button>
          )}
          </div>

          {lastOutput && api?.showItemInFolder && (
            <button
              type="button"
              className="btn ghost block"
              style={{ marginTop: 8 }}
              onClick={() => {
                void api.showItemInFolder(lastOutput)
                toast.success('已打开输出目录')
              }}
            >
              打开输出目录
            </button>
          )}

          <p className="hint">
            {avInQueue || docInQueue || pdfInQueue || imageInQueue || ebookInQueue || archiveInQueue || subtitleInQueue
              ? `输出默认写在源文件同目录。${exportEstimateBytes ? `预计大小约 ${formatBytes(exportEstimateBytes)}。` : ''}${
                  queue.length > 1
                    ? imageInQueue && !avInQueue && !docInQueue && !pdfInQueue && !ebookInQueue && !archiveInQueue && !subtitleInQueue
                      ? '图片会逐个转换，避免引擎冲突。'
                      : imageInQueue
                        ? `同时转换 ${resolveConcurrency(settings.concurrency)} 路（图片会逐个进行）。`
                        : `同时转换 ${resolveConcurrency(settings.concurrency)} 路。`
                    : ''
                }`
              : '选择文件后，在此设置目标格式并开始转换。'}
          </p>

          {(running || progress > 0) && (
            <ProgressMock
              value={progress}
              label={progressLabel || (running ? (jobSession.queuePaused ? '已暂停' : '转换进度') : '上次结果')}
            />
          )}
          {errorInfo && (
            <FailureNotice
              message={errorInfo.message}
              code={errorInfo.code}
              detail={errorInfo.detail}
              onViewDetails={() => jobSession.openPopover(errorInfo.jobId)}
            />
          )}
        </aside>
      </section>

      {showSpecialLegal && (
        <div className="legal-banner">
          <strong>特殊音乐合规提示：</strong>
          队列中含平台封装格式（NCM / MGG / MFLAC / KGM 等）。请仅处理你有权使用的文件；
          如需转换请使用外部合法工具——<strong>应用内不内置破解/解密</strong>。
        </div>
      )}

      <FormatMatrix />
    </div>
  )
}
