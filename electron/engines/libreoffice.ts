/**
 * 文档转换引擎：通过 soffice / LibreOffice 把 Writer、Calc、Impress 转到常见办公与 PDF 格式。
 *
 * LibreOffice 共用一套用户配置，不能并行转换，必须走 jobs.limitOffice（createLimiter(1)）串行。
 * 每个任务使用独立的 UserInstallation，避免配置文件被锁死。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { cancelledResult, failResult, isCancelRequested, preflightOutput, remapIfCancelled, spawnTracked, limitOffice, decorateProgress } from './jobs'
import { envWithExeDir } from './bins'

export interface ConvertDocumentRequest {
  inputPath: string
  target: string
  /** 绝对输出路径；省略则在源文件旁自动生成 */
  outputPath?: string
}

/** LibreOffice Writer/Calc/Impress 通常能打开的后缀 */
const LO_INPUT_EXTS = new Set([
  'doc',
  'docx',
  'odt',
  'rtf',
  'wps',
  'wpt',
  'wpd',
  'txt',
  'html',
  'htm',
  'xls',
  'xlsx',
  'xlsm',
  'ods',
  'csv',
  'tsv',
  'et', // LO 按 MS Excel 97 兼容打开（已实测）
  'ett',
  'ppt',
  'pptx',
  'odp',
  'dps', // LO 按 PPT 兼容打开（已实测）
  'dpt',
  'pdf',
])

/**
 * --convert-to 过滤器映射。`md` 会出现在界面里，但 LibreOffice 本身不支持，需要走 Pandoc。
 */
const CONVERT_TO_FILTER: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  odt: 'odt',
  rtf: 'rtf',
  txt: 'txt:Text',
  html: 'html:HTML',
  xlsx: 'xlsx',
  xls: 'xls',
  ods: 'ods',
  csv: 'csv',
  pptx: 'pptx',
  odp: 'odp',
}

const DOC_GROUPS = new Set(['document', 'spreadsheet', 'presentation'])

function candidateBinDirs(): string[] {
  const dirs: string[] = []
  // 随包 LibreOffice 在 resources/LibreOffice/program/soffice.exe，不能只搜 bin/
  const programSubs = [
    path.join('LibreOffice', 'program'),
    path.join('libreoffice', 'program'),
    'LibreOffice',
    'libreoffice',
  ]
  try {
    if (app.isPackaged) {
      dirs.push(path.join(process.resourcesPath, 'bin'))
      for (const sub of programSubs) dirs.push(path.join(process.resourcesPath, sub))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
      dirs.push(path.join(path.dirname(process.execPath), 'resources', 'LibreOffice', 'program'))
    }
  } catch {
    /* 冒烟脚本在 Electron 外运行时没有 app */
  }
  dirs.push(path.join(process.cwd(), 'bin'))
  dirs.push(path.join(process.cwd(), 'resources', 'bin'))
  for (const sub of programSubs) dirs.push(path.join(process.cwd(), 'resources', sub))
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
  timeoutMs = 20000,
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

function pathToFileUrl(p: string): string {
  const resolved = path.resolve(p)
  if (process.platform === 'win32') {
    const normalized = resolved.replace(/\\/g, '/')
    return `file:///${normalized}`
  }
  return `file://${resolved}`
}

export function isLibreOfficeGroup(group: string): boolean {
  return DOC_GROUPS.has(group)
}

export function isLibreOfficeConvertible(group: string, target: string, inputExt?: string): boolean {
  if (!DOC_GROUPS.has(group)) return false
  const t = target.toLowerCase()
  if (!(t in CONVERT_TO_FILTER)) return false
  if (inputExt && !LO_INPUT_EXTS.has(inputExt.toLowerCase())) return false
  return true
}

export function libreOfficeSupportedTargets(): string[] {
  return Object.keys(CONVERT_TO_FILTER)
}

export async function resolveLibreOffice(): Promise<{
  soffice: string | null
  version?: string
}> {
  // 优先 soffice，同时接受 libreoffice 包装以及 Windows 的 soffice.exe
  const soffice = findBinary(['soffice', 'libreoffice'])
  let version: string | undefined
  if (soffice) {
    const r = await runCapture(soffice, ['--version'])
    const text = `${r.stdout}\n${r.stderr}`
    const m = text.match(/LibreOffice\s+([\d.]+(?:\.\d+)?)/i)
    if (m) version = m[1]
    else {
      const m2 = text.match(/version\s+(\S+)/i)
      if (m2) version = m2[1]
    }
  }
  return { soffice, version }
}

export async function getLibreOfficeHealthItem(): Promise<EngineHealthItem> {
  const { soffice, version } = await resolveLibreOffice()
  if (soffice) {
    return {
      id: 'libreoffice',
      name: 'LibreOffice',
      status: 'ready',
      covers: 'Office / WPS 文档',
      version,
      path: soffice,
      detail: 'headless convert-to 已接入',
    }
  }
  return {
    id: 'libreoffice',
    name: 'LibreOffice',
    status: 'missing',
    covers: 'Office / WPS 文档',
    detail:
      '未在 PATH 或 resources/bin 找到 soffice/libreoffice。开发机可运行: node scripts/ensure-libreoffice.mjs',
  }
}

export async function convertDocument(
  req: ConvertDocumentRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  return limitOffice(() => convertDocumentUnlocked(req, jobId, onProgress))
}

async function convertDocumentUnlocked(
  req: ConvertDocumentRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<ConvertResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const { soffice } = await resolveLibreOffice()
  if (!soffice) {
    return failResult(
      jobId,
      'E-LO-MISSING',
      '未找到 LibreOffice（soffice）。请安装 LibreOffice 并加入 PATH，或放入 resources/bin。开发机可试: node scripts/ensure-libreoffice.mjs',
    )
  }

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }

  const inputExt = path.extname(inputPath).slice(1).toLowerCase()
  if (!LO_INPUT_EXTS.has(inputExt)) {
    return {
      jobId,
      ok: false,
      error: `LibreOffice 不支持的输入扩展名：.${inputExt}`,
      errorCode: 'E-LO-FAILED',
    }
  }

  const target = req.target.toLowerCase()
  const filter = CONVERT_TO_FILTER[target]
  if (!filter) {
    return {
      jobId,
      ok: false,
      error: `目标格式「${target}」暂不由 LibreOffice 转换（例如 md 需后续 Pandoc）。可用：${Object.keys(CONVERT_TO_FILTER).join(', ')}`,
      errorCode: 'E-LO-FAILED',
    }
  }

  const finalOutput = req.outputPath || defaultOutputPath(inputPath, target)
  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const disk = preflightOutput(jobId, finalOutput, { kind: 'document', inputPaths: inputPath })
  if (!disk.ok) return disk.result
  const outDir = path.dirname(finalOutput)
  fs.mkdirSync(outDir, { recursive: true })

  // LibreOffice 总是把 basename.ext 写进 --outdir，之后再挪到目标路径
  const loOutName = `${path.basename(inputPath, path.extname(inputPath))}.${target}`
  const loOutPath = path.join(outDir, loOutName)

  // 独立 UserInstallation，避免多个任务抢同一份配置文件锁（即便已经串行也更稳）
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lo-'))
  const profileUrl = pathToFileUrl(profileDir)

  onProgress({ jobId, percent: 5, message: 'LibreOffice 启动…' })

  const args = [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=${profileUrl}`,
    '--convert-to',
    filter,
    '--outdir',
    outDir,
    inputPath,
  ]

  onProgress({ jobId, percent: 15, message: `convert-to ${filter}` })

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawnTracked(soffice, args, { windowsHide: true, env: envWithExeDir(soffice) })
    let stdout = ''
    let stderr = ''
    // 冷启动时文档转换可能较慢
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout 120s]' })
    }, 120_000)

    // 等待时用假进度；LibreOffice 不会给出细粒度进度
    let fake = 20
    const tick = setInterval(() => {
      fake = Math.min(85, fake + 5)
      onProgress({ jobId, percent: fake, message: 'LibreOffice 转换中…' })
    }, 800)

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      clearInterval(tick)
      resolve({ code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearInterval(tick)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })

  // 尽力清理本次 UserInstallation
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }

  if (result.code !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n')
    return {
      jobId,
      ok: false,
      error: `LibreOffice 退出码 ${result.code}${tail ? `\n${tail}` : ''}`,
      errorCode: result.stderr.includes('[timeout') ? 'E-TIMEOUT' : 'E-LO-FAILED',
      errorDetail: tail || undefined,
    }
  }

  if (!fs.existsSync(loOutPath)) {
    // 有的过滤器写出的后缀稍有不同，需要扫描 outDir
    const base = path.basename(inputPath, path.extname(inputPath))
    const candidates = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith(base) && f.toLowerCase().endsWith(`.${target}`))
      .map((f) => path.join(outDir, f))
    if (!candidates.length) {
      return {
        jobId,
        ok: false,
        error: `LibreOffice 未生成输出文件（期望 ${loOutPath}）\n${(result.stdout + result.stderr).trim().slice(-400)}`,
      }
    }
    const found = candidates[0]
    if (path.resolve(found) !== path.resolve(finalOutput)) {
      if (fs.existsSync(finalOutput)) fs.unlinkSync(finalOutput)
      fs.renameSync(found, finalOutput)
    }
  } else if (path.resolve(loOutPath) !== path.resolve(finalOutput)) {
    if (fs.existsSync(finalOutput)) fs.unlinkSync(finalOutput)
    fs.renameSync(loOutPath, finalOutput)
  }

  if (!fs.existsSync(finalOutput)) {
    return failResult(jobId, 'E-LO-FAILED', `输出文件未找到：${finalOutput}`)
  }

  onProgress({ jobId, percent: 100, message: '完成' })
  return { jobId, ok: true, outputPath: finalOutput }
}
