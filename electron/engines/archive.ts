/**
 * 压缩包引擎：多文件打成 ZIP，或把 ZIP 解压到源文件旁的文件夹。
 * 尽量按 UTF-8 保留中文文件名；不是合法 UTF-8 时再尝试 GBK。
 */
import { crc32 } from 'node:zlib'
import { inflateRawSync, deflateRawSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import type { ConvertProgressEvent, ConvertResult } from './types'
import { defaultOutputPath, ensureDir, extOf, uniqueDir, rmQuiet } from './bins'
import {
  abortReserved,
  cancelledResult,
  checkDiskSpace,
  commitReserved,
  failResult,
  isCancelRequested,
  remapIfCancelled,
  reserveOrFail,
  setPhase,
  writeIntoReserved, decorateProgress } from './jobs'

export interface ConvertArchiveRequest {
  inputPath: string
  /** 打进同一个 zip 的额外文件（有序）。 */
  inputPaths?: string[]
  /** `zip` 表示打包；`解压` / `unzip` / `dir` / `folder` 表示解压 */
  target: string
  outputPath?: string
}

const UNPACK_TARGETS = new Set(['解压', 'unzip', 'extract', 'dir', 'folder', 'unpacked'])

function dosTimeDate(d = new Date()): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

function decodeName(buf: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return buf.toString('utf8')
  const asUtf = buf.toString('utf8')
  // 能往返解码且没有替换字符的 UTF-8 优先
  if (Buffer.from(asUtf, 'utf8').equals(buf) && !asUtf.includes('\uFFFD')) return asUtf
  try {
    const gbk = new TextDecoder('gbk').decode(buf)
    if (gbk && !gbk.includes('\uFFFD')) return gbk
  } catch {
    /* 没有 iconv-lite/gbk 解码时忽略 */
  }
  try {
    const g = new TextDecoder('gb18030').decode(buf)
    if (g && !g.includes('\uFFFD')) return g
  } catch {
    /* 忽略 */
  }
  return asUtf
}

function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' ) return root
  const parts: string[] = []
  for (const seg of cleaned.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    parts.push(seg)
  }
  const full = path.join(root, ...parts)
  const relTo = path.relative(path.resolve(root), path.resolve(full))
  if (relTo.startsWith('..') || path.isAbsolute(relTo)) return null
  return full
}

interface ZipEntryMeta {
  name: string
  method: number
  crc: number
  compSize: number
  uncompSize: number
  localOff: number
  isDir: boolean
}

function parseCentralDirectory(buf: Buffer): ZipEntryMeta[] {
  // 找 EOCD（普通压缩包不考虑 zip64，只扫最后 64k）
  const maxScan = Math.min(buf.length, 65535 + 22)
  let eocd = -1
  for (let i = buf.length - 22; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到目录结束标记）。')
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff = buf.readUInt32LE(eocd + 16)
  const commentLen = buf.readUInt16LE(eocd + 20)
  if (cdOff + cdSize > buf.length) throw new Error('ZIP 中央目录偏移无效（可能是 ZIP64，暂不支持）。')
  void commentLen
  const entries: ZipEntryMeta[] = []
  let p = cdOff
  const end = cdOff + cdSize
  while (p + 46 <= end) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen2 = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen)
    const name = decodeName(nameBuf, Boolean(flags & 0x0800))
    const isDir = name.endsWith('/') || name.endsWith('\\')
    entries.push({ name, method, crc, compSize, uncompSize, localOff, isDir })
    p += 46 + nameLen + extraLen + commentLen2
  }
  return entries
}

function readLocalData(buf: Buffer, entry: ZipEntryMeta): Buffer {
  const off = entry.localOff
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) {
    throw new Error(`ZIP 本地头损坏：${entry.name}`)
  }
  const flags = buf.readUInt16LE(off + 6)
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  let dataStart = off + 30 + nameLen + extraLen
  let compSize = entry.compSize
  if (flags & 0x0008) {
    // 数据后面可能有 data descriptor；大小以中央目录为准
    compSize = entry.compSize
  }
  const comp = buf.subarray(dataStart, dataStart + compSize)
  if (entry.method === 0) return Buffer.from(comp)
  if (entry.method === 8) {
    try {
      return inflateRawSync(comp)
    } catch (err) {
      throw new Error(`解压失败（${entry.name}）：${String(err)}`)
    }
  }
  throw new Error(`不支持的 ZIP 压缩方法 ${entry.method}（${entry.name}）。仅支持 store / deflate。`)
}

/** 解压 zip 缓冲区到目录，尽量保留 UTF-8 / GBK 文件名。 */
export function unpackZipBuffer(buf: Buffer, destDir: string): string[] {
  ensureDir(destDir)
  const entries = parseCentralDirectory(buf)
  const written: string[] = []
  for (const e of entries) {
    const full = safeJoin(destDir, e.name)
    if (!full) throw new Error(`拒绝写入危险路径：${e.name}`)
    if (e.isDir) {
      ensureDir(full)
      continue
    }
    ensureDir(path.dirname(full))
    const data = readLocalData(buf, e)
    if (e.uncompSize && data.length !== e.uncompSize) {
      throw new Error(`解压大小不匹配：${e.name}（${data.length} ≠ ${e.uncompSize}）`)
    }
    if (e.crc && crc32(data) !== e.crc) {
      throw new Error(`CRC 校验失败：${e.name}`)
    }
    fs.writeFileSync(full, data)
    written.push(full)
  }
  return written
}

interface PackItem {
  diskPath?: string
  name: string
  data?: Buffer
}

function collectPackItems(paths: string[]): PackItem[] {
  const items: PackItem[] = []
  const walk = (abs: string, rel: string) => {
    const st = fs.statSync(abs)
    if (st.isDirectory()) {
      const kids = fs.readdirSync(abs)
      if (!kids.length) {
        items.push({ name: rel.endsWith('/') ? rel : rel + '/', data: Buffer.alloc(0) })
        return
      }
      for (const k of kids) {
        walk(path.join(abs, k), rel ? `${rel.replace(/\/$/, '')}/${k}` : k)
      }
    } else if (st.isFile()) {
      items.push({ diskPath: abs, name: rel })
    }
  }
  for (const p of paths) {
    if (!p || !fs.existsSync(p)) throw new Error(`输入不存在：${p}`)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, path.basename(p))
    else items.push({ diskPath: p, name: path.basename(p) })
  }
  return items
}

/** 把一组路径打成 zip 缓冲区（内存）。 */
export function buildZipBuffer(paths: string[]): Buffer {
  const items = collectPackItems(paths)
  if (!items.length) throw new Error('没有可打包的文件。')
  const chunks: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const now = dosTimeDate()
  for (const item of items) {
    const isDir = item.name.endsWith('/')
    const data = isDir ? Buffer.alloc(0) : item.data || fs.readFileSync(item.diskPath!)
    const name = item.name.replace(/\\/g, '/')
    const nameBuf = Buffer.from(name, 'utf8')
    const method = isDir || data.length === 0 ? 0 : 8
    const comp = method === 8 ? deflateRawSync(data, { level: 9 }) : data
    const crc = data.length ? crc32(data) : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(now.time, 10)
    local.writeUInt16LE(now.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, comp)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // ver made
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(now.time, 12)
    central.writeUInt16LE(now.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(isDir ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cdStart = offset
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

export function packZip(paths: string[], outputPath: string): void {
  const buf = buildZipBuffer(paths)
  ensureDir(path.dirname(outputPath))
  fs.writeFileSync(outputPath, buf)
}

export function isArchiveGroup(group: string): boolean {
  return group === 'archive'
}

export function isUnpackTarget(target: string): boolean {
  const t = target.toLowerCase()
  return UNPACK_TARGETS.has(target) || UNPACK_TARGETS.has(t)
}

/** 多文件打包为 zip，或把 zip 解压到源文件旁的文件夹。 */
export async function convertArchive(
  req: ConvertArchiveRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const target = (req.target || '').trim()
  if (!target) return failResult(jobId, 'E-ARCHIVE', '未指定目标（zip 或 解压）。')

  const paths = (req.inputPaths && req.inputPaths.length ? req.inputPaths : [req.inputPath]).filter(Boolean)
  if (!paths.length) return failResult(jobId, 'E-PATH-MISSING', '没有输入文件。')
  for (const p of paths) {
    if (!fs.existsSync(p)) return failResult(jobId, 'E-PATH-MISSING', `输入不存在：${p}`)
  }

  const allZip = paths.every((p) => extOf(p) === 'zip' && fs.statSync(p).isFile())
  const wantUnpack = isUnpackTarget(target) || (allZip && target.toLowerCase() === 'zip' && paths.length === 1)

  if (wantUnpack) {
    const zipPaths = paths.filter((p) => extOf(p) === 'zip')
    if (!zipPaths.length) return failResult(jobId, 'E-ARCHIVE', '解压需要 .zip 输入。')
    if (isCancelRequested(jobId)) return cancelledResult(jobId)
    const destProbe =
      req.outputPath && zipPaths.length === 1 && !req.outputPath.toLowerCase().endsWith('.zip')
        ? req.outputPath
        : path.dirname(zipPaths[0])
    const diskErr = checkDiskSpace(
      jobId,
      destProbe,
      zipPaths.reduce((n, zp) => n + (fs.existsSync(zp) ? fs.statSync(zp).size * 3 : 0), 0) + 8 * 1024 * 1024,
    )
    if (diskErr) return diskErr
    const outputs: string[] = []
    for (let i = 0; i < zipPaths.length; i++) {
      if (isCancelRequested(jobId)) {
        for (const d of outputs) rmQuiet(d)
        return cancelledResult(jobId)
      }
      const zp = zipPaths[i]
      onProgress({
        jobId,
        percent: 5 + (i / zipPaths.length) * 90,
        message: `解压 ${path.basename(zp)}…`,
        phase: 'convert',
      })
      const parent = req.outputPath && zipPaths.length === 1 && !req.outputPath.toLowerCase().endsWith('.zip')
        ? path.dirname(req.outputPath)
        : path.dirname(zp)
      const base = path.basename(zp, path.extname(zp))
      const dest =
        req.outputPath && zipPaths.length === 1 && !req.outputPath.toLowerCase().endsWith('.zip')
          ? req.outputPath
          : uniqueDir(parent, base)
      try {
        const buf = fs.readFileSync(zp)
        const files = unpackZipBuffer(buf, dest)
        if (!files.length && !fs.existsSync(dest)) {
          return failResult(jobId, 'E-ARCHIVE', `解压结果为空：${zp}`)
        }
        outputs.push(dest)
      } catch (err) {
        return failResult(jobId, 'E-ARCHIVE', `解压失败：${String(err)}`, String(err))
      }
    }
    onProgress({ jobId, percent: 100, message: '完成' })
    return remapIfCancelled(jobId, {
      jobId,
      ok: true,
      outputPath: outputs[0],
      outputPaths: outputs,
      engineUsed: '内置 ZIP',
      message: `已解压 ${outputs.length} 个压缩包`,
    })
  }

  if (target.toLowerCase() !== 'zip') {
    return failResult(jobId, 'E-ARCHIVE', `压缩包目标只能是「zip」或「解压」，收到：${target}`)
  }

  const first = paths[0]
  const out =
    req.outputPath ||
    (paths.length === 1
      ? defaultOutputPath(first, 'zip')
      : path.join(path.dirname(first), `${path.basename(first, path.extname(first))}_archive.zip`))

  if (isCancelRequested(jobId)) return cancelledResult(jobId)

  const reserved = reserveOrFail(jobId, out, { kind: 'zip', inputPaths: paths })
  if (!reserved.ok) return reserved.result

  setPhase(jobId, 'pack')
  onProgress({ jobId, percent: 10, message: `打包 ${paths.length} 项 → ZIP…`, phase: 'pack' })
  try {
    const buf = buildZipBuffer(paths)
    writeIntoReserved(reserved.reserved, buf)
  } catch (err) {
    abortReserved(jobId, reserved.reserved)
    return failResult(jobId, 'E-ARCHIVE', `打包失败：${String(err)}`, String(err))
  }

  setPhase(jobId, 'finalize')
  onProgress({ jobId, percent: 95, message: '正在校验压缩包…', phase: 'finalize' })
  const committed = commitReserved(jobId, reserved.reserved, { verify: 'zip' })
  if (!committed.ok) return committed
  onProgress({ jobId, percent: 100, message: '完成', phase: 'finalize' })
  return remapIfCancelled(jobId, { jobId, ok: true, outputPath: committed.outputPath, engineUsed: '内置 ZIP' })
}
