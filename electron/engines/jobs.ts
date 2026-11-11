/**
 * 任务生命周期：并发限制、暂停/取消、磁盘预占、原子打包与空间估算。
 *
 * Windows 没有可靠的 SIGSTOP：暂停 = 不启动下一项，当前子进程可能跑完；
 * 取消仍可杀进程。但 pack / finalize 视为原子操作：先写完、校验，再按取消删文件。
 *
 * 磁盘预占走旁路 .space 文件，不要和引擎输出路径抢同一个文件。
 * estimateOutputBytes 偏宽（占盘），displayEstimateBytes 更紧（给用户看）。
 * 空间不足报 E-DISK-SPACE；目标盘在预估之外还要留 DISK_HEADROOM_BYTES（80MB）。
 *
 * LibreOffice 用 limitOffice = createLimiter(1) 串行；图片用 limitImage = createLimiter(1)；
 * FFmpeg 等可以按 settings.concurrency 并行。0 表示自动：min(8, max(2, hardwareConcurrency-1))。
 */
import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConvertResult, ConvertProgressEvent } from './types'

/** convert 可中断；pack / finalize 是原子阶段：写完、校验后再按取消删文件。 */
export type JobPhase = 'convert' | 'pack' | 'finalize'

/** 目标盘在预估用量之外至少再留出的余量 */
export const DISK_HEADROOM_BYTES = 80 * 1024 * 1024

export type EstimateKind =
  | 'media'
  | 'audio'
  | 'video'
  | 'image'
  | 'document'
  | 'pdf'
  | 'archive'
  | 'zip'
  | 'ebook'
  | 'subtitle'
  | 'ocr'
  | 'vocal'
  | 'generic'

interface JobRecord {
  jobId: string
  phase: JobPhase
  children: Set<ChildProcess>
  cancelRequested: boolean
  cancelAfterPack: boolean
  pauseRequested: boolean
  paused: boolean
  temps: Set<string>
  outputs: Set<string>
  estimatedBytes?: number
}

const jobs = new Map<string, JobRecord>()
const als = new AsyncLocalStorage<string>()

function ensure(jobId: string): JobRecord {
  let rec = jobs.get(jobId)
  if (!rec) {
    rec = {
      jobId,
      phase: 'convert',
      children: new Set(),
      cancelRequested: false,
      cancelAfterPack: false,
      pauseRequested: false,
      paused: false,
      temps: new Set(),
      outputs: new Set(),
    }
    jobs.set(jobId, rec)
  }
  return rec
}

/** 当前 AsyncLocalStorage 里的任务编号，供 spawnTracked 自动挂接子进程。 */
export function currentJobId(): string | undefined {
  return als.getStore()
}

export function registerJob(jobId: string): JobRecord {
  return ensure(jobId)
}

export function setJobEstimate(jobId: string, bytes: number) {
  if (bytes > 0) ensure(jobId).estimatedBytes = bytes
}

export function getJobEstimate(jobId: string): number | undefined {
  return jobs.get(jobId)?.estimatedBytes
}

export function decorateProgress(jobId: string, onProgress: (ev: ConvertProgressEvent) => void) {
  return (ev: ConvertProgressEvent) => {
    onProgress({
      ...ev,
      estimatedBytes: ev.estimatedBytes ?? getJobEstimate(jobId),
    })
  }
}

/** 限制同一类引擎任务的并发；LibreOffice、图片必须传 1。 */
export function createLimiter(max: number) {
  let active = 0
  const waiters: Array<() => void> = []
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      const next = waiters.shift()
      if (next) next()
    }
  }
}

/** LibreOffice 共用配置，不能并行转换，必须串行。 */
export const limitOffice = createLimiter(1)
/** 图片经 Sharp/libvips，重叠写入不稳定，必须串行。 */
export const limitImage = createLimiter(1)

export function unregisterJob(jobId: string) {
  const rec = jobs.get(jobId)
  if (!rec) return
  for (const child of rec.children) {
    try {
      child.removeAllListeners()
    } catch {
      /* 忽略 */
    }
  }
  jobs.delete(jobId)
}

export function setPhase(jobId: string, phase: JobPhase) {
  ensure(jobId).phase = phase
}

export function getPhase(jobId: string): JobPhase | undefined {
  return jobs.get(jobId)?.phase
}

export function isCancelRequested(jobId?: string | null): boolean {
  const id = jobId || currentJobId()
  if (!id) return false
  const rec = jobs.get(id)
  return Boolean(rec?.cancelRequested)
}

export function shouldDiscardAfterPack(jobId?: string | null): boolean {
  const id = jobId || currentJobId()
  if (!id) return false
  const rec = jobs.get(id)
  return Boolean(rec?.cancelRequested || rec?.cancelAfterPack)
}

export function isPauseRequested(jobId?: string | null): boolean {
  const id = jobId || currentJobId()
  if (!id) return false
  return Boolean(jobs.get(id)?.pauseRequested)
}

export function trackTemp(jobId: string, filePath: string) {
  if (filePath) ensure(jobId).temps.add(filePath)
}

export function trackOutput(jobId: string, filePath: string) {
  if (filePath) ensure(jobId).outputs.add(filePath)
}

export function attachChild(jobId: string, child: ChildProcess) {
  const rec = ensure(jobId)
  rec.children.add(child)
  const drop = () => rec.children.delete(child)
  child.once('close', drop)
  child.once('exit', drop)
  child.once('error', drop)
  if (rec.cancelRequested && rec.phase === 'convert') {
    killChild(child)
  } else if (rec.pauseRequested && rec.phase === 'convert') {
    tryPauseChild(child)
    rec.paused = true
  }
}

export function attachCurrentJobChild(child: ChildProcess): ChildProcess {
  const id = currentJobId()
  if (id) attachChild(id, child)
  return child
}

/**
 * 给转换子进程用的 spawn 包装：自动挂到当前任务，便于暂停/取消。
 */
export function spawnTracked(
  command: string,
  args: string[],
  options?: Parameters<typeof spawn>[2],
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { windowsHide: true, stdio: 'pipe', ...options })
  return attachCurrentJobChild(child) as ChildProcessWithoutNullStreams
}

function tryPauseChild(child: ChildProcess) {
  // Windows 没有可靠的 SIGSTOP；暂停只表示「不开始下一项」，当前进程会跑完。取消仍可终止。
  if (process.platform === 'win32') return
  if (child.pid == null) return
  try {
    child.kill('SIGSTOP')
  } catch {
    /* 忽略 */
  }
}

function tryResumeChild(child: ChildProcess) {
  if (process.platform === 'win32') return
  if (child.pid == null) return
  try {
    child.kill('SIGCONT')
  } catch {
    /* 忽略 */
  }
}

function killChild(child: ChildProcess) {
  if (child.pid == null || child.killed) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        child.kill('SIGCONT')
      } catch {
        /* 本来就在运行 */
      }
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
      }, 1200)
    }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 请求暂停。Windows 没有可靠 SIGSTOP：只保证不启动下一项，当前进程可能跑完。
 * 若已进入 pack/finalize，则等原子阶段写完再处理。
 */
export function requestPause(jobId: string): { ok: boolean; deferred: boolean; message?: string } {
  const rec = jobs.get(jobId)
  if (!rec) return { ok: false, deferred: false, message: '任务不存在或已结束' }
  rec.pauseRequested = true
  // 打包/收尾视为原子操作：不 SIGSTOP，写完再按暂停/取消策略处理
  if (rec.phase === 'pack' || rec.phase === 'finalize') {
    return { ok: true, deferred: true, message: '正在打包，将在写完后暂停' }
  }
  if (process.platform === 'win32') {
    // Windows 无 SIGSTOP，暂停表示不启动下一项；当前进程会跑完。
    return { ok: true, deferred: true, message: '当前平台无法挂起进程，将在本步结束后暂停' }
  }
  for (const child of rec.children) tryPauseChild(child)
  rec.paused = rec.children.size > 0
  return { ok: true, deferred: !rec.paused }
}

export function requestResume(jobId: string): { ok: boolean; message?: string } {
  const rec = jobs.get(jobId)
  if (!rec) return { ok: false, message: '任务不存在或已结束' }
  rec.pauseRequested = false
  rec.paused = false
  for (const child of rec.children) tryResumeChild(child)
  return { ok: true }
}

/**
 * 请求取消。转换阶段可立刻杀进程；pack/finalize 先写完、校验，再删除输出，避免半截文件。
 */
export function requestCancel(jobId: string): { ok: boolean; deferred: boolean; message?: string } {
  const rec = ensure(jobId)
  rec.cancelRequested = true
  rec.pauseRequested = false
  if (rec.phase === 'pack' || rec.phase === 'finalize') {
    rec.cancelAfterPack = true
    // 打包阶段先让写入走完，再校验并删除，避免半截文件报错
    return { ok: true, deferred: true, message: '正在打包，将在写完并校验后取消并清理' }
  }
  rec.paused = false
  for (const child of rec.children) killChild(child)
  cleanupTracked(jobId)
  return { ok: true, deferred: false }
}

export function cancelledResult(jobId: string, detail?: string): ConvertResult {
  return {
    jobId,
    ok: false,
    error: '任务已取消',
    errorCode: 'E-CANCELLED',
    errorDetail: detail || '用户取消了该任务，已清理临时文件。',
  }
}

export function failResult(
  jobId: string,
  code: string,
  error: string,
  detail?: string,
): ConvertResult {
  return {
    jobId,
    ok: false,
    error,
    errorCode: code,
    errorDetail: detail ?? error,
  }
}

export function cleanupTracked(jobId: string) {
  const rec = jobs.get(jobId)
  if (!rec) return
  for (const p of [...rec.temps, ...rec.outputs]) {
    rmAny(p)
  }
  rec.temps.clear()
  rec.outputs.clear()
}

function rmAny(p: string) {
  if (!p) return
  try {
    if (!fs.existsSync(p)) return
    const st = fs.lstatSync(p)
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true })
    else fs.unlinkSync(p)
  } catch {
    /* 忽略 */
  }
}

/** 在任务的 AsyncLocalStorage 中执行引擎函数，供主进程 IPC 统一包裹。 */
export async function runWithJob<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  registerJob(jobId)
  try {
    return await als.run(jobId, fn)
  } catch (err) {
    if (isCancelRequested(jobId)) {
      cleanupTracked(jobId)
      return cancelledResult(jobId, String(err)) as T
    }
    throw err
  } finally {
    // 结果已返回后再注销；清理责任在各引擎 / remap 里
    unregisterJob(jobId)
  }
}

/** 打包完成后若已请求取消：删掉刚写出的文件，把成功结果改写成 E-CANCELLED。 */
export function remapIfCancelled<T extends ConvertResult>(jobId: string, result: T): T {
  if (!isCancelRequested(jobId) && !shouldDiscardAfterPack(jobId)) return result
  if (result.ok) {
    // 打包完成后若已请求取消：删掉刚写出的文件，标记为取消而不是成功
    if (result.outputPath) rmAny(result.outputPath)
    if (result.outputPaths) for (const p of result.outputPaths) rmAny(p)
    cleanupTracked(jobId)
    return cancelledResult(jobId) as T
  }
  if (result.errorCode === 'E-CANCELLED') return result
  cleanupTracked(jobId)
  return cancelledResult(jobId, result.error || result.errorDetail) as T
}

export function formatBytes(n: number): string {
  const v = Math.max(0, n)
  if (v < 1024) return `${Math.ceil(v)} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function dirSize(dir: string): number {
  let total = 0
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(full)
      else if (e.isFile()) total += fs.statSync(full).size
    } catch {
      /* 忽略 */
    }
  }
  return total
}

export function inputBytes(paths: string | string[] | undefined | null): number {
  let total = 0
  for (const p of Array.isArray(paths) ? paths : paths ? [paths] : []) {
    if (!p) continue
    try {
      if (!fs.existsSync(p)) continue
      const st = fs.statSync(p)
      if (st.isDirectory()) total += dirSize(p)
      else total += st.size
    } catch {
      /* 忽略 */
    }
  }
  return total
}

/**
 * 偏宽的输出体积估算，用于磁盘预占。给用户展示请用 displayEstimateBytes。
 * 实际检查时还会再加上 DISK_HEADROOM_BYTES（80MB），不足则报 E-DISK-SPACE。
 */
export function estimateOutputBytes(opts: {
  kind: EstimateKind
  inputPaths?: string | string[]
  durationSec?: number
}): number {
  const raw = inputBytes(opts.inputPaths)
  const list = Array.isArray(opts.inputPaths) ? opts.inputPaths : opts.inputPaths ? [opts.inputPaths] : []
  let base = raw
  switch (opts.kind) {
    case 'video':
    case 'media': {
      if (opts.durationSec && opts.durationSec > 0) {
        const byRate = Math.ceil((opts.durationSec * (8_000_000 + 192_000)) / 8)
        base = Math.max(raw * 1.5, byRate)
      } else {
        base = Math.max(raw * 1.8, 16 * 1024 * 1024)
      }
      break
    }
    case 'audio': {
      if (opts.durationSec && opts.durationSec > 0) {
        const byRate = Math.ceil((opts.durationSec * 320_000) / 8)
        base = Math.max(raw * 1.3, byRate)
      } else {
        base = Math.max(raw * 1.4, 8 * 1024 * 1024)
      }
      break
    }
    case 'image':
      base = Math.max(raw * 4, raw + 8 * 1024 * 1024)
      break
    case 'zip':
    case 'archive':
      base = raw + list.length * 65536 + 8 * 1024 * 1024
      break
    case 'document':
    case 'pdf':
    case 'ebook':
      base = raw * 2 + 16 * 1024 * 1024
      break
    case 'subtitle':
      base = raw * 2 + 1024 * 1024
      break
    case 'ocr':
      base = Math.max(raw, 8 * 1024 * 1024)
      break
    case 'vocal':
      base = raw * 12 + 32 * 1024 * 1024
      break
    default:
      base = raw * 2 + 16 * 1024 * 1024
  }
  return Math.ceil(base * 1.15)
}

/**
 * 给界面看的偏紧体积估算。占盘请用更宽的 estimateOutputBytes，两者不要混用。
 */
export function displayEstimateBytes(opts: {
  kind: EstimateKind
  inputPaths?: string | string[]
  durationSec?: number
}): number {
  const raw = inputBytes(opts.inputPaths)
  switch (opts.kind) {
    case 'video':
    case 'media':
      if (opts.durationSec && opts.durationSec > 0) {
        return Math.ceil((opts.durationSec * (6_000_000 + 160_000)) / 8)
      }
      return Math.max(Math.ceil(raw * 1.1), 256 * 1024)
    case 'audio':
      if (opts.durationSec && opts.durationSec > 0) {
        return Math.ceil((opts.durationSec * 192_000) / 8)
      }
      return Math.max(Math.ceil(raw * 1.1), 64 * 1024)
    case 'image':
      return Math.max(Math.ceil(raw * 1.15), 4096)
    case 'zip':
    case 'archive':
      return Math.max(Math.ceil(raw * 0.95), 4096)
    case 'subtitle':
      return Math.max(Math.ceil(raw * 1.3), 1024)
    case 'ocr':
      return Math.max(Math.min(raw, 2 * 1024 * 1024), 8 * 1024)
    default:
      return Math.max(Math.ceil(raw * 1.2), 16 * 1024)
  }
}

function existingDir(p: string): string {
  let cur = path.resolve(p)
  if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) return cur
  if (fs.existsSync(cur) && fs.statSync(cur).isFile()) return path.dirname(cur)
  cur = path.dirname(cur)
  while (cur && !fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return fs.existsSync(cur) ? cur : os.tmpdir()
}

export function getFreeSpace(destPath: string): { free: number; volume: string } {
  const volume = existingDir(destPath)
  const statfs = (fs as typeof fs & {
    statfsSync?: (p: string) => { bavail?: number | bigint; bfree?: number | bigint; bsize?: number | bigint }
  }).statfsSync
  if (typeof statfs === 'function') {
    const st = statfs(volume)
    const bsize = Number(st.bsize ?? 4096)
    const bavail = Number(st.bavail ?? st.bfree ?? 0)
    return { free: bavail * bsize, volume }
  }
  // 极老环境没有 statfsSync 时，保守地当作「空间未知但不拦截」会很危险；改用 df
  if (process.platform !== 'win32') {
    const r = spawnSync('df', ['-k', '-P', volume], { encoding: 'utf8' })
    const line = (r.stdout || '').trim().split('\n')[1]
    if (line) {
      const cols = line.split(/\s+/)
      const availK = Number(cols[3])
      if (Number.isFinite(availK)) return { free: availK * 1024, volume }
    }
  }
  return { free: Number.POSITIVE_INFINITY, volume }
}

/** 构造 E-DISK-SPACE 错误结果，文案里带预估需要、剩余空间和 80MB 余量。 */
export function diskSpaceError(
  jobId: string,
  destPath: string,
  needed: number,
  free: number,
): ConvertResult {
  const msg = `目标磁盘空间不足，转换大约需要 ${formatBytes(needed)}，当前仅剩 ${formatBytes(free)}`
  return failResult(
    jobId,
    'E-DISK-SPACE',
    msg,
    `${msg}\n目标路径：${destPath}\n预估需要：${needed} 字节\n当前剩余：${free} 字节\n安全余量：${formatBytes(DISK_HEADROOM_BYTES)}`,
  )
}

export function checkDiskSpace(
  jobId: string,
  destPath: string,
  neededBytes: number,
): ConvertResult | null {
  const { free } = getFreeSpace(destPath)
  const need = neededBytes + DISK_HEADROOM_BYTES
  if (free < need) return diskSpaceError(jobId, destPath, neededBytes, free)
  return null
}

function preallocateFd(fd: number, filePath: string, bytes: number) {
  if (bytes <= 0) return
  if (process.platform === 'win32') {
    // 等价于 SetEndOfFile，NTFS 通常会预留簇
    fs.ftruncateSync(fd, bytes)
    return
  }
  fs.ftruncateSync(fd, bytes)
}

export function preallocateFile(filePath: string, bytes: number) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const fd = fs.openSync(filePath, 'w')
  try {
    preallocateFd(fd, filePath, bytes)
  } finally {
    fs.closeSync(fd)
  }
  if (bytes <= 0 || process.platform === 'win32') return
  // Linux：fallocate / posix_fallocate 真正占用块，避免稀疏文件在写到一半时盘满
  const fa = spawnSync('fallocate', ['-l', String(bytes), filePath], { stdio: 'ignore' })
  if (fa.status === 0) return
  const py = spawnSync(
    'python3',
    [
      '-c',
      'import os,sys; p,s=sys.argv[1],int(sys.argv[2]); fd=os.open(p,os.O_RDWR); os.posix_fallocate(fd,0,s); os.close(fd)',
      filePath,
      String(bytes),
    ],
    { stdio: 'ignore' },
  )
  if (py.status === 0) return
}

/** 文件被引擎截断后，再次把空间占回去（不覆盖已写入的数据）。 */
export function reallocateFile(filePath: string, bytes: number) {
  if (bytes <= 0 || !fs.existsSync(filePath)) return
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    return
  }
  if (size >= bytes) return
  if (process.platform === 'win32') {
    const fd = fs.openSync(filePath, 'r+')
    try {
      fs.ftruncateSync(fd, bytes)
    } finally {
      fs.closeSync(fd)
    }
    return
  }
  const fa = spawnSync('fallocate', ['-l', String(bytes), filePath], { stdio: 'ignore' })
  if (fa.status === 0) return
  spawnSync(
    'python3',
    [
      '-c',
      'import os,sys; p,s=sys.argv[1],int(sys.argv[2]); fd=os.open(p,os.O_RDWR); os.posix_fallocate(fd,0,s); os.close(fd)',
      filePath,
      String(bytes),
    ],
    { stdio: 'ignore' },
  )
}

export function watchReallocate(filePath: string, bytes: number): () => void {
  let stopped = false
  const tick = () => {
    if (stopped) return
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size < bytes) {
        reallocateFile(filePath, bytes)
      }
    } catch {
      /* 忽略 */
    }
  }
  const iv = setInterval(tick, 120)
  // 启动后立刻补几次，抓住 ffmpeg/soffice 刚截断文件的窗口
  const t1 = setTimeout(tick, 20)
  const t2 = setTimeout(tick, 80)
  const t3 = setTimeout(tick, 200)
  return () => {
    stopped = true
    clearInterval(iv)
    clearTimeout(t1)
    clearTimeout(t2)
    clearTimeout(t3)
  }
}

export function truncateFile(filePath: string, size: number) {
  if (!fs.existsSync(filePath)) return
  const fd = fs.openSync(filePath, 'r+')
  try {
    fs.ftruncateSync(fd, Math.max(0, size))
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 在最终输出旁生成临时路径，但保留真实扩展名，避免 FFmpeg 等引擎无法从
 * `.mov.part` 推断封装格式。例如 video.mov → video.part.mov；无扩展名则
 * 退回 name.part。spacePath 仍使用 `${tempPath}.space`，不会和临时文件撞名。
 */
export function siblingTempPath(outputPath: string, suffix = '.part'): string {
  const dir = path.dirname(outputPath)
  const ext = path.extname(outputPath)
  const base = path.basename(outputPath, ext)
  const marker = suffix.startsWith('.') ? suffix.slice(1) : suffix
  if (!base) {
    // 类似 ".mov" 这种只有扩展名的文件名，退回附加后缀
    return `${outputPath}.${marker}`
  }
  if (!ext) {
    return path.join(dir, `${base}.${marker}`)
  }
  return path.join(dir, `${base}.${marker}${ext}`)
}

export function verifyOutputFile(filePath: string, kind: 'file' | 'zip' = 'file'): boolean {
  try {
    if (!fs.existsSync(filePath)) return false
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size <= 0) return false
    if (kind === 'zip') return verifyZipLightweight(filePath)
    return true
  } catch {
    return false
  }
}

function verifyZipLightweight(filePath: string): boolean {
  const st = fs.statSync(filePath)
  if (st.size <= 22) return false
  const fd = fs.openSync(filePath, 'r')
  try {
    const tailLen = Math.min(st.size, 65535 + 22)
    const tail = Buffer.alloc(tailLen)
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i
        break
      }
    }
    if (eocd < 0) return false
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOff = tail.readUInt32LE(eocd + 16)
    if (cdOff + cdSize > st.size) return false
    const sig = Buffer.alloc(4)
    fs.readSync(fd, sig, 0, 4, cdOff)
    return sig.readUInt32LE(0) === 0x02014b50
  } catch {
    return false
  } finally {
    fs.closeSync(fd)
  }
}

export interface ReservedOutput {
  tempPath: string
  /** 同盘预占文件，不给引擎写这个路径，避免和 Sharp/FFmpeg 抢同一个文件导致崩溃 */
  spacePath: string
  outputPath: string
  estimatedBytes: number
  stopWatch: () => void
}

/** 输出文件变大时，把旁路预占文件缩小，使「已写 + 预占」大致等于估算值，避免双倍占盘。 */
export function watchShrinkSpace(tempPath: string, spacePath: string, estimatedBytes: number): () => void {
  let stopped = false
  const tick = () => {
    if (stopped) return
    try {
      const written = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0
      const remain = Math.max(0, estimatedBytes - written)
      if (remain <= 0) {
        rmAny(spacePath)
        return
      }
      if (!fs.existsSync(spacePath)) {
        preallocateFile(spacePath, remain)
        return
      }
      const cur = fs.statSync(spacePath).size
      if (cur > remain) truncateFile(spacePath, remain)
      else if (cur < remain) reallocateFile(spacePath, remain)
    } catch {
      /* 忽略 */
    }
  }
  const iv = setInterval(tick, 150)
  const t1 = setTimeout(tick, 30)
  const t2 = setTimeout(tick, 90)
  return () => {
    stopped = true
    clearInterval(iv)
    clearTimeout(t1)
    clearTimeout(t2)
  }
}

/**
 * 在同盘创建旁路 .space 预占文件，输出临时路径留给引擎自己创建，
 * 避免 Sharp toFile / FFmpeg 截断与 fallocate 抢同一个文件。
 */
export function reserveOutputFile(
  jobId: string,
  outputPath: string,
  estimatedBytes: number,
): ReservedOutput {
  const tempPath = siblingTempPath(outputPath)
  const spacePath = `${tempPath}.space`
  for (const p of [tempPath, spacePath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {
      /* 忽略 */
    }
  }
  // 只预占旁路文件，输出临时路径留给引擎自己创建，避免 toFile/截断与 fallocate 互踩
  preallocateFile(spacePath, estimatedBytes)
  trackTemp(jobId, tempPath)
  trackTemp(jobId, spacePath)
  const stopWatch = watchShrinkSpace(tempPath, spacePath, estimatedBytes)
  return { tempPath, spacePath, outputPath, estimatedBytes, stopWatch }
}

export function abortReserved(jobId: string, reserved: ReservedOutput) {
  try {
    reserved.stopWatch()
  } catch {
    /* 忽略 */
  }
  rmAny(reserved.tempPath)
  rmAny(reserved.spacePath)
  const rec = jobs.get(jobId)
  rec?.temps.delete(reserved.tempPath)
  rec?.temps.delete(reserved.spacePath)
}

export function commitReserved(
  jobId: string,
  reserved: ReservedOutput,
  opts?: { verify?: 'file' | 'zip'; actualSize?: number },
): ConvertResult | { ok: true; outputPath: string } {
  reserved.stopWatch()
  rmAny(reserved.spacePath)
  const rec0 = jobs.get(jobId)
  rec0?.temps.delete(reserved.spacePath)
  const tempPath = reserved.tempPath
  if (!fs.existsSync(tempPath)) {
    return failResult(jobId, 'E-UNKNOWN', '输出文件未写出。')
  }
  const actual = opts?.actualSize ?? fs.statSync(tempPath).size
  // 成功写入后把预占空间截到真实大小
  truncateFile(tempPath, actual)

  const kind = opts?.verify ?? 'file'
  const good = verifyOutputFile(tempPath, kind)
  if (shouldDiscardAfterPack(jobId) || isCancelRequested(jobId)) {
    rmAny(tempPath)
    if (fs.existsSync(reserved.outputPath)) {
      // 若已改名到最终路径，也删掉，不把取消的结果留给用户
      rmAny(reserved.outputPath)
    }
    return cancelledResult(jobId, good ? '打包已完成并校验通过，已按取消请求删除输出。' : '已取消，并清理了临时文件。')
  }
  if (!good) {
    rmAny(tempPath)
    return failResult(jobId, kind === 'zip' ? 'E-ARCHIVE' : 'E-UNKNOWN', '输出文件校验失败（不存在、为空或损坏）。')
  }
  try {
    if (fs.existsSync(reserved.outputPath)) fs.unlinkSync(reserved.outputPath)
  } catch {
    /* 忽略 */
  }
  fs.mkdirSync(path.dirname(reserved.outputPath), { recursive: true })
  fs.renameSync(tempPath, reserved.outputPath)
  const rec = jobs.get(jobId)
  rec?.temps.delete(tempPath)
  trackOutput(jobId, reserved.outputPath)
  if (shouldDiscardAfterPack(jobId) || isCancelRequested(jobId)) {
    rmAny(reserved.outputPath)
    return cancelledResult(jobId, '文件已写出，已按取消请求删除。')
  }
  return { ok: true, outputPath: reserved.outputPath }
}

/** 把缓冲区写入输出临时文件。预占空间在旁路 .space 文件上，这里正常创建即可。 */
export function writeIntoReserved(reserved: ReservedOutput, data: Buffer) {
  fs.mkdirSync(path.dirname(reserved.tempPath), { recursive: true })
  fs.writeFileSync(reserved.tempPath, data)
}

/** 先用偏宽估算检查磁盘（含 80MB 余量），同时把偏紧估算写入任务供界面显示。 */
export function preflightOutput(
  jobId: string,
  outputPath: string,
  estimate: { kind: EstimateKind; inputPaths?: string | string[]; durationSec?: number },
): { ok: true; needed: number } | { ok: false; result: ConvertResult } {
  const needed = estimateOutputBytes(estimate)
  setJobEstimate(jobId, displayEstimateBytes(estimate))
  const err = checkDiskSpace(jobId, outputPath, needed)
  if (err) return { ok: false, result: err }
  return { ok: true, needed }
}

export function reserveOrFail(
  jobId: string,
  outputPath: string,
  estimate: { kind: EstimateKind; inputPaths?: string | string[]; durationSec?: number },
): { ok: true; reserved: ReservedOutput; needed: number } | { ok: false; result: ConvertResult } {
  const pre = preflightOutput(jobId, outputPath, estimate)
  if (!pre.ok) return pre
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const reserved = reserveOutputFile(jobId, outputPath, pre.needed)
  return { ok: true, reserved, needed: pre.needed }
}

export function atomicWriteOutput(
  jobId: string,
  outputPath: string,
  data: Buffer,
  estimate: { kind: EstimateKind; inputPaths?: string | string[]; durationSec?: number },
  verify: 'file' | 'zip' = 'file',
): ConvertResult | { ok: true; outputPath: string } {
  const reserved = reserveOrFail(jobId, outputPath, estimate)
  if (!reserved.ok) return reserved.result
  try {
    writeIntoReserved(reserved.reserved, data)
  } catch (err) {
    abortReserved(jobId, reserved.reserved)
    return failResult(jobId, 'E-UNKNOWN', `写入输出失败：${String(err)}`, String(err))
  }
  return commitReserved(jobId, reserved.reserved, { verify, actualSize: data.length })
}
