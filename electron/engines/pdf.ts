/**
 * PDF 引擎：格式转换、拆分、合并、加密/解密，以及经 Poppler + Tesseract 的 OCR。
 * 依赖 Poppler（pdftoppm / pdftotext）、qpdf，部分栅格输出会再交给隔离后的 Sharp。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { PDFDocument } from 'pdf-lib'
import { convertDocument } from './libreoffice'
import { rasterToWebp } from './image'
import { convertOcr } from './ocr'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { atomicWriteOutput, cancelledResult, failResult, isCancelRequested, preflightOutput, remapIfCancelled, setPhase, spawnTracked, decorateProgress } from './jobs'

export type PdfAction = 'convert' | 'split' | 'merge' | 'encrypt' | 'decrypt' | 'ocr'

export interface ConvertPdfRequest {
  inputPath: string
  /** 合并时的额外输入（有序）。省略则只使用 inputPath。 */
  inputPaths?: string[]
  target?: string
  action?: PdfAction
  /** 加密 / 解密用的用户密码 */
  password?: string
  ownerPassword?: string
  outputPath?: string
  /** pdftoppm 光栅化 DPI（默认 150） */
  dpi?: number
}

const IMAGE_TARGETS = new Set(['png', 'jpg', 'jpeg'])
const LO_PDF_TARGETS = new Set(['docx', 'odt', 'rtf', 'html', 'xlsx', 'xls', 'ods', 'pptx', 'odp', 'txt'])
// 也可以经 LibreOffice 出 txt，但纯文本抽取更推荐更快更保真的 pdftotext

function candidateBinDirs(): string[] {
  const dirs: string[] = []
  try {
    if (app.isPackaged) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      dirs.push(path.join(process.resourcesPath, 'bin', 'qpdf-toolkit', 'bin'))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
    }
  } catch {
    /* app may be unavailable outside Electron */
  }
  dirs.push(path.join(process.cwd(), 'bin'))
  dirs.push(path.join(process.cwd(), 'resources', 'bin'))
  dirs.push(path.join(process.cwd(), 'resources', 'bin', 'qpdf-toolkit', 'bin'))
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
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnTracked(bin, args, {
      windowsHide: true,
      env: opts?.env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, opts?.timeoutMs ?? 60000)
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

function qpdfEnv(qpdfPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // 便携工具包：.../qpdf-toolkit/bin/qpdf，依赖库在 ../lib
  const libDir = path.join(path.dirname(qpdfPath), '..', 'lib')
  if (fs.existsSync(libDir)) {
    const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
    env[key] = env[key] ? `${libDir}${path.delimiter}${env[key]}` : libDir
  }
  // 库文件若和二进制在同一目录也要能找到
  const siblingLib = path.join(path.dirname(qpdfPath), 'lib')
  if (fs.existsSync(siblingLib)) {
    const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
    env[key] = env[key] ? `${siblingLib}${path.delimiter}${env[key]}` : siblingLib
  }
  return env
}

function defaultOutputPath(inputPath: string, target: string): string {
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

function uniqueDir(baseDir: string, name: string): string {
  let candidate = path.join(baseDir, name)
  if (!fs.existsSync(candidate)) return candidate
  let i = 1
  while (true) {
    const p = path.join(baseDir, `${name}_${i}`)
    if (!fs.existsSync(p)) return p
    i += 1
  }
}

export function isPdfGroup(group: string): boolean {
  return group === 'pdf'
}

export function isPdfConvertibleTarget(target: string): boolean {
  const t = target.toLowerCase()
  if (IMAGE_TARGETS.has(t)) return true
  if (t === 'txt') return true
  if (t === 'webp') return true
  if (t === 'md') return false
  if (LO_PDF_TARGETS.has(t)) return true
  if (t === 'pdf') return true // encrypt/split/merge/decrypt
  return false
}

export async function resolvePoppler(): Promise<{
  pdftoppm: string | null
  pdftotext: string | null
  version?: string
}> {
  const pdftoppm = findBinary(['pdftoppm'])
  const pdftotext = findBinary(['pdftotext'])
  let version: string | undefined
  if (pdftoppm) {
    const r = await runCapture(pdftoppm, ['-v'], { timeoutMs: 8000 })
    const text = `${r.stdout}\n${r.stderr}`
    const m = text.match(/pdftoppm(?:\s+version)?\s+(\d[\d.]*)/i) || text.match(/poppler\s+(\d[\d.]*)/i)
    if (m) version = m[1]
  }
  return { pdftoppm, pdftotext, version }
}

export async function resolveQpdf(): Promise<{ qpdf: string | null; version?: string }> {
  const qpdf = findBinary(['qpdf'])
  let version: string | undefined
  if (qpdf) {
    const r = await runCapture(qpdf, ['--version'], { timeoutMs: 8000, env: qpdfEnv(qpdf) })
    const text = `${r.stdout}\n${r.stderr}`
    const m = text.match(/qpdf version\s+(\S+)/i)
    if (m) version = m[1]
  }
  return { qpdf, version }
}

/** 探测 pdftoppm / pdftotext（Poppler）是否可用。 */
export async function getPopplerHealthItem(): Promise<EngineHealthItem> {
  const { pdftoppm, pdftotext, version } = await resolvePoppler()
  const ready = Boolean(pdftoppm && pdftotext)
  return {
    id: 'poppler',
    name: 'Poppler',
    status: ready ? 'ready' : 'missing',
    covers: 'PDF→图片 / PDF→文本',
    version,
    path: pdftoppm ?? undefined,
    detail: ready
      ? `pdftoppm + pdftotext OK；合并/拆分页用 pdf-lib`
      : `缺少 ${[!pdftoppm && 'pdftoppm', !pdftotext && 'pdftotext'].filter(Boolean).join(' / ')}。Linux: apt install poppler-utils；或放入 resources/bin`,
  }
}

/** 探测 qpdf 是否可用（PDF 加密 / 解密）。 */
export async function getQpdfHealthItem(): Promise<EngineHealthItem> {
  const { qpdf, version } = await resolveQpdf()
  if (qpdf) {
    return {
      id: 'qpdf',
      name: 'qpdf',
      status: 'ready',
      covers: 'PDF 加密 / 解密',
      version,
      path: qpdf,
      detail: 'AES 加密/解密已接入；合并拆分用 pdf-lib',
    }
  }
  return {
    id: 'qpdf',
    name: 'qpdf',
    status: 'missing',
    covers: 'PDF 加密 / 解密',
    detail:
      '未找到 qpdf。Linux: apt install qpdf，或 node scripts/ensure-pdf-tools.mjs；也可放入 resources/bin/qpdf-toolkit',
  }
}

async function pdfToImages(
  inputPath: string,
  target: string,
  outputPath: string | undefined,
  dpi: number,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  const { pdftoppm } = await resolvePoppler()
  if (!pdftoppm) {
    return {
      jobId,
      ok: false,
      error: '未找到 pdftoppm（Poppler）。请安装 poppler-utils 或放入 resources/bin。',
    }
  }

  const t = target.toLowerCase() === 'jpeg' ? 'jpg' : target.toLowerCase()
  const outDir =
    outputPath && fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()
      ? outputPath
      : uniqueDir(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}_${t}`)
  fs.mkdirSync(outDir, { recursive: true })
  const prefix = path.join(outDir, 'page')
  const fmtFlag = t === 'png' ? '-png' : '-jpeg'

  onProgress({ jobId, percent: 10, message: `pdftoppm ${t} @${dpi}dpi…` })

  const r = await runCapture(
    pdftoppm,
    [fmtFlag, '-r', String(dpi), inputPath, prefix],
    { timeoutMs: 180_000 },
  )

  if (r.code !== 0) {
    return {
      jobId,
      ok: false,
      error: `pdftoppm 失败（码 ${r.code}）\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('page') && f.toLowerCase().endsWith(`.${t === 'jpg' ? 'jpg' : 'png'}`))
    .sort()
    .map((f) => path.join(outDir, f))

  // pdftoppm 的 jpeg 输出可能是 .jpg 或 .jpeg
  const filesAlt =
    files.length > 0
      ? files
      : fs
          .readdirSync(outDir)
          .filter((f) => /^page/i.test(f) && /\.(png|jpe?g)$/i.test(f))
          .sort()
          .map((f) => path.join(outDir, f))

  if (!filesAlt.length) {
    return { jobId, ok: false, error: `pdftoppm 未生成图片于 ${outDir}` }
  }

  onProgress({ jobId, percent: 100, message: `完成 ${filesAlt.length} 页` })
  return { jobId, ok: true, outputPath: filesAlt[0] }
}

async function pdfToText(
  inputPath: string,
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  const { pdftotext } = await resolvePoppler()
  if (!pdftotext) {
    return {
      jobId,
      ok: false,
      error: '未找到 pdftotext（Poppler）。请安装 poppler-utils 或放入 resources/bin。',
    }
  }
  const out = outputPath || defaultOutputPath(inputPath, 'txt')
  onProgress({ jobId, percent: 20, message: 'pdftotext…' })
  const r = await runCapture(pdftotext, ['-layout', inputPath, out], { timeoutMs: 120_000 })
  if (r.code !== 0 || !fs.existsSync(out)) {
    return {
      jobId,
      ok: false,
      error: `pdftotext 失败（码 ${r.code}）\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }
  onProgress({ jobId, percent: 100, message: '完成' })
  return { jobId, ok: true, outputPath: out }
}

async function mergePdfs(
  paths: string[],
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  if (paths.length < 2) {
    return failResult(jobId, 'E-PDF-MERGE-MIN', '合并至少需要 2 个 PDF 文件。')
  }
  for (const p of paths) {
    if (!fs.existsSync(p)) return { jobId, ok: false, error: `输入不存在：${p}` }
  }

  const out =
    outputPath ||
    path.join(
      path.dirname(paths[0]),
      `${path.basename(paths[0], path.extname(paths[0]))}_merged.pdf`,
    )
  const disk = preflightOutput(jobId, out, { kind: 'pdf', inputPaths: paths })
  if (!disk.ok) return disk.result

  onProgress({ jobId, percent: 10, message: 'pdf-lib 合并…' })
  const merged = await PDFDocument.create()
  for (let i = 0; i < paths.length; i++) {
    const bytes = fs.readFileSync(paths[i])
    let donor: PDFDocument
    try {
      donor = await PDFDocument.load(bytes, { ignoreEncryption: true })
    } catch (err) {
      return {
        jobId,
        ok: false,
        error: `无法加载 PDF（可能已加密）：${paths[i]}\n${String(err)}`,
      }
    }
    const pages = await merged.copyPages(donor, donor.getPageIndices())
    for (const page of pages) merged.addPage(page)
    onProgress({
      jobId,
      percent: 10 + ((i + 1) / paths.length) * 80,
      message: `已合并 ${i + 1}/${paths.length}`,
    })
  }
  const saved = await merged.save()
  setPhase(jobId, 'finalize')
  const committed = atomicWriteOutput(jobId, out, Buffer.from(saved), { kind: 'pdf', inputPaths: paths })
  if (!committed.ok) return committed
  onProgress({ jobId, percent: 100, message: '完成', phase: 'finalize' })
  return remapIfCancelled(jobId, { jobId, ok: true, outputPath: committed.outputPath })
}

async function splitPdf(
  inputPath: string,
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  const bytes = fs.readFileSync(inputPath)
  let src: PDFDocument
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  } catch (err) {
    return { jobId, ok: false, error: `无法加载 PDF：${String(err)}` }
  }
  const count = src.getPageCount()
  if (count < 1) return { jobId, ok: false, error: 'PDF 无页面' }

  const outDir =
    outputPath && (!fs.existsSync(outputPath) || fs.statSync(outputPath).isDirectory())
      ? (outputPath as string)
      : uniqueDir(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}_pages`)
  fs.mkdirSync(outDir, { recursive: true })

  onProgress({ jobId, percent: 5, message: `拆分 ${count} 页…` })
  let firstOut = ''
  for (let i = 0; i < count; i++) {
    const doc = await PDFDocument.create()
    const [page] = await doc.copyPages(src, [i])
    doc.addPage(page)
    const outFile = path.join(outDir, `page-${String(i + 1).padStart(3, '0')}.pdf`)
    fs.writeFileSync(outFile, await doc.save())
    if (!firstOut) firstOut = outFile
    onProgress({
      jobId,
      percent: 5 + ((i + 1) / count) * 90,
      message: `页 ${i + 1}/${count}`,
    })
  }
  onProgress({ jobId, percent: 100, message: `完成 ${count} 个文件` })
  return { jobId, ok: true, outputPath: firstOut || outDir }
}

async function encryptPdf(
  inputPath: string,
  password: string,
  ownerPassword: string | undefined,
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  if (!password) {
    return { jobId, ok: false, error: '加密需要提供用户密码（password）。' }
  }
  const { qpdf } = await resolveQpdf()
  if (!qpdf) {
    return {
      jobId,
      ok: false,
      error:
        '未找到 qpdf，无法加密。请 apt install qpdf，或运行 node scripts/ensure-pdf-tools.mjs。',
    }
  }
  const out = outputPath || defaultOutputPath(inputPath, 'pdf').replace(/\.pdf$/i, '_encrypted.pdf')
  const diskEnc = preflightOutput(jobId, out, { kind: 'pdf', inputPaths: inputPath })
  if (!diskEnc.ok) return diskEnc.result
  const owner = ownerPassword || password
  onProgress({ jobId, percent: 20, message: 'qpdf 加密…' })
  const r = await runCapture(
    qpdf,
    [
      '--encrypt',
      password,
      owner,
      '256',
      '--',
      inputPath,
      out,
    ],
    { timeoutMs: 120_000, env: qpdfEnv(qpdf) },
  )
  if (r.code !== 0 || !fs.existsSync(out)) {
    return {
      jobId,
      ok: false,
      error: `qpdf 加密失败（码 ${r.code}）\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }
  onProgress({ jobId, percent: 100, message: '完成' })
  return { jobId, ok: true, outputPath: out }
}

async function decryptPdf(
  inputPath: string,
  password: string,
  outputPath: string | undefined,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  if (!password) {
    return { jobId, ok: false, error: '解密需要提供密码（password）。' }
  }
  const { qpdf } = await resolveQpdf()
  if (!qpdf) {
    return {
      jobId,
      ok: false,
      error:
        '未找到 qpdf，无法解密。请 apt install qpdf，或运行 node scripts/ensure-pdf-tools.mjs。',
    }
  }
  const out = outputPath || defaultOutputPath(inputPath, 'pdf').replace(/\.pdf$/i, '_decrypted.pdf')
  const diskDec = preflightOutput(jobId, out, { kind: 'pdf', inputPaths: inputPath })
  if (!diskDec.ok) return diskDec.result
  onProgress({ jobId, percent: 20, message: 'qpdf 解密…' })
  const r = await runCapture(
    qpdf,
    [`--password=${password}`, '--decrypt', inputPath, out],
    { timeoutMs: 120_000, env: qpdfEnv(qpdf) },
  )
  if (r.code !== 0 || !fs.existsSync(out)) {
    return {
      jobId,
      ok: false,
      error: `qpdf 解密失败（码 ${r.code}）\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }
  onProgress({ jobId, percent: 100, message: '完成' })
  return { jobId, ok: true, outputPath: out }
}

/** 执行 PDF 转换、拆分、合并、加密解密或 OCR。 */
export async function convertPdf(
  req: ConvertPdfRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const action: PdfAction = req.action || 'convert'
  const inputPath = req.inputPath
  if (isCancelRequested(jobId)) return cancelledResult(jobId)

  if (action === 'ocr') {
    if (!inputPath || !fs.existsSync(inputPath)) {
      return { jobId, ok: false, error: `输入文件不存在：${inputPath}` }
    }
    const ocrTarget = (req.target || 'txt').toLowerCase()
    const target = ['txt', 'md', 'docx'].includes(ocrTarget) ? ocrTarget : 'txt'
    onProgress({ jobId, percent: 3, message: 'PDF OCR（Tesseract）…' })
    return convertOcr(
      {
        inputPath,
        target,
        outputPath: req.outputPath,
        dpi: req.dpi && req.dpi > 0 ? req.dpi : 200,
      },
      jobId,
      onProgress,
    )
  }

  if (action === 'merge') {
    const paths = (req.inputPaths && req.inputPaths.length ? req.inputPaths : [inputPath]).filter(
      Boolean,
    )
    return mergePdfs(paths, req.outputPath, jobId, onProgress)
  }

  if (!inputPath || !fs.existsSync(inputPath)) {
    return { jobId, ok: false, error: `输入文件不存在：${inputPath}` }
  }

  if (action === 'split') {
    return splitPdf(inputPath, req.outputPath, jobId, onProgress)
  }

  if (action === 'encrypt') {
    return encryptPdf(inputPath, req.password || '', req.ownerPassword, req.outputPath, jobId, onProgress)
  }

  if (action === 'decrypt') {
    return decryptPdf(inputPath, req.password || '', req.outputPath, jobId, onProgress)
  }

  // convert
  const target = (req.target || 'png').toLowerCase()
  const dpi = req.dpi && req.dpi > 0 ? req.dpi : 150

  if (target === 'webp') {
    // Poppler → PNG then Sharp → WebP
    const tmpDir = uniqueDir(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}_webp_tmp`)
    onProgress({ jobId, percent: 8, message: 'PDF→PNG（Poppler）…' })
    const pngResult = await pdfToImages(inputPath, 'png', tmpDir, dpi, jobId, (ev) => {
      onProgress({ ...ev, percent: Math.min(70, 8 + (ev.percent || 0) * 0.6) })
    })
    if (!pngResult.ok || !pngResult.outputPath) {
      return pngResult
    }
    const out = req.outputPath || defaultOutputPath(inputPath, 'webp')
    try {
      onProgress({ jobId, percent: 80, message: 'PNG→WebP（Sharp）…' })
      // 先转第一页；若有多页，把同批页面一并转换
      const pageDir = path.dirname(pngResult.outputPath)
      const pages = fs
        .readdirSync(pageDir)
        .filter((f) => /\.(png)$/i.test(f))
        .sort()
        .map((f) => path.join(pageDir, f))
      if (!pages.length) {
        return { jobId, ok: false, error: '未找到 Poppler 生成的 PNG' }
      }
      const firstWebp = pages.length === 1 ? out : path.join(path.dirname(out), `${path.basename(out, path.extname(out))}-1.webp`)
      await rasterToWebp(pages[0], pages.length === 1 ? out : firstWebp)
      for (let i = 1; i < pages.length; i++) {
        const wp = path.join(
          path.dirname(out),
          `${path.basename(out, path.extname(out))}-${i + 1}.webp`,
        )
        await rasterToWebp(pages[i], wp)
      }
      onProgress({ jobId, percent: 100, message: `完成 ${pages.length} 页 WebP` })
      return { jobId, ok: true, outputPath: pages.length === 1 ? out : firstWebp }
    } catch (err) {
      return { jobId, ok: false, error: `PDF→WebP 失败：${String(err)}` }
    }
  }
  if (target === 'md') {
    return {
      jobId,
      ok: false,
      error: 'PDF→Markdown 需要后续 Pandoc/专用链路。请先用 TXT 或 DOCX。',
    }
  }

  if (IMAGE_TARGETS.has(target)) {
    return pdfToImages(inputPath, target, req.outputPath, dpi, jobId, onProgress)
  }

  if (target === 'txt') {
    return pdfToText(inputPath, req.outputPath, jobId, onProgress)
  }

  if (LO_PDF_TARGETS.has(target) && target !== 'txt') {
    onProgress({ jobId, percent: 5, message: '经 LibreOffice 转换…' })
    return convertDocument(
      { inputPath, target, outputPath: req.outputPath },
      jobId,
      onProgress,
    )
  }

  if (target === 'pdf') {
    return {
      jobId,
      ok: false,
      error: '目标仍是 PDF。请选择拆分/合并/加密/解密操作，或选 PNG/JPG/TXT/DOCX 等目标。',
    }
  }

  return {
    jobId,
    ok: false,
    error: `不支持的 PDF 目标格式：${target}`,
  }
}
