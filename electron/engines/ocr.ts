/**
 * OCR 引擎：Tesseract 把图片或 PDF 页面识别成 txt / md / docx。
 * PDF 先经 Poppler 光栅化；docx 需要时再交给串行的 LibreOffice。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { convertDocument } from './libreoffice'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { cancelledResult, failResult, isCancelRequested, preflightOutput, remapIfCancelled, spawnTracked, decorateProgress } from './jobs'

export interface ConvertOcrRequest {
  inputPath: string
  /** txt | md | docx（默认 txt） */
  target?: string
  outputPath?: string
  /** 覆盖语言，例如 "chi_sim+eng"。默认用当前能找到的最佳组合。 */
  lang?: string
  /** PDF 输入时 pdftoppm 的 DPI（默认 200） */
  dpi?: number
}

const OCR_TARGETS = new Set(['txt', 'md', 'docx'])
const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif', 'ppm', 'pnm',
])
const REQUIRED_LANGS = ['chi_sim', 'eng'] as const

function candidateBinDirs(): string[] {
  const dirs: string[] = []
  try {
    if (app.isPackaged) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
    }
  } catch {
    /* 不在 Electron 里 */
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
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnTracked(bin, args, { windowsHide: true })
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

function extOf(p: string): string {
  return path.extname(p).replace(/^\./, '').toLowerCase()
}

function defaultOutputPath(inputPath: string, target: string): string {
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const ext = target.toLowerCase()
  let candidate = path.join(dir, `${base}.${ext}`)
  if (candidate.toLowerCase() === inputPath.toLowerCase()) {
    candidate = path.join(dir, `${base}_ocr.${ext}`)
  }
  if (!fs.existsSync(candidate)) return candidate
  let i = 1
  while (true) {
    const p = path.join(dir, `${base}_ocr_${i}.${ext}`)
    if (!fs.existsSync(p)) return p
    i += 1
  }
}

function rmrfQuiet(p: string) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

export function isOcrTarget(target: string): boolean {
  return OCR_TARGETS.has(target.toLowerCase())
}

export async function resolveTesseract(): Promise<{
  tesseract: string | null
  version?: string
  langs: string[]
  tessdata?: string
}> {
  const tesseract = findBinary(['tesseract'])
  if (!tesseract) {
    return { tesseract: null, langs: [] }
  }
  const ver = await runCapture(tesseract, ['--version'], 8000)
  const verText = `${ver.stdout}\n${ver.stderr}`
  const m = verText.match(/tesseract\s+(\S+)/i)
  const version = m?.[1]

  const langR = await runCapture(tesseract, ['--list-langs'], 8000)
  const langText = `${langR.stdout}\n${langR.stderr}`
  const langs = langText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/list of available|available languages/i.test(l))

  let tessdata: string | undefined
  const dataHint = verText.match(/TESSDATA_PREFIX[^\n]*/i)
  if (dataHint) tessdata = dataHint[0]
  // Debian 上常见的 tessdata 路径
  const common = '/usr/share/tesseract-ocr/5/tessdata'
  if (!tessdata && fs.existsSync(common)) tessdata = common

  return { tesseract, version, langs, tessdata }
}

function pickLangString(
  available: string[],
  override?: string,
): { lang: string; missing: string[] } {
  if (override && override.trim()) {
    const wanted = override
      .split(/[+\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const missing = wanted.filter((w) => !available.includes(w))
    return { lang: wanted.join('+'), missing }
  }
  const haveChi = available.includes('chi_sim')
  const haveEng = available.includes('eng')
  if (haveChi && haveEng) return { lang: 'chi_sim+eng', missing: [] }
  if (haveChi) return { lang: 'chi_sim', missing: [] }
  if (haveEng) return { lang: 'eng', missing: [] }
  const missing = REQUIRED_LANGS.filter((l) => !available.includes(l))
  return { lang: '', missing: missing.length ? missing : ['chi_sim', 'eng'] }
}

/** 探测 Tesseract 及常用语言包（chi_sim / eng）。 */
export async function getTesseractHealthItem(): Promise<EngineHealthItem> {
  const { tesseract, version, langs, tessdata } = await resolveTesseract()
  if (!tesseract) {
    return {
      id: 'tesseract',
      name: 'Tesseract OCR',
      status: 'missing',
      covers: 'OCR（图片/扫描 PDF → 文本）',
      detail:
        '未找到 tesseract。Linux: apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng；或 node scripts/ensure-tesseract.mjs；也可放入 resources/bin',
    }
  }
  const haveChi = langs.includes('chi_sim')
  const haveEng = langs.includes('eng')
  const ready = haveChi || haveEng
  const missingLangs = REQUIRED_LANGS.filter((l) => !langs.includes(l))
  return {
    id: 'tesseract',
    name: 'Tesseract OCR',
    status: ready ? 'ready' : 'missing',
    covers: 'OCR（图片/扫描 PDF → TXT/MD/DOCX）',
    version,
    path: tesseract,
    detail: ready
      ? `语言: ${langs.filter((l) => l !== 'osd').join(', ') || '(无)'}；默认 ${haveChi && haveEng ? 'chi_sim+eng' : haveChi ? 'chi_sim' : 'eng'}${tessdata ? `；${tessdata}` : ''}${missingLangs.length ? `；缺少推荐包: ${missingLangs.join(', ')}` : ''}`
      : `已找到 tesseract，但缺少语言包（需要 chi_sim 和/或 eng）。请安装 tesseract-ocr-chi-sim / tesseract-ocr-eng。当前: ${langs.join(', ') || '(空)'}`,
  }
}

async function ocrImageFile(
  tesseract: string,
  imagePath: string,
  lang: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  // 识别到 stdout：tesseract img stdout -l lang
  const r = await runCapture(tesseract, [imagePath, 'stdout', '-l', lang, '--psm', '3'], 180_000)
  if (r.code !== 0) {
    const err = (r.stderr || r.stdout).trim()
    if (/Error opening data file|Failed loading language|Could not initialize/i.test(err)) {
      return {
        ok: false,
        error: `Tesseract 语言包加载失败（-l ${lang}）。请安装对应语言包（chi_sim / eng）。\n${err.slice(-500)}`,
      }
    }
    return {
      ok: false,
      error: `Tesseract 失败（码 ${r.code}）\n${err.slice(-500)}`,
    }
  }
  return { ok: true, text: r.stdout }
}

async function pdfToPngPages(
  inputPath: string,
  dpi: number,
  tmpDir: string,
): Promise<{ ok: true; pages: string[] } | { ok: false; error: string }> {
  const pdftoppm = findBinary(['pdftoppm'])
  if (!pdftoppm) {
    return {
      ok: false,
      error: '扫描 PDF OCR 需要 pdftoppm（Poppler）。请安装 poppler-utils 或放入 resources/bin。',
    }
  }
  const prefix = path.join(tmpDir, 'page')
  const r = await runCapture(
    pdftoppm,
    ['-png', '-r', String(dpi), inputPath, prefix],
    180_000,
  )
  if (r.code !== 0) {
    return {
      ok: false,
      error: `pdftoppm 失败（码 ${r.code}）\n${(r.stderr || r.stdout).trim().slice(-500)}`,
    }
  }
  const pages = fs
    .readdirSync(tmpDir)
    .filter((f) => /^page/i.test(f) && /\.png$/i.test(f))
    .sort()
    .map((f) => path.join(tmpDir, f))
  if (!pages.length) {
    return { ok: false, error: `pdftoppm 未生成 PNG：${tmpDir}` }
  }
  return { ok: true, pages }
}

async function writeOcrOutput(
  text: string,
  target: string,
  outputPath: string,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  const t = target.toLowerCase()
  if (t === 'txt') {
    fs.writeFileSync(outputPath, text, 'utf8')
    onProgress({ jobId, percent: 100, message: '完成' })
    return { jobId, ok: true, outputPath }
  }
  if (t === 'md') {
    const body = text.trim() ? `${text.trim()}\n` : ''
    const md = `# OCR Result\n\n${body}`
    fs.writeFileSync(outputPath, md, 'utf8')
    onProgress({ jobId, percent: 100, message: '完成' })
    return { jobId, ok: true, outputPath }
  }
  if (t === 'docx') {
    // 先写临时 TXT，再经串行的 LibreOffice 转成 DOCX
    const tmpTxt = path.join(
      os.tmpdir(),
      `mf-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    )
    fs.writeFileSync(tmpTxt, text, 'utf8')
    onProgress({ jobId, percent: 85, message: 'LibreOffice TXT→DOCX…' })
    try {
      const result = await convertDocument(
        { inputPath: tmpTxt, target: 'docx', outputPath },
        jobId,
        (ev) => {
          onProgress({
            ...ev,
            percent: Math.min(99, 85 + (ev.percent || 0) * 0.14),
          })
        },
      )
      try {
        fs.unlinkSync(tmpTxt)
      } catch {
        /* 忽略 */
      }
      if (!result.ok) {
        // 不要手写一份假的 UTF-8「docx」；保留错误，同时尽量提供 txt
        return {
          jobId,
          ok: false,
          error: `OCR 文本已识别，但 LibreOffice 转 DOCX 失败：${result.error || 'unknown'}。可改目标为 TXT/MD。`,
        }
      }
      onProgress({ jobId, percent: 100, message: '完成' })
      return result
    } catch (err) {
      try {
        fs.unlinkSync(tmpTxt)
      } catch {
        /* 忽略 */
      }
      return {
        jobId,
        ok: false,
        error: `OCR→DOCX 失败：${String(err)}。可改目标为 TXT/MD。`,
      }
    }
  }
  return { jobId, ok: false, error: `不支持的 OCR 目标：${target}（支持 txt / md / docx）` }
}

/** 把图片或 PDF 页面识别成 txt / md / docx。 */
export async function convertOcr(
  req: ConvertOcrRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }

  const target = (req.target || 'txt').toLowerCase()
  if (!OCR_TARGETS.has(target)) {
    return {
      jobId,
      ok: false,
      error: `OCR 目标仅支持 txt / md / docx，收到：${target}`,
    }
  }

  const { tesseract, langs } = await resolveTesseract()
  if (!tesseract) {
    return {
      jobId,
      ok: false,
      error:
        '未找到 Tesseract。请安装：sudo apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng；或运行 node scripts/ensure-tesseract.mjs；或放入 resources/bin。',
      errorCode: 'E-OCR-MISSING',
    }
  }

  const { lang, missing } = pickLangString(langs, req.lang)
  if (!lang || missing.length) {
    return {
      jobId,
      ok: false,
      error: `缺少 Tesseract 语言包：${(missing.length ? missing : ['chi_sim', 'eng']).join(', ')}。请安装 tesseract-ocr-chi-sim 和/或 tesseract-ocr-eng。当前可用：${langs.join(', ') || '(无)'}`,
    }
  }

  const outputPath = req.outputPath || defaultOutputPath(inputPath, target)
  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const disk = preflightOutput(jobId, outputPath, { kind: 'ocr', inputPaths: inputPath })
  if (!disk.ok) return disk.result
  const ext = extOf(inputPath)
  const dpi = req.dpi && req.dpi > 0 ? req.dpi : 200

  onProgress({ jobId, percent: 5, message: `Tesseract OCR（${lang}）…` })

  let text = ''
  let tmpDir: string | null = null

  try {
    if (ext === 'pdf') {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ocr-pdf-'))
      onProgress({ jobId, percent: 10, message: `PDF→PNG @${dpi}dpi…` })
      const pages = await pdfToPngPages(inputPath, dpi, tmpDir)
      if (!pages.ok) {
        return { jobId, ok: false, error: pages.error }
      }
      const parts: string[] = []
      for (let i = 0; i < pages.pages.length; i++) {
        onProgress({
          jobId,
          percent: 15 + ((i + 1) / pages.pages.length) * 65,
          message: `OCR 页 ${i + 1}/${pages.pages.length}`,
        })
        const one = await ocrImageFile(tesseract, pages.pages[i], lang)
        if (!one.ok) {
          return { jobId, ok: false, error: one.error }
        }
        parts.push(one.text.trim())
      }
      text = parts.filter(Boolean).join('\n\n---\n\n')
    } else if (IMAGE_EXTS.has(ext) || !ext) {
      // 没有后缀或不常见的栅格也交给 tesseract 判断
      onProgress({ jobId, percent: 30, message: `OCR 图片（${lang}）…` })
      const one = await ocrImageFile(tesseract, inputPath, lang)
      if (!one.ok) {
        return { jobId, ok: false, error: one.error }
      }
      text = one.text
    } else {
      return {
        jobId,
        ok: false,
        error: `OCR 输入需为图片或 PDF，收到 .${ext}`,
      }
    }

    onProgress({ jobId, percent: 82, message: `写出 ${target.toUpperCase()}…` })
    return await writeOcrOutput(text, target, outputPath, jobId, onProgress)
  } finally {
    if (tmpDir) rmrfQuiet(tmpDir)
  }
}
