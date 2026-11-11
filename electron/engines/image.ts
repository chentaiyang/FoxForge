/**
 * 图片转换引擎：栅格互转、多图合成 PDF、RAW/PSD 等预解码，健康探测走 Sharp / LibRaw。
 *
 * Sharp 绝不能在 Electron 进程内跑真实 vips 操作，必须交给系统 Node 子进程
 * 执行 resources/bin/sharp-worker.mjs。禁止 process.execPath（那是 Electron）
 * 和 ELECTRON_RUN_AS_NODE。shouldIsolateSharp() 等于 Boolean(process.versions.electron)：
 * 纯 Node 冒烟可以进程内 Sharp；Electron 里一律走隔离工作进程。
 *
 * 图片任务经 limitImage 串行，避免同一进程里重叠写入把 libvips 打崩。
 * 预占空间在旁路 .space 文件上，不要让 Sharp toFile 和 fallocate 抢同一个输出路径。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { findBinary, runCapture, unlinkQuiet, tmpPath, tmpDir, rmQuiet, extOf, defaultOutputPath, resolveSystemNode, envForSystemNode, findSharpWorker, sharpModuleRoot } from './bins'
import { atomicWriteOutput, failResult, isCancelRequested, cancelledResult, preflightOutput, remapIfCancelled, reserveOrFail, commitReserved, abortReserved, setPhase, limitImage, decorateProgress } from './jobs'

export interface ConvertImageRequest {
  inputPath: string
  /** 多图合成 PDF 时的额外图片（有序）。 */
  inputPaths?: string[]
  target: string
  outputPath?: string
  /** JPEG/WebP/AVIF 质量 1–100（默认 85） */
  quality?: number
}

const SHARP_TARGETS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'tif', 'avif'])
const FFMPEG_TARGETS = new Set(['bmp', 'ico', 'tga', 'ppm'])
const VIDEO_STILL_TARGETS = new Set(['mp4', 'webm'])
const EXTRA_TARGETS = new Set(['jp2', 'j2k', 'jxl', 'qoi'])
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw'])
const COMPLEX_EXTS = new Set(['psd', 'ai', 'jp2', 'j2k', 'jxl', 'qoi'])

type SharpFn = typeof import('sharp')
type SharpInstance = import('sharp').Sharp

async function resolveFfmpeg(): Promise<{ ffmpeg: string | null }> {
  return { ffmpeg: findBinary(['ffmpeg']) }
}

function resolveDcraw(): string | null {
  return resolveRawDecoders()[0] ?? null
}

function resolveRawDecoders(): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const name of ['dcraw_emu', 'simple_dcraw', 'dcraw']) {
    const bin = findBinary([name])
    if (bin && !seen.has(bin)) {
      seen.add(bin)
      found.push(bin)
    }
  }
  return found
}

function decoderEnv(bin: string): NodeJS.ProcessEnv {
  const dir = path.dirname(bin)
  if (process.platform === 'win32') {
    return { PATH: `${dir};${process.env.PATH || ''}` }
  }
  return { LD_LIBRARY_PATH: `${dir}${path.delimiter}${process.env.LD_LIBRARY_PATH || ''}` }
}

async function tiffLooksLive(tiffPath: string): Promise<boolean> {
  const fallback = () => fs.statSync(tiffPath).size > 1024
  try {
    if (shouldIsolateSharp()) {
      const r = await runSharpJob({ op: 'stats', inputPath: tiffPath })
      if (!r.ok || !r.channels) return fallback()
      return r.channels.some((c) => c.stdev > 1 || c.mean > 1)
    }
    const sharp = await loadSharp()
    if (!sharp) return fallback()
    const stats = await sharp(tiffPath).stats()
    return stats.channels.some((c) => c.stdev > 1 || c.mean > 1)
  } catch {
    return fallback()
  }
}

async function loadSharp(): Promise<SharpFn | null> {
  try {
    const mod = await import('sharp')
    const sharp = ((mod as { default?: SharpFn }).default ?? mod) as SharpFn
    const api = sharp as SharpFn & { cache?: (v: unknown) => void; concurrency?: (n: number) => void }
    try {
      api.cache?.({ memory: 0, files: 0, items: 0 })
      api.concurrency?.(1)
    } catch {
      /* 旧版 Sharp 可能没有这些 API */
    }
    return sharp
  } catch {
    return null
  }
}


type SharpJobRequest = {
  op: 'versions' | 'metadata' | 'stats' | 'convert' | 'toFile' | 'toBuffer' | 'rawToFile'
  inputPath?: string
  outputPath?: string
  target?: string
  quality?: number
  rotate?: boolean
  failOn?: string
  animated?: boolean
  raw?: boolean
  rawPath?: string
  width?: number
  height?: number
  channels?: number
}

type SharpJobResult = {
  ok: boolean
  error?: string
  outputPath?: string
  size?: number
  base64?: string
  bytes?: number
  width?: number
  height?: number
  format?: string
  hasAlpha?: boolean
  channels?: { mean: number; stdev: number }[]
  versions?: Record<string, string>
}

/**
 * 是否必须把 Sharp 隔离到系统 Node 子进程。
 * 判定是 Boolean(process.versions.electron)：在 Electron 里为 true，纯 Node 冒烟为 false。
 * 为 true 时禁止 process.execPath / ELECTRON_RUN_AS_NODE，必须走 sharp-worker.mjs。
 */
function shouldIsolateSharp(): boolean {
  return Boolean(process.versions.electron)
}

/** 通过系统 Node 调用 sharp-worker.mjs；环境必须经 envForSystemNode 清理。 */
function runSharpJob(req: SharpJobRequest, timeoutMs = 120_000): Promise<SharpJobResult> {
  return new Promise((resolve, reject) => {
    const node = resolveSystemNode()
    const worker = findSharpWorker()
    if (!node || !worker) {
      reject(new Error('未找到独立 Node.js 或 Sharp 工作进程，无法在 Electron 里安全运行图片引擎。'))
      return
    }
    const child = spawn(node, [worker], {
      cwd: sharpModuleRoot(),
      env: envForSystemNode(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 忽略 */
      }
      reject(new Error('Sharp 工作进程超时'))
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', (d) => {
      err += d
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      if (!text) {
        reject(new Error(err.trim() || 'Sharp 工作进程没有返回结果'))
        return
      }
      try {
        resolve(JSON.parse(text) as SharpJobResult)
      } catch {
        reject(new Error(`Sharp 工作进程返回无法解析：${text.slice(0, 400)} ${err}`.trim()))
      }
    })
    child.stdin?.end(JSON.stringify(req))
  })
}

async function isolatedOrLocal<T>(isolated: () => Promise<T>, local: () => Promise<T>): Promise<T> {
  if (shouldIsolateSharp()) return isolated()
  return local()
}

export function isImageGroup(group: string): boolean {
  return group === 'image'
}

export function isImageConvertibleTarget(target: string): boolean {
  const t = target.toLowerCase()
  if (t === 'pdf') return true
  if (SHARP_TARGETS.has(t)) return true
  if (FFMPEG_TARGETS.has(t)) return true
  if (VIDEO_STILL_TARGETS.has(t)) return true
  if (EXTRA_TARGETS.has(t)) return true
  return false
}

/** 探测 LibRaw / dcraw。经典 dcraw 往往解不了 CR3，优先 dcraw_emu。 */
export async function getLibrawHealthItem(): Promise<EngineHealthItem> {
  const bin = resolveDcraw()
  if (!bin) {
    return {
      id: 'libraw',
      name: 'libraw / dcraw',
      status: 'optional',
      covers: 'RAW',
      detail: '未找到 LibRaw（dcraw_emu）。可运行: node scripts/ensure-image-extras.mjs --install',
    }
  }
  const r = await runCapture(bin, [], 8_000)
  const text = `${r.stdout}\n${r.stderr}`
  const ver = text.match(/dcraw(?:_emu)?[^\n]*v?([\d.]+)/i)?.[1] || text.match(/LibRaw\s+([\d.]+)/i)?.[1]
  const name = path.basename(bin)
  return {
    id: 'libraw',
    name: 'libraw / dcraw',
    status: 'ready',
    covers: 'RAW',
    version: ver,
    path: bin,
    detail: name.includes('dcraw_emu')
      ? `${name}（LibRaw）已接入，支持 CR3 等新 RAW`
      : `${name} 已接入。经典 dcraw 无法正确解码 CR3，建议安装 LibRaw / dcraw_emu`,
  }
}

/** 探测 Sharp 模块是否安装。实际转换在 Electron 里仍须走隔离工作进程。 */
export async function getSharpHealthItem(): Promise<EngineHealthItem> {
  const sharp = await loadSharp()
  if (!sharp) {
    return {
      id: 'sharp',
      name: 'Sharp',
      status: 'missing',
      covers: '图片互转 / 多图→PDF',
      detail: '未安装 sharp 原生模块。请 npm install sharp 并允许 install scripts。',
    }
  }
  let version: string | undefined
  let heif = false
  try {
    const v = sharp.versions
    version = v?.sharp || undefined
    heif = Boolean(v?.heif)
  } catch {
    /* 忽略 */
  }
  const { ffmpeg } = await resolveFfmpeg()
  const dcraw = resolveDcraw()
  const extras: string[] = []
  if (heif) extras.push('HEIC(libheif)')
  extras.push(ffmpeg ? 'ICO/BMP/JPEG XL/JP2/QOI 经 FFmpeg' : 'JPEG XL/JP2/QOI 需 FFmpeg')
  extras.push(dcraw ? 'RAW 经 dcraw/libraw' : 'RAW 未找到 dcraw')
  extras.push('PSD 合成图 / AI（PDF 兼容）')
  return {
    id: 'sharp',
    name: 'Sharp',
    status: 'ready',
    covers: '图片互转 / 多图→PDF',
    version,
    detail: `jpg/png/webp/gif/tiff/avif${extras.length ? '；' + extras.join('；') : ''}`,
  }
}

interface Decoded {
  pipeline: SharpInstance
  cleanup?: string
}

function be16(buf: Buffer, off: number) {
  return buf.readUInt16BE(off)
}
function be32(buf: Buffer, off: number) {
  return buf.readUInt32BE(off)
}

/** 从 PSD 取出拼合后的合成图，不要用内嵌缩略图。 */
export function extractPsdComposite(buf: Buffer): { width: number; height: number; rgba: Buffer } {
  if (buf.length < 26 || buf.subarray(0, 4).toString('ascii') !== '8BPS') {
    throw new Error('不是有效的 PSD（缺少 8BPS 头）。')
  }
  const version = be16(buf, 4)
  if (version !== 1 && version !== 2) throw new Error(`不支持的 PSD 版本 ${version}`)
  const channels = be16(buf, 12)
  const height = be32(buf, 14)
  const width = be32(buf, 18)
  const depth = be16(buf, 22)
  const colorMode = be16(buf, 24)
  if (!width || !height || width > 20000 || height > 20000) {
    throw new Error(`PSD 尺寸异常：${width}×${height}`)
  }
  let p = 26
  const skipLen = (psb: boolean) => {
    if (p + (psb ? 8 : 4) > buf.length) throw new Error('PSD 结构不完整。')
    const n = psb ? Number(buf.readBigUInt64BE(p)) : be32(buf, p)
    p += psb ? 8 : 4
    p += n
    if (p > buf.length) throw new Error('PSD 结构不完整。')
  }
  skipLen(false) // color mode data
  skipLen(false) // image resources
  skipLen(version === 2) // layer and mask
  if (p + 2 > buf.length) throw new Error('PSD 缺少合成图像数据。')
  const compression = be16(buf, p)
  p += 2
  const ch = Math.max(1, channels)
  const planeBytes = width * height * (depth === 16 ? 2 : depth === 32 ? 4 : 1)
  const planes: Buffer[] = []

  const to8 = (sample: number, d: number) => {
    if (d === 8) return sample
    if (d === 16) return Math.min(255, sample >> 8)
    if (d === 32) return Math.min(255, Math.round(sample * 255))
    return sample & 0xff
  }

  const decodePlane = (raw: Buffer): Buffer => {
    const out = Buffer.alloc(width * height)
    if (depth === 8) {
      raw.copy(out, 0, 0, Math.min(raw.length, out.length))
      return out
    }
    if (depth === 16) {
      for (let i = 0; i < width * height; i++) {
        const v = i * 2 + 1 < raw.length ? raw.readUInt16BE(i * 2) : 0
        out[i] = to8(v, 16)
      }
      return out
    }
    throw new Error(`暂不支持 ${depth} 位 PSD 合成图。`)
  }

  if (compression === 0) {
    for (let c = 0; c < ch; c++) {
      const slice = buf.subarray(p + c * planeBytes, p + (c + 1) * planeBytes)
      if (slice.length < width * height && depth === 8) throw new Error('PSD 合成图数据不完整。')
      planes.push(decodePlane(Buffer.from(slice)))
    }
  } else if (compression === 1) {
    const rowCount = height * ch
    const lenSize = version === 2 ? 4 : 2
    const readLen = (off: number) => (version === 2 ? be32(buf, off) : be16(buf, off))
    const tableBytes = rowCount * lenSize
    if (p + tableBytes > buf.length) throw new Error('PSD RLE 行表不完整。')
    const lengths: number[] = []
    for (let i = 0; i < rowCount; i++) lengths.push(readLen(p + i * lenSize))
    p += tableBytes
    for (let c = 0; c < ch; c++) {
      const rowBytes: Buffer[] = []
      for (let y = 0; y < height; y++) {
        const n = lengths[c * height + y]
        if (p + n > buf.length) throw new Error('PSD RLE 数据不完整。')
        rowBytes.push(packbits(buf.subarray(p, p + n), width * (depth === 16 ? 2 : 1)))
        p += n
      }
      planes.push(decodePlane(Buffer.concat(rowBytes)))
    }
  } else {
    throw new Error(`不支持的 PSD 压缩类型 ${compression}。`)
  }

  const rgba = Buffer.alloc(width * height * 4)
  const rP = planes[0]
  const gP = colorMode === 1 ? planes[0] : planes[1] || planes[0]
  const bP = colorMode === 1 ? planes[0] : planes[2] || planes[0]
  const aP = colorMode === 3 && planes[3] ? planes[3] : null
  for (let i = 0; i < width * height; i++) {
    if (colorMode === 4 && planes.length >= 4) {
      // 简单把 CMYK 转成 RGB，避免后续 Sharp 色域异常
      const c = planes[0][i] / 255
      const m = planes[1][i] / 255
      const y = planes[2][i] / 255
      const k = planes[3][i] / 255
      rgba[i * 4] = Math.round(255 * (1 - c) * (1 - k))
      rgba[i * 4 + 1] = Math.round(255 * (1 - m) * (1 - k))
      rgba[i * 4 + 2] = Math.round(255 * (1 - y) * (1 - k))
      rgba[i * 4 + 3] = 255
    } else {
      rgba[i * 4] = rP[i]
      rgba[i * 4 + 1] = gP[i]
      rgba[i * 4 + 2] = bP[i]
      rgba[i * 4 + 3] = aP ? aP[i] : 255
    }
  }
  return { width, height, rgba }
}

function packbits(src: Buffer, expected: number): Buffer {
  const out = Buffer.alloc(expected)
  let i = 0
  let o = 0
  while (i < src.length && o < expected) {
    const n = src.readInt8(i)
    i += 1
    if (n >= 0) {
      const count = n + 1
      src.copy(out, o, i, i + count)
      i += count
      o += count
    } else if (n !== -128) {
      const count = 1 - n
      const v = i < src.length ? src[i] : 0
      i += 1
      out.fill(v, o, o + count)
      o += count
    }
  }
  return out
}

async function runFfmpegImage(ffmpeg: string, args: string[], timeoutMs = 120_000) {
  return runCapture(ffmpeg, args, timeoutMs)
}

async function ffmpegToPng(inputPath: string, outputPng: string): Promise<void> {
  const { ffmpeg } = await resolveFfmpeg()
  if (!ffmpeg) throw new Error('未找到 FFmpeg，无法预解码该格式。')
  const r = await runFfmpegImage(ffmpeg, [
    '-y',
    '-hide_banner',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-update',
    '1',
    outputPng,
  ])
  if (r.code !== 0 || !fs.existsSync(outputPng) || fs.statSync(outputPng).size < 8) {
    throw new Error(`FFmpeg 预解码失败：${(r.stderr || r.stdout).trim().slice(-400)}`)
  }
}

async function decodeRawToTiff(inputPath: string): Promise<string> {
  const decoders = resolveRawDecoders()
  if (decoders.length === 0) {
    throw new Error(
      `RAW（.${extOf(inputPath)}）需要 LibRaw（dcraw_emu）。未找到解码器。请运行: node scripts/ensure-image-extras.mjs --install`,
    )
  }
  const dir = tmpDir('mf-raw-')
  const ext = path.extname(inputPath) || '.dng'
  const tmpIn = path.join(dir, `input${ext}`)
  fs.copyFileSync(inputPath, tmpIn)
  const errors: string[] = []
  for (const bin of decoders) {
    const name = path.basename(bin).toLowerCase()
    const outTiff = path.join(dir, `${name}.tiff`)
    const args = name.includes('dcraw_emu')
      ? ['-T', '-w', '-Z', outTiff, tmpIn]
      : name.includes('simple_dcraw')
        ? ['-T', '-e', tmpIn]
        : ['-w', '-T', tmpIn]
    const r = await runCapture(bin, args, 180_000, { env: decoderEnv(bin) })
    const candidates = [
      outTiff,
      path.join(dir, 'input.tiff'),
      path.join(dir, 'input.tif'),
      tmpIn.replace(/\.[^.]+$/, '.tiff'),
      tmpIn.replace(/\.[^.]+$/, '.tif'),
      tmpIn + '.tiff',
    ]
    const hit = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).size > 32)
    if (!hit) {
      errors.push(`${path.basename(bin)} 码 ${r.code}：${`${r.stdout}\n${r.stderr}`.trim().slice(-200)}`)
      continue
    }
    if (!(await tiffLooksLive(hit))) {
      errors.push(`${path.basename(bin)} 输出几乎是全黑，视为解码失败（常见于不支持的 CR3）`)
      try {
        fs.unlinkSync(hit)
      } catch {
        /* 忽略 */
      }
      continue
    }
    return hit
  }
  rmQuiet(dir)
  throw new Error(
    `RAW 解码失败（.${extOf(inputPath)}）。已尝试：${decoders.map((d) => path.basename(d)).join(', ')}。\n${errors.join('\n')}`,
  )
}


function sniffAiKind(inputPath: string): 'pdf' | 'eps' | 'unknown' {
  const fd = fs.openSync(inputPath, 'r')
  const buf = Buffer.alloc(4096)
  let n = 0
  try {
    n = fs.readSync(fd, buf, 0, 4096, 0)
  } finally {
    fs.closeSync(fd)
  }
  const head = buf.subarray(0, n)
  const text = head.toString('latin1')
  if (head.subarray(0, 4).toString('ascii') === '%PDF' || text.includes('%PDF-')) return 'pdf'
  if (text.includes('%!PS-Adobe') || text.startsWith('%!PS') || text.includes('%%Creator: Adobe Illustrator')) {
    return 'eps'
  }
  return 'unknown'
}

async function decodeAiToPng(inputPath: string): Promise<string> {
  const kind = sniffAiKind(inputPath)
  const out = tmpPath('mf-ai', 'png')
  const prefix = out.replace(/\.png$/i, '')
  if (kind === 'pdf') {
    const pdftoppm = findBinary(['pdftoppm'])
    if (pdftoppm) {
      const r = await runCapture(pdftoppm, ['-png', '-r', '150', '-singlefile', inputPath, prefix], 120_000)
      const produced = prefix + '.png'
      if (r.code === 0 && fs.existsSync(produced) && fs.statSync(produced).size > 32) return produced
    }
  }
  if (kind === 'eps' || kind === 'pdf') {
    const gs = findBinary(['gs', 'gswin64c', 'gswin32c'])
    if (gs) {
      const r = await runCapture(
        gs,
        ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=png16m', '-r150', `-sOutputFile=${out}`, inputPath],
        120_000,
      )
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 32) return out
    }
  }
  // 最后再试 FFmpeg（对 PDF 兼容的 AI 文件往往有效）
  try {
    await ffmpegToPng(inputPath, out)
    return out
  } catch {
    /* 落入下一分支 */
  }
  unlinkQuiet(out)
  if (kind === 'eps') {
    throw new Error('这是旧版 EPS/PostScript 类型的 .ai，当前环境没有 Ghostscript，无法解析。请用 Illustrator 导出 PDF/PNG。')
  }
  throw new Error('无法解析该 .ai 文件（不是可识别的 PDF 兼容 AI，也不是可渲染的 EPS）。')
}

async function decodePsdToPng(inputPath: string, sharp?: SharpFn | null): Promise<string> {
  const out = tmpPath('mf-psd', 'png')
  try {
    const buf = fs.readFileSync(inputPath)
    const { width, height, rgba } = extractPsdComposite(buf)
    if (shouldIsolateSharp()) {
      const rawPath = tmpPath('mf-psd-raw', 'rgba')
      fs.writeFileSync(rawPath, rgba)
      try {
        const r = await runSharpJob({
          op: 'rawToFile',
          raw: true,
          rawPath,
          width,
          height,
          channels: 4,
          outputPath: out,
          target: 'png',
          rotate: false,
        })
        if (!r.ok) throw new Error(r.error || 'rawToFile failed')
      } finally {
        unlinkQuiet(rawPath)
      }
    } else {
      const fn = sharp || (await loadSharp())
      if (!fn) throw new Error('未安装 sharp')
      await fn(rgba, { raw: { width, height, channels: 4 } }).png().toFile(out)
    }
    if (fs.existsSync(out) && fs.statSync(out).size > 32) return out
  } catch (err) {
    unlinkQuiet(out)
    // 退回 FFmpeg
    try {
      await ffmpegToPng(inputPath, out)
      return out
    } catch (err2) {
      throw new Error(`PSD 合成图提取失败：${String(err)}；FFmpeg 回退亦失败：${String(err2)}`)
    }
  }
  return out
}

async function predecodeIfNeeded(inputPath: string, sharp?: SharpFn | null): Promise<string | null> {
  const ext = extOf(inputPath)
  if (RAW_EXTS.has(ext)) return decodeRawToTiff(inputPath)
  if (ext === 'psd') return decodePsdToPng(inputPath, sharp)
  if (ext === 'ai') return decodeAiToPng(inputPath)
  if (ext === 'jp2' || ext === 'j2k' || ext === 'jxl' || ext === 'qoi') {
    const out = tmpPath('mf-img-pre', 'png')
    const djxl = ext === 'jxl' ? findBinary(['djxl']) : null
    if (djxl) {
      const r = await runCapture(djxl, [inputPath, out], 120_000)
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 32) return out
    }
    const opj = ext === 'jp2' || ext === 'j2k' ? findBinary(['opj_decompress']) : null
    if (opj) {
      const r = await runCapture(opj, ['-i', inputPath, '-o', out], 120_000)
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 32) return out
    }
    const qoi = ext === 'qoi' ? findBinary(['qoiconv']) : null
    if (qoi) {
      const r = await runCapture(qoi, [inputPath, out], 120_000)
      if (r.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 32) return out
    }
    await ffmpegToPng(inputPath, out)
    return out
  }
  return null
}

async function decodeToPipeline(
  sharp: SharpFn,
  inputPath: string,
  onProgress: (ev: ConvertProgressEvent) => void,
  jobId: string,
): Promise<Decoded> {
  const ext = extOf(inputPath)
  if (RAW_EXTS.has(ext) || COMPLEX_EXTS.has(ext)) {
    onProgress({ jobId, percent: 12, message: `预解码 .${ext}…` })
    const raster = await predecodeIfNeeded(inputPath, sharp)
    if (!raster) throw new Error(`无法预解码 .${ext}`)
    return { pipeline: sharp(raster, { failOn: 'none' }), cleanup: raster }
  }

  const opts = { animated: ext === 'gif', failOn: 'none' as const }
  try {
    // 调用 metadata() 后不要复用同一条 pipeline：Electron + libvips 会在 VObject 赋值时中止。隔离模式下走 worker，这条只作用于纯 Node 冒烟。
    const probe = sharp(inputPath, opts)
    await probe.metadata()
    try {
      ;(probe as SharpInstance & { destroy?: () => void }).destroy?.()
    } catch {
      /* 忽略 */
    }
    return { pipeline: sharp(inputPath, opts) }
  } catch (err) {
    if (
      ['heic', 'heif', 'ico', 'bmp', 'tga'].includes(ext) ||
      /heif|heic|unsupported|Input file contains unsupported/i.test(String(err))
    ) {
      onProgress({ jobId, percent: 15, message: 'FFmpeg 预解码…' })
      const tmp = tmpPath('mf-img', 'png')
      await ffmpegToPng(inputPath, tmp)
      return { pipeline: sharp(tmp, { failOn: 'none' }), cleanup: tmp }
    }
    throw err
  }
}

async function writeWithSharp(
  pipeline: SharpInstance,
  outputPath: string,
  target: string,
  quality: number,
): Promise<void> {
  const t = target.toLowerCase() === 'jpeg' ? 'jpg' : target.toLowerCase()
  let out: SharpInstance = pipeline.clone().rotate()
  switch (t) {
    case 'jpg':
      out = out.jpeg({ quality, mozjpeg: true })
      break
    case 'png':
      out = out.png({ compressionLevel: 8 })
      break
    case 'webp':
      out = out.webp({ quality })
      break
    case 'avif':
      out = out.avif({ quality })
      break
    case 'gif':
      out = out.gif()
      break
    case 'tiff':
    case 'tif':
      out = out.tiff({ compression: 'lzw', quality })
      break
    default:
      throw new Error(`Sharp 不支持输出：${t}`)
  }
  await out.toFile(outputPath)
}

async function encodeViaFfmpegExtra(
  inputPng: string,
  outputPath: string,
  target: string,
): Promise<void> {
  const t = target.toLowerCase()
  if (t === 'jxl') {
    const cjxl = findBinary(['cjxl'])
    if (cjxl) {
      const r = await runCapture(cjxl, [inputPng, outputPath, '-q', '90'], 120_000)
      if (r.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 16) return
    }
  }
  if (t === 'jp2' || t === 'j2k') {
    const opj = findBinary(['opj_compress'])
    if (opj) {
      const r = await runCapture(opj, ['-i', inputPng, '-o', outputPath], 120_000)
      if (r.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 16) return
    }
  }
  if (t === 'qoi') {
    const qoi = findBinary(['qoiconv'])
    if (qoi) {
      const r = await runCapture(qoi, [inputPng, outputPath], 120_000)
      if (r.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 16) return
    }
  }
  const { ffmpeg } = await resolveFfmpeg()
  if (!ffmpeg) throw new Error(`目标 .${t} 需要 FFmpeg（或对应专用编码器），但未找到。`)
  const r = await runFfmpegImage(ffmpeg, [
    '-y',
    '-hide_banner',
    '-i',
    inputPng,
    '-frames:v',
    '1',
    '-update',
    '1',
    outputPath,
  ])
  if (r.code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 16) {
    throw new Error(`写出 .${t} 失败：${(r.stderr || r.stdout).trim().slice(-400)}`)
  }
}

async function convertViaFfmpegImage(
  inputPath: string,
  outputPath: string,
  target: string,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  const { ffmpeg } = await resolveFfmpeg()
  if (!ffmpeg) {
    return {
      jobId,
      ok: false,
      error: `目标 .${target} 需要 FFmpeg（Sharp 不直接输出该格式），但未找到 ffmpeg。`,
    }
  }
  onProgress({ jobId, percent: 20, message: `FFmpeg → .${target}` })
  const t = target.toLowerCase()
  const args = ['-y', '-hide_banner', '-i', inputPath]
  if (t === 'ico') {
    args.push(
      '-vf',
      'scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2',
    )
  }
  if (VIDEO_STILL_TARGETS.has(t)) {
    args.push(
      '-frames:v',
      '1',
      '-c:v',
      t === 'webm' ? 'libvpx-vp9' : 'libx264',
      '-pix_fmt',
      'yuv420p',
    )
    if (t === 'mp4') args.push('-movflags', '+faststart')
  } else {
    args.push('-frames:v', '1', '-update', '1')
  }
  args.push(outputPath)
  const r = await runCapture(ffmpeg, args)
  if (r.code !== 0 || !fs.existsSync(outputPath)) {
    return {
      jobId,
      ok: false,
      error: `FFmpeg 图片转换失败（.${t}）码 ${r.code}\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }
  onProgress({ jobId, percent: 100, message: '完成' })
  return { jobId, ok: true, outputPath }
}

async function imagesToPdf(
  paths: string[],
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  if (!paths.length) return { jobId, ok: false, error: '没有输入图片。' }
  for (const p of paths) {
    if (!fs.existsSync(p)) return { jobId, ok: false, error: `输入不存在：${p}` }
  }

  const sharp = shouldIsolateSharp() ? null : await loadSharp()
  if (!shouldIsolateSharp() && !sharp) {
    return { jobId, ok: false, error: '未安装 sharp，无法将图片嵌入 PDF。' }
  }
  if (shouldIsolateSharp() && (!resolveSystemNode() || !findSharpWorker())) {
    return failResult(jobId, 'E-IMAGE-SHARP', '未找到独立 Node.js，无法在 Electron 里安全运行 Sharp。')
  }

  const finalOut =
    outputPath ||
    (paths.length === 1
      ? defaultOutputPath(paths[0], 'pdf')
      : path.join(
          path.dirname(paths[0]),
          `${path.basename(paths[0], path.extname(paths[0]))}_images.pdf`,
        ))
  const disk = preflightOutput(jobId, finalOut, { kind: 'image', inputPaths: paths })
  if (!disk.ok) return disk.result

  onProgress({ jobId, percent: 5, message: '图片→PDF（pdf-lib）…' })
  const doc = await PDFDocument.create()

  for (let i = 0; i < paths.length; i++) {
    const inputPath = paths[i]
    const ext = extOf(inputPath)
    let embedBytes: Buffer
    let kind: 'png' | 'jpg'
    let cleanup: string | undefined
    try {
      if (shouldIsolateSharp()) {
        const pre = await predecodeIfNeeded(inputPath)
        cleanup = pre || undefined
        const source = pre || inputPath
        const meta = await runSharpJob({ op: 'metadata', inputPath: source })
        if (!meta.ok) throw new Error(meta.error || 'metadata failed')
        const preferJpeg = meta.hasAlpha !== true && ['jpg', 'jpeg', 'tif', 'tiff', 'bmp'].includes(ext)
        kind = preferJpeg ? 'jpg' : 'png'
        const buf = await runSharpJob({
          op: 'toBuffer',
          inputPath: source,
          target: kind,
          quality: 90,
          rotate: true,
        })
        if (!buf.ok || !buf.base64) throw new Error(buf.error || 'toBuffer failed')
        embedBytes = Buffer.from(buf.base64, 'base64')
      } else {
        const decoded = await decodeToPipeline(sharp!, inputPath, onProgress, jobId)
        cleanup = decoded.cleanup
        const meta = await decoded.pipeline.metadata()
        const preferJpeg =
          meta.hasAlpha !== true && ['jpg', 'jpeg', 'tif', 'tiff', 'bmp'].includes(ext)
        if (preferJpeg) {
          embedBytes = await decoded.pipeline.clone().rotate().jpeg({ quality: 90, mozjpeg: true }).toBuffer()
          kind = 'jpg'
        } else {
          embedBytes = await decoded.pipeline.clone().rotate().png().toBuffer()
          kind = 'png'
        }
      }
    } catch (err) {
      unlinkQuiet(cleanup)
      return { jobId, ok: false, error: `解码失败 ${inputPath}：${String(err)}` }
    }
    unlinkQuiet(cleanup)

    const image =
      kind === 'png' ? await doc.embedPng(embedBytes) : await doc.embedJpg(embedBytes)
    const page = doc.addPage([image.width, image.height])
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
    onProgress({
      jobId,
      percent: 5 + ((i + 1) / paths.length) * 90,
      message: `页 ${i + 1}/${paths.length}`,
    })
  }

  const saved = await doc.save()
  setPhase(jobId, 'finalize')
  const committed = atomicWriteOutput(jobId, finalOut, Buffer.from(saved), { kind: 'image', inputPaths: paths })
  if (!committed.ok) return committed
  onProgress({ jobId, percent: 100, message: '完成', phase: 'finalize' })
  return remapIfCancelled(jobId, { jobId, ok: true, outputPath: committed.outputPath, engineUsed: 'Sharp+pdf-lib' })
}

/** 图片转换入口，经 limitImage 串行；Electron 内的 Sharp 操作走 sharp-worker。 */
export async function convertImage(
  req: ConvertImageRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  return limitImage(() => convertImageUnlocked(req, jobId, onProgress))
}

async function convertImageUnlocked(
  req: ConvertImageRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const target = (req.target || '').toLowerCase()
  if (!target) return { jobId, ok: false, error: '未指定目标格式。' }

  if (target === 'pdf') {
    const paths = (req.inputPaths && req.inputPaths.length ? req.inputPaths : [req.inputPath]).filter(
      Boolean,
    )
    return imagesToPdf(paths, req.outputPath, jobId, onProgress)
  }

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return { jobId, ok: false, error: `输入文件不存在：${inputPath}` }
  }

  const outExt = target === 'jpeg' ? 'jpg' : target === 'tif' ? 'tiff' : target
  const outputPath = req.outputPath || defaultOutputPath(inputPath, outExt)
  const quality = Math.min(100, Math.max(1, req.quality ?? 85))
  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const disk = preflightOutput(jobId, outputPath, { kind: 'image', inputPaths: inputPath })
  if (!disk.ok) return disk.result

  onProgress({ jobId, percent: 5, message: '准备图片转换…' })

  const sharp = shouldIsolateSharp() ? null : await loadSharp()
  if (!shouldIsolateSharp() && !sharp) {
    return { jobId, ok: false, error: '未安装 sharp 原生模块。' }
  }
  if (shouldIsolateSharp() && (!resolveSystemNode() || !findSharpWorker())) {
    return failResult(jobId, 'E-IMAGE-SHARP', '未找到独立 Node.js，无法在 Electron 里安全运行 Sharp。')
  }

  const toPngFile = async (sourcePath: string, destPng: string) => {
    if (shouldIsolateSharp()) {
      const r = await runSharpJob({
        op: 'convert',
        inputPath: sourcePath,
        outputPath: destPng,
        target: 'png',
        rotate: true,
      })
      if (!r.ok) throw new Error(r.error || 'png convert failed')
      return
    }
    const decoded = await decodeToPipeline(sharp!, sourcePath, onProgress, jobId)
    try {
      await decoded.pipeline.clone().rotate().png().toFile(destPng)
    } finally {
      unlinkQuiet(decoded.cleanup)
    }
  }

  if (EXTRA_TARGETS.has(target)) {
    let cleanup: string | undefined
    const mid = tmpPath('mf-img-mid', 'png')
    try {
      const pre = await predecodeIfNeeded(inputPath, sharp)
      cleanup = pre || undefined
      await toPngFile(pre || inputPath, mid)
      unlinkQuiet(cleanup)
      cleanup = undefined
      onProgress({ jobId, percent: 60, message: `编码 .${target}` })
      await encodeViaFfmpegExtra(mid, outputPath, target)
      unlinkQuiet(mid)
      onProgress({ jobId, percent: 100, message: '完成' })
      return { jobId, ok: true, outputPath, engineUsed: 'Sharp+FFmpeg' }
    } catch (err) {
      unlinkQuiet(cleanup)
      unlinkQuiet(mid)
      return { jobId, ok: false, error: `图片转换失败：${String(err)}` }
    }
  }

  if (FFMPEG_TARGETS.has(target) || VIDEO_STILL_TARGETS.has(target)) {
    const inExt = extOf(inputPath)
    if (['heic', 'heif', ...RAW_EXTS, ...COMPLEX_EXTS].includes(inExt)) {
      let cleanup: string | undefined
      try {
        const pre = await predecodeIfNeeded(inputPath, sharp)
        cleanup = pre || undefined
        const tmp = tmpPath('mf-img-mid', 'png')
        await toPngFile(pre || inputPath, tmp)
        unlinkQuiet(cleanup)
        cleanup = undefined
        const result = await convertViaFfmpegImage(tmp, outputPath, target, jobId, onProgress)
        unlinkQuiet(tmp)
        return result
      } catch {
        unlinkQuiet(cleanup)
        /* 这些格式 FFmpeg 也许能直接读，继续往下试 */
      }
    }
    return convertViaFfmpegImage(inputPath, outputPath, target, jobId, onProgress)
  }

  if (!SHARP_TARGETS.has(target) && target !== 'jpg') {
    return { jobId, ok: false, error: `不支持的图片目标格式：${target}` }
  }

  let cleanup: string | undefined
  try {
    onProgress({ jobId, percent: 25, message: `Sharp → .${outExt}` })
    const pre = await predecodeIfNeeded(inputPath, sharp)
    cleanup = pre || undefined
    const source = pre || inputPath
    setPhase(jobId, 'finalize')
    const reserved = reserveOrFail(jobId, outputPath, { kind: 'image', inputPaths: inputPath })
    if (!reserved.ok) {
      unlinkQuiet(cleanup)
      return reserved.result
    }
    const isolated = tmpPath('mf-sharp-out', outExt)
    try {
      reserved.reserved.stopWatch()
      if (shouldIsolateSharp()) {
        const r = await runSharpJob({
          op: 'convert',
          inputPath: source,
          outputPath: isolated,
          target: outExt,
          quality,
          rotate: true,
        })
        if (!r.ok) throw new Error(r.error || 'convert failed')
      } else {
        const decoded = await decodeToPipeline(sharp!, source, onProgress, jobId)
        try {
          await writeWithSharp(decoded.pipeline, isolated, outExt, quality)
        } finally {
          unlinkQuiet(decoded.cleanup)
        }
      }
      if (!fs.existsSync(isolated) || fs.statSync(isolated).size <= 0) {
        throw new Error('Sharp 未写出有效文件')
      }
      fs.copyFileSync(isolated, reserved.reserved.tempPath)
    } catch (err) {
      unlinkQuiet(isolated)
      abortReserved(jobId, reserved.reserved)
      unlinkQuiet(cleanup)
      return failResult(jobId, 'E-IMAGE-FAILED', `图片转换失败：${String(err)}`, String(err))
    }
    unlinkQuiet(isolated)
    unlinkQuiet(cleanup)
    const committed = commitReserved(jobId, reserved.reserved, { verify: 'file' })
    if (!committed.ok) return committed
    onProgress({ jobId, percent: 100, message: '完成', phase: 'finalize' })
    return remapIfCancelled(jobId, { jobId, ok: true, outputPath: committed.outputPath })
  } catch (err) {
    unlinkQuiet(cleanup)
    return { jobId, ok: false, error: `图片转换失败：${String(err)}` }
  }
}

/** 供 PDF 引擎把 Poppler 渲出的页面再编成 WebP（同样遵守 Sharp 隔离）。 */
export async function rasterToWebp(
  inputImagePath: string,
  outputPath: string,
  quality = 85,
): Promise<void> {
  if (shouldIsolateSharp()) {
    const r = await runSharpJob({
      op: 'convert',
      inputPath: inputImagePath,
      outputPath,
      target: 'webp',
      quality,
      rotate: false,
    })
    if (!r.ok) throw new Error(r.error || 'webp convert failed')
    return
  }
  const sharp = await loadSharp()
  if (!sharp) throw new Error('sharp missing')
  await sharp(inputImagePath).webp({ quality }).toFile(outputPath)
}
