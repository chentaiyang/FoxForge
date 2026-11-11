/**
 * 音视频转换引擎（FFmpeg / ffprobe），并汇总全部引擎的健康清单 getEngineHealth。
 *
 * 清单共 10 项。「特殊音乐模块」（id: musicUnlock）永远是 optional、从不 ready，
 * 但仍计入分母；不要把它从列表或计数里拿掉，也不要改成 ready。
 * FFmpeg 任务可以按 settings.concurrency 并行；LibreOffice / 图片仍由各自 limiter 串行。
 */
import {
  abortReserved,
  cancelledResult,
  commitReserved,
  failResult,
  isCancelRequested,
  remapIfCancelled,
  reserveOrFail,
  setPhase,
  spawnTracked, decorateProgress } from './jobs'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { envWithExeDir } from './bins'
import { getLibreOfficeHealthItem } from './libreoffice'
import { getPopplerHealthItem, getQpdfHealthItem } from './pdf'
import { getSharpHealthItem, getLibrawHealthItem } from './image'
import { getTesseractHealthItem } from './ocr'
import { getPandocHealthItem } from './ebook'
import type {
  ConvertProgressEvent,
  ConvertResult,
  EngineHealthItem,
  VideoCodecId,
} from './types'

export type {
  ConvertProgressEvent,
  ConvertResult,
  EngineHealthItem,
  EngineStatus,
  VideoCodecId,
} from './types'

export interface ConvertMediaRequest {
  inputPath: string
  target: string
  videoCodec?: VideoCodecId
  /** 绝对输出路径；省略则在源文件旁自动生成 */
  outputPath?: string
}

function candidateBinDirs(): string[] {
  const dirs: string[] = []
  try {
    if (app.isPackaged) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      dirs.push(path.join(process.resourcesPath, 'ffmpeg'))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
    }
  } catch {
    // 冒烟脚本在 Electron 外运行时没有 app
  }
  dirs.push(path.join(process.cwd(), 'bin'))
  dirs.push(path.join(process.cwd(), 'resources', 'bin'))
  return dirs
}

function whichSync(cmd: string): string | null {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, process.platform === 'win32' ? cmd + ext : cmd)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* 忽略 */
      }
    }
  }
  return null
}

function findBinary(names: string[]): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of candidateBinDirs()) {
    for (const name of names) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext)
        try {
          if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  for (const name of names) {
    const fromPath = whichSync(name)
    if (fromPath) return fromPath
  }
  return null
}

function runCapture(
  bin: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnTracked(bin, args, { windowsHide: true, env: envWithExeDir(bin) })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export async function resolveFfmpeg(): Promise<{
  ffmpeg: string | null
  ffprobe: string | null
  version?: string
}> {
  const ffmpeg = findBinary(['ffmpeg'])
  const ffprobe = findBinary(['ffprobe'])
  let version: string | undefined
  if (ffmpeg) {
    const r = await runCapture(ffmpeg, ['-version'])
    const m = (r.stdout || r.stderr).match(/ffmpeg version\s+(\S+)/i)
    if (m) version = m[1]
  }
  return { ffmpeg, ffprobe, version }
}

export async function probeDurationSec(ffprobe: string, inputPath: string): Promise<number | null> {
  const r = await runCapture(ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    inputPath,
  ])
  const raw = (r.stdout || '').trim()
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

const AUDIO_TARGETS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma'])
const VIDEO_TARGETS = new Set(['mp4', 'mkv', 'webm', 'mov', 'gif'])

export function isFfmpegConvertible(group: string, target: string): boolean {
  const t = target.toLowerCase()
  if (group === 'audio') return AUDIO_TARGETS.has(t)
  if (group === 'video') return AUDIO_TARGETS.has(t) || VIDEO_TARGETS.has(t)
  return false
}

export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  target: string,
  videoCodec: VideoCodecId = 'h264',
): string[] {
  const t = target.toLowerCase()
  const base = ['-y', '-hide_banner', '-stats', '-i', inputPath]

  if (AUDIO_TARGETS.has(t)) {
    const audio: string[] = ['-vn']
    switch (t) {
      case 'mp3':
        audio.push('-c:a', 'libmp3lame', '-q:a', '2')
        break
      case 'wav':
        audio.push('-c:a', 'pcm_s16le')
        break
      case 'flac':
        audio.push('-c:a', 'flac')
        break
      case 'aac':
      case 'm4a':
        audio.push('-c:a', 'aac', '-b:a', '192k')
        break
      case 'ogg':
        audio.push('-c:a', 'libvorbis', '-q:a', '5')
        break
      case 'opus':
        audio.push('-c:a', 'libopus', '-b:a', '128k')
        break
      case 'wma':
        audio.push('-c:a', 'wmav2', '-b:a', '192k')
        break
    }
    return [...base, ...audio, outputPath]
  }

  if (t === 'gif') {
    return [...base, '-vf', 'fps=12,scale=480:-1:flags=lanczos', '-loop', '0', outputPath]
  }

  if (t === 'webm') {
    if (videoCodec === 'copy') {
      return [...base, '-c', 'copy', outputPath]
    }
    if (videoCodec === 'av1') {
      return [
        ...base,
        '-c:v',
        'libsvtav1',
        '-crf',
        '35',
        '-preset',
        '8',
        '-c:a',
        'libopus',
        '-b:a',
        '128k',
        outputPath,
      ]
    }
    return [
      ...base,
      '-c:v',
      'libvpx-vp9',
      '-crf',
      '32',
      '-b:v',
      '0',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
      outputPath,
    ]
  }

  const vcodec =
    videoCodec === 'copy'
      ? ['-c:v', 'copy']
      : videoCodec === 'h265'
        ? ['-c:v', 'libx265', '-preset', 'medium', '-crf', '28', '-tag:v', 'hvc1']
        : videoCodec === 'av1'
          ? ['-c:v', 'libsvtav1', '-crf', '35', '-preset', '8']
          : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23']

  const acodec = videoCodec === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
  const extra = t === 'mp4' || t === 'mov' ? ['-movflags', '+faststart'] : []

  return [...base, ...vcodec, ...acodec, ...extra, outputPath]
}

export function defaultOutputPath(inputPath: string, target: string): string {
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const ext = target.toLowerCase()
  let candidate = path.join(dir, `${base}.${ext}`)
  if (candidate.toLowerCase() === inputPath.toLowerCase()) {
    candidate = path.join(dir, `${base}_converted.${ext}`)
  }
  if (!fs.existsSync(candidate)) return candidate
  let i = 1
  while (true) {
    const p = path.join(dir, `${base}_converted_${i}.${ext}`)
    if (!fs.existsSync(p)) return p
    i += 1
  }
}

function parseTimeToSec(s: string): number | null {
  const m = s.match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  if (![h, min, sec].every(Number.isFinite)) return null
  return h * 3600 + min * 60 + sec
}

/**
 * 汇总 10 项引擎健康状态，供设置页和标题栏使用。
 * 最后一项「特殊音乐模块」永远是 optional、从不 ready，但仍要放进数组计入分母。
 */
export async function getEngineHealth(): Promise<EngineHealthItem[]> {
  const { ffmpeg, ffprobe, version } = await resolveFfmpeg()
  const ffmpegReady = Boolean(ffmpeg)
  return [
    {
      id: 'ffmpeg',
      name: 'FFmpeg',
      status: ffmpegReady ? 'ready' : 'missing',
      covers: '普通音视频',
      version,
      path: ffmpeg ?? undefined,
      detail: ffmpegReady
        ? `ffprobe: ${ffprobe ? 'OK' : '缺失（进度估算可能不准）'}`
        : '未在 PATH 或 resources/bin 找到 ffmpeg',
    },
    await getLibreOfficeHealthItem(),
    await getPopplerHealthItem(),
    await getQpdfHealthItem(),
    await getTesseractHealthItem(),
    await getPandocHealthItem(),
    await getSharpHealthItem(),
    await getLibrawHealthItem(),
    await (await import('./vocal')).getDemucsHealthItem(),
    {
      // 永远 optional，不要改成 ready / missing，也不要从清单里删除
      id: 'musicUnlock',
      name: '特殊音乐模块',
      status: 'optional',
      covers: 'NCM/MGG/KGM…',
      detail: '需外部合法工具；应用内不内置破解/解密',
    },
  ]
}

/** 用 FFmpeg 转换音视频。可按 settings.concurrency 并行，不受 limitOffice / limitImage 限制。 */
export async function convertMedia(
  req: ConvertMediaRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const { ffmpeg, ffprobe } = await resolveFfmpeg()
  if (!ffmpeg) {
    return failResult(jobId, 'E-FFMPEG-MISSING', '未找到 FFmpeg。请安装 ffmpeg 并加入 PATH，或放入 resources/bin。')
  }

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }
  if (isCancelRequested(jobId)) return cancelledResult(jobId)

  const target = req.target.toLowerCase()
  const outputPath = req.outputPath || defaultOutputPath(inputPath, target)
  const videoCodec = req.videoCodec ?? 'h264'

  let durationSec: number | null = null
  if (ffprobe) {
    durationSec = await probeDurationSec(ffprobe, inputPath)
  }

  const kind = AUDIO_TARGETS.has(target) ? 'audio' : 'video'
  const reserved = reserveOrFail(jobId, outputPath, {
    kind,
    inputPaths: inputPath,
    durationSec: durationSec ?? undefined,
  })
  if (!reserved.ok) return reserved.result

  const args = buildFfmpegArgs(inputPath, reserved.reserved.tempPath, target, videoCodec)
  setPhase(jobId, 'convert')
  onProgress({ jobId, percent: 1, durationSec: durationSec ?? undefined, message: '开始转换…', phase: 'convert' })

  const result = await new Promise<ConvertResult>((resolve) => {
    const child = spawnTracked(ffmpeg, args, { windowsHide: true, env: envWithExeDir(ffmpeg) })
    let stderrBuf = ''

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000)

      const timeMatch = text.match(/time=\s*([0-9:.]+)/)
      if (timeMatch) {
        const tm = parseTimeToSec(timeMatch[1])
        if (tm != null && durationSec && durationSec > 0) {
          const percent = Math.min(99, Math.max(1, (tm / durationSec) * 100))
          onProgress({ jobId, percent, timeSec: tm, durationSec, phase: 'convert' })
        } else if (tm != null) {
          onProgress({ jobId, percent: Math.min(90, 5 + tm * 2), timeSec: tm, phase: 'convert' })
        }
      }
    }

    child.stderr.on('data', handleChunk)
    child.stdout.on('data', handleChunk)

    child.on('error', (err) => {
      abortReserved(jobId, reserved.reserved)
      if (isCancelRequested(jobId)) resolve(cancelledResult(jobId, err.message))
      else resolve(failResult(jobId, 'E-FFMPEG-FAILED', `无法启动 FFmpeg：${err.message}`))
    })

    child.on('close', (code) => {
      if (isCancelRequested(jobId) && code !== 0) {
        abortReserved(jobId, reserved.reserved)
        resolve(cancelledResult(jobId))
        return
      }
      if (code === 0 && fs.existsSync(reserved.reserved.tempPath)) {
        setPhase(jobId, 'finalize')
        onProgress({
          jobId,
          percent: 99,
          durationSec: durationSec ?? undefined,
          message: '正在校验输出…',
          phase: 'finalize',
        })
        const committed = commitReserved(jobId, reserved.reserved, { verify: 'file' })
        if (!committed.ok) {
          resolve(committed)
          return
        }
        onProgress({
          jobId,
          percent: 100,
          durationSec: durationSec ?? undefined,
          message: '完成',
          phase: 'finalize',
        })
        resolve({ jobId, ok: true, outputPath: committed.outputPath })
        return
      }
      abortReserved(jobId, reserved.reserved)
      const tail = stderrBuf.trim().split('\n').slice(-8).join('\n')
      resolve(
        failResult(
          jobId,
          'E-FFMPEG-FAILED',
          `FFmpeg 退出码 ${code ?? 'null'}${tail ? `\n${tail}` : ''}`,
          tail || undefined,
        ),
      )
    })
  })
  return remapIfCancelled(jobId, result)
}
