/**
 * 电子书 / 纯文本转换：Pandoc 负责 Markdown、HTML、EPUB、DOCX 等；
 * PDF 需要再走 LibreOffice（不内置 LaTeX）。MOBI / AZW3 的拆包见 mobi.ts。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { convertDocument, resolveLibreOffice } from './libreoffice'
import { unpackMobiToHtml } from './mobi'
import { findBinary as findBinShared, tmpPath, rmQuiet, unlinkQuiet } from './bins'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { cancelledResult, failResult, isCancelRequested, preflightOutput, remapIfCancelled, spawnTracked, decorateProgress } from './jobs'

export interface ConvertEbookRequest {
  inputPath: string
  target: string
  /** 绝对输出路径；省略则在源文件旁自动生成 */
  outputPath?: string
}

/** 本电子书流程里 Pandoc 能读取的格式 */
const PANDOC_INPUT_EXTS = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'epub'])

/** 可直接由 Pandoc 写出、不需要 LibreOffice 的目标格式 */
const PANDOC_DIRECT_TARGETS = new Set(['txt', 'md', 'html', 'epub'])

/** 需要在 Pandoc 之后再走 LibreOffice 的目标（html 有时可直接交给 LO） */
const LO_COMPLEMENT_TARGETS = new Set(['pdf', 'docx'])

const MOBI_EXTS = new Set(['mobi', 'azw', 'azw3', 'azw4'])
const DATA_EXTS = new Set(['json', 'xml', 'yaml', 'yml'])

export function resolveCalibre(): string | null {
  return findBinShared(['ebook-convert'], ['calibre', path.join('calibre', 'bin')])
}


function candidateBinDirs(): string[] {
  const dirs: string[] = []
  try {
    if (app.isPackaged) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      dirs.push(path.join(process.resourcesPath, 'pandoc'))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
    }
  } catch {
    /* 冒烟脚本在 Electron 外运行时没有 app */
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
  timeoutMs = 60000,
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

/** Pandoc -t / -f 别名。`plain` 只用于输出；txt 输入按 markdown 读。 */
function pandocFormat(ext: string, role: 'from' | 'to'): string {
  const e = ext.toLowerCase()
  if (e === 'md' || e === 'markdown') return 'markdown'
  if (e === 'htm') return 'html'
  if (e === 'txt') return role === 'to' ? 'plain' : 'markdown'
  return e
}

export function isEbookGroup(group: string): boolean {
  return group === 'ebook'
}

export function isEbookConvertible(group: string, target: string, inputExt?: string): boolean {
  if (group !== 'ebook') return false
  const t = target.toLowerCase()
  if (PANDOC_DIRECT_TARGETS.has(t)) return true
  if (inputExt && MOBI_EXTS.has(inputExt.toLowerCase()) && (PANDOC_DIRECT_TARGETS.has(t) || LO_COMPLEMENT_TARGETS.has(t))) return true
  if (LO_COMPLEMENT_TARGETS.has(t)) return true
  return false
}

export async function resolvePandoc(): Promise<{
  pandoc: string | null
  version?: string
}> {
  const pandoc = findBinary(['pandoc'])
  let version: string | undefined
  if (pandoc) {
    const r = await runCapture(pandoc, ['--version'], 15000)
    const text = `${r.stdout}\n${r.stderr}`
    const m = text.match(/pandoc\s+([\d.]+)/i)
    if (m) version = m[1]
  }
  return { pandoc, version }
}

/** 探测 Pandoc；Calibre 只作为 MOBI/AZW3 的可选补充。 */
export async function getPandocHealthItem(): Promise<EngineHealthItem> {
  const { pandoc, version } = await resolvePandoc()
  const { soffice } = await resolveLibreOffice()
  if (pandoc) {
    return {
      id: 'pandoc',
      name: 'Pandoc',
      status: 'ready',
      covers: 'Markdown / 电子书',
      version,
      path: pandoc,
      detail: [
        soffice ? 'LibreOffice 可互补 epub/html→pdf/docx' : 'txt/md/html↔epub；pdf/docx 需 LibreOffice',
        'JSON/XML/YAML 经可读 Markdown 中间件',
        resolveCalibre() ? 'MOBI/AZW 经 Calibre ebook-convert' : 'MOBI 可走内置解包；AZW3 建议安装 Calibre',
      ].join('；'),
    }
  }
  return {
    id: 'pandoc',
    name: 'Pandoc',
    status: 'missing',
    covers: 'Markdown / 电子书',
    detail:
      '未在 PATH 或 resources/bin 找到 pandoc。开发机可运行: node scripts/ensure-pandoc.mjs --install',
  }
}

async function runPandoc(
  pandoc: string,
  inputPath: string,
  outputPath: string,
  fromExt: string,
  toExt: string,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  onProgress({ jobId, percent: 20, message: `Pandoc ${fromExt}→${toExt}` })

  const args = [
    inputPath,
    '-f',
    pandocFormat(fromExt, 'from'),
    '-t',
    pandocFormat(toExt, 'to'),
    '-o',
    outputPath,
  ]
  // html/epub 需要 --standalone；plain/md 通常不加更好
  if (['html', 'htm', 'epub'].includes(toExt.toLowerCase())) {
    args.push('--standalone')
  }

  // 等待时用假进度
  let fake = 25
  const tick = setInterval(() => {
    fake = Math.min(85, fake + 8)
    onProgress({ jobId, percent: fake, message: 'Pandoc 转换中…' })
  }, 400)

  const result = await runCapture(pandoc, args, 120_000)
  clearInterval(tick)

  if (result.code !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n')
    return {
      jobId,
      ok: false,
      error: `Pandoc 退出码 ${result.code}${tail ? `\n${tail}` : ''}`,
    }
  }
  if (!fs.existsSync(outputPath)) {
    return {
      jobId,
      ok: false,
      error: `Pandoc 未生成输出：${outputPath}\n${(result.stdout + result.stderr).trim().slice(-400)}`,
    }
  }
  return { jobId, ok: true, outputPath, engineUsed: 'Pandoc' }
}


function structuredToMarkdown(inputPath: string, ext: string): string {
  const raw = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')
  const e = ext.toLowerCase()
  if (e === 'json') {
    try {
      const obj = JSON.parse(raw)
      const pretty = JSON.stringify(obj, null, 2)
      return `# JSON 文档\n\n来源：\`${path.basename(inputPath)}\`\n\n${jsonToMarkdown(obj)}\n\n## 原始 JSON\n\n\`\`\`json\n${pretty}\n\`\`\`\n`
    } catch (err) {
      throw new Error(`JSON 无法解析：${String(err)}`)
    }
  }
  if (e === 'xml') {
    return `# XML 文档\n\n来源：\`${path.basename(inputPath)}\`\n\n\`\`\`xml\n${raw.trim()}\n\`\`\`\n`
  }
  if (e === 'yaml' || e === 'yml') {
    return `# YAML 文档\n\n来源：\`${path.basename(inputPath)}\`\n\n\`\`\`yaml\n${raw.trim()}\n\`\`\`\n`
  }
  return raw
}

function jsonToMarkdown(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth)
  if (value === null) return `${pad}- null`
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${pad}- ${String(value)}`
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}- *(空数组)*`
    return value.map((v) => jsonToMarkdown(v, depth)).join('\n')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (!entries.length) return `${pad}- *(空对象)*`
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === 'object') {
          return `${pad}- **${k}**：\n${jsonToMarkdown(v, depth + 1)}`
        }
        return `${pad}- **${k}**：${String(v)}`
      })
      .join('\n')
  }
  return `${pad}- ${String(value)}`
}

/** 电子书和纯文本互转；PDF 目标会再交给串行的 LibreOffice。 */
export async function convertEbook(
  req: ConvertEbookRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }

  const inputExt = path.extname(inputPath).slice(1).toLowerCase()
  const target = req.target.toLowerCase()
  const finalOutput = req.outputPath || defaultOutputPath(inputPath, target)
  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const disk = preflightOutput(jobId, finalOutput, { kind: 'ebook', inputPaths: inputPath })
  if (!disk.ok) return disk.result

  if (!PANDOC_INPUT_EXTS.has(inputExt) && !DATA_EXTS.has(inputExt) && !MOBI_EXTS.has(inputExt)) {
    return {
      jobId,
      ok: false,
      error: `电子书引擎不支持输入扩展名：.${inputExt}。支持：txt / md / html / epub / json / xml / yaml / mobi / azw / azw3。`,
    }
  }

  let workInput = inputPath
  let workExt = inputExt
  const tmpClean: string[] = []

  const finishCleanup = () => {
    for (const p of tmpClean) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) rmQuiet(p)
        else unlinkQuiet(p)
      } catch {
        /* 忽略 */
      }
    }
  }

  try {
    if (MOBI_EXTS.has(inputExt)) {
      const calibre = resolveCalibre()
      const calibreTargets: Record<string, string> = {
        epub: 'epub',
        html: 'html',
        htm: 'html',
        txt: 'txt',
        md: 'txt',
        markdown: 'txt',
        pdf: 'pdf',
        docx: 'docx',
      }
      const cTarget = calibreTargets[target]
      if (calibre && cTarget && target !== 'md' && target !== 'markdown') {
        onProgress({ jobId, percent: 10, message: `Calibre ebook-convert → ${cTarget}` })
        fs.mkdirSync(path.dirname(finalOutput), { recursive: true })
        const r = await runCapture(calibre, [inputPath, finalOutput], 180_000)
        if (r.code === 0 && fs.existsSync(finalOutput) && fs.statSync(finalOutput).size > 0) {
          onProgress({ jobId, percent: 100, message: '完成' })
          return { jobId, ok: true, outputPath: finalOutput, engineUsed: 'Calibre' }
        }
        // 拆包再试
        onProgress({ jobId, percent: 18, message: 'Calibre 失败，尝试内置 MOBI 解包…' })
      } else if (calibre && (target === 'md' || target === 'markdown')) {
        const mid = tmpPath('mf-mobi', 'txt')
        tmpClean.push(mid)
        const r = await runCapture(calibre, [inputPath, mid], 180_000)
        if (r.code === 0 && fs.existsSync(mid) && fs.statSync(mid).size > 0) {
          workInput = mid
          workExt = 'txt'
        }
      }
      if (workInput === inputPath) {
        onProgress({ jobId, percent: 12, message: '内置解包 MOBI…' })
        const mid = tmpPath('mf-mobi', 'html')
        tmpClean.push(mid)
        try {
          unpackMobiToHtml(inputPath, mid)
          workInput = mid
          workExt = 'html'
        } catch (err) {
          finishCleanup()
          const hint = calibre
            ? String(err)
            : `${String(err)}
如文件是 AZW3/KF8，请安装 Calibre 后重试: node scripts/ensure-calibre.mjs --install`
          return { jobId, ok: false, error: hint }
        }
      }
    }

    if (DATA_EXTS.has(inputExt)) {
      onProgress({ jobId, percent: 8, message: `结构化文本 ${inputExt} → Markdown 中间件` })
      const md = structuredToMarkdown(inputPath, inputExt)
      const mid = tmpPath('mf-data', 'md')
      tmpClean.push(mid)
      fs.writeFileSync(mid, md, 'utf8')
      workInput = mid
      workExt = 'md'
    }

  const effectiveInputExt = workExt === 'yml' ? 'yaml' : workExt
  const inputPathWork = workInput

  if (!PANDOC_DIRECT_TARGETS.has(target) && !LO_COMPLEMENT_TARGETS.has(target)) {
    finishCleanup()
    return {
      jobId,
      ok: false,
      error: `目标格式「${target}」不支持。可用：txt / md / html / epub；有 LibreOffice 时可 → pdf / docx`,
    }
  }

  const { pandoc } = await resolvePandoc()
  const { soffice } = await resolveLibreOffice()

  // 直接走 Pandoc：txt/md/html 与 epub 以及它们之间互转
  if (PANDOC_DIRECT_TARGETS.has(target)) {
    if (!pandoc) {
      return {
        jobId,
        ok: false,
        error:
          '未找到 Pandoc。请安装 pandoc 并加入 PATH，或放入 resources/bin。开发机可试: node scripts/ensure-pandoc.mjs --install',
      }
    }
    onProgress({ jobId, percent: 5, message: 'Pandoc 启动…' })
    const r = await runPandoc(pandoc, inputPathWork, finalOutput, effectiveInputExt, target, jobId, onProgress)
    if (r.ok) onProgress({ jobId, percent: 100, message: '完成' })
    return r
  }

  // pdf / docx 需要 LibreOffice 补位
  if (!soffice && !(pandoc && target === 'docx')) {
    // docx 可由 Pandoc 单独生成；pdf 一定要 LibreOffice（不内置 LaTeX）
    if (target === 'pdf') {
      return {
        jobId,
        ok: false,
        error:
          '电子书 → PDF 需要 LibreOffice（本应用不捆绑 LaTeX）。请安装 soffice，或运行: node scripts/ensure-libreoffice.mjs',
      }
    }
  }

  if (target === 'docx') {
    // 优先让 Pandoc 直接出 docx
    if (pandoc) {
      onProgress({ jobId, percent: 5, message: 'Pandoc → DOCX…' })
      const r = await runPandoc(pandoc, inputPathWork, finalOutput, effectiveInputExt, 'docx', jobId, onProgress)
      if (r.ok) {
        onProgress({ jobId, percent: 100, message: '完成' })
        return { ...r, engineUsed: 'Pandoc' }
      }
      // Pandoc 失败且输入是 LO 能打开的 html/txt 时，再交给 LibreOffice
    }
    if (soffice && (workExt === 'html' || workExt === 'htm' || workExt === 'txt')) {
      onProgress({ jobId, percent: 10, message: 'LibreOffice → DOCX…' })
      const r = await convertDocument({ inputPath: inputPathWork, target: 'docx', outputPath: finalOutput }, jobId, onProgress)
      if (r.ok) return { ...r, engineUsed: 'LibreOffice' }
      return r
    }
    if (!pandoc) {
      return {
        jobId,
        ok: false,
        error:
          '未找到 Pandoc（电子书→DOCX 首选引擎）。请安装: node scripts/ensure-pandoc.mjs --install',
      }
    }
    finishCleanup()
    return {
      jobId,
      ok: false,
      error: 'Pandoc → DOCX 失败，且无法用 LibreOffice 回退（输入非 html/txt）。',
    }
  }

  // 目标是 pdf
  if (!soffice) {
    finishCleanup()
    return {
      jobId,
      ok: false,
      error:
        '电子书 → PDF 需要 LibreOffice。请安装 soffice，或运行: node scripts/ensure-libreoffice.mjs',
    }
  }

  // 输入已是 html/htm/txt 时，LibreOffice 可直接转换
  if (['html', 'htm', 'txt'].includes(workExt)) {
    onProgress({ jobId, percent: 10, message: 'LibreOffice → PDF…' })
    const r = await convertDocument({ inputPath: inputPathWork, target: 'pdf', outputPath: finalOutput }, jobId, onProgress)
    if (r.ok) return { ...r, engineUsed: 'LibreOffice' }
    return r
  }

  // epub / md 等：先经 Pandoc 转到临时 html，再交给 LibreOffice 出 pdf
  if (!pandoc) {
    finishCleanup()
    return {
      jobId,
      ok: false,
      error:
        '电子书（epub/md 等）→ PDF 需要 Pandoc 先转成 HTML，再交 LibreOffice。未找到 Pandoc。请运行: node scripts/ensure-pandoc.mjs --install',
    }
  }

  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ebook-'))
  const tmpHtml = path.join(tmpWorkDir, 'intermediate.html')
  try {
    onProgress({ jobId, percent: 8, message: 'Pandoc → HTML（中间件）…' })
    const mid = await runPandoc(pandoc, inputPathWork, tmpHtml, effectiveInputExt, 'html', jobId, onProgress)
    if (!mid.ok) return mid

    onProgress({ jobId, percent: 55, message: 'LibreOffice HTML → PDF…' })
    const r = await convertDocument(
      { inputPath: tmpHtml, target: 'pdf', outputPath: finalOutput },
      jobId,
      onProgress,
    )
    if (r.ok) {
      onProgress({ jobId, percent: 100, message: '完成' })
      return { ...r, engineUsed: 'Pandoc + LibreOffice' }
    }
    return r
  } finally {
    try {
      fs.rmSync(tmpWorkDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
  } finally {
    finishCleanup()
  }
}
