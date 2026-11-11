/**
 * 人声分离引擎：优先 Demucs，其次 UVR · MDX-Net（ONNX），都不可用时退回 FFmpeg 简易滤波。
 * Python 解释器可由 MEDIAFORGE_DEMUCS_PYTHON 指定；模型目录可由 MEDIAFORGE_UVR_MODEL_DIR 指定。
 * 本页不做「特殊音乐」解密，那只是健康清单里永远 optional 的一项。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { resolveFfmpeg } from './ffmpeg'
import type { ConvertProgressEvent, ConvertResult, EngineHealthItem } from './types'
import { cancelledResult, checkDiskSpace, estimateOutputBytes, failResult, isCancelRequested, preflightOutput, remapIfCancelled, spawnTracked, decorateProgress } from './jobs'

export type VocalBackend = 'demucs' | 'ffmpeg-simple' | 'uvr'

export type VocalModelId =
  | 'demucs-htdemucs'
  | 'demucs-htdemucs_ft'
  | 'ffmpeg-simple'
  | 'uvr-mdx'
  | 'uvr-vr'

export interface VocalOutputs {
  vocals?: boolean
  instrumental?: boolean
  drums?: boolean
  bass?: boolean
  other?: boolean
}

export interface SeparateVocalsRequest {
  inputPath: string
  outputDir?: string
  model?: VocalModelId
  /** 有 Demucs 时优先用它；传 'ffmpeg-simple' 可强制走简易滤波 */
  backend?: VocalBackend
  outputs?: VocalOutputs
  /** Demucs 设备：cpu | cuda | mps。默认 cpu，更稳。 */
  device?: string
}

export interface VocalEngineProbe {
  python: string | null
  demucsModuleOk: boolean
  demucsVersion?: string
  demucsCli: string | null
  installHint: string
  ffmpegFallbackReady: boolean
  uvrReady: boolean
  uvrDetail?: string
  uvrModel?: string
}

export interface SeparateVocalsResult extends ConvertResult {
  outputPaths?: string[]
  engineUsed?: string
  message?: string
}

const DEMUCS_MODELS: Record<string, string> = {
  'demucs-htdemucs': 'htdemucs',
  'demucs-htdemucs_ft': 'htdemucs_ft',
}

const INSTALL_HINT = [
  '本机未检测到可用的 Demucs。请在项目目录创建虚拟环境后安装（推荐 CPU 版）：',
  '',
  '  python3 -m venv .venv-demucs',
  '  .venv-demucs/bin/pip install -U pip',
  '  .venv-demucs/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu',
  '  .venv-demucs/bin/pip install demucs numpy torchaudio',
  '',
  '或设置环境变量 MEDIAFORGE_DEMUCS_PYTHON 指向含 demucs 的 Python。',
  '首次运行会下载 htdemucs 权重（约数百 MB）。未安装时可用「FFmpeg 简易分离」（质量远不如 Demucs）。',
  'UVR · MDX-Net 在模型与依赖就绪时可选用（CPU）。默认仍建议 Demucs。',
].join('\n')


const UVR_MDX_MODEL = 'UVR_MDXNET_1_9703.onnx'
const UVR_RUNNER_REL = path.join('scripts', 'uvr-separate.py')

function candidateModelDirs(): string[] {
  const dirs: string[] = []
  if (process.env.MEDIAFORGE_UVR_MODEL_DIR) dirs.push(process.env.MEDIAFORGE_UVR_MODEL_DIR)
  const roots: string[] = [process.cwd()]
  try {
    roots.push(path.join(__dirname, '..', '..'))
    roots.push(path.join(process.resourcesPath || '', 'uvr-models'))
  } catch {
    /* 忽略 */
  }
  for (const root of roots) {
    dirs.push(path.join(root, 'resources', 'uvr-models'))
    dirs.push(path.join(root, 'uvr-models'))
  }
  return dirs
}

function resolveUvrModel(): { modelDir: string; model: string } | null {
  const name = UVR_MDX_MODEL
  for (const dir of candidateModelDirs()) {
    const full = path.join(dir, name)
    try {
      if (fs.existsSync(full) && fs.statSync(full).size > 1024 * 1024) {
        return { modelDir: dir, model: name }
      }
    } catch {
      /* 忽略 */
    }
  }
  return null
}

function resolveUvrRunner(): string | null {
  const cands = [
    path.join(process.cwd(), UVR_RUNNER_REL),
    path.join(__dirname, '..', '..', UVR_RUNNER_REL),
  ]
  try {
    if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'uvr-separate.py'))
  } catch {
    /* 忽略 */
  }
  for (const p of cands) {
    if (fs.existsSync(p)) return p
  }
  return null
}

function candidatePythonBins(): string[] {
  const bins: string[] = []
  const envPy = process.env.MEDIAFORGE_DEMUCS_PYTHON
  if (envPy) bins.push(envPy)

  const roots: string[] = []
  try {
    roots.push(process.cwd())
    if (!app.isPackaged) {
      roots.push(path.join(__dirname, '..', '..'))
    } else {
      roots.push(path.dirname(process.execPath))
      roots.push(process.resourcesPath)
    }
  } catch {
    roots.push(process.cwd())
  }

  for (const root of roots) {
    bins.push(
      path.join(root, '.venv-demucs', 'bin', 'python'),
      path.join(root, '.venv-demucs', 'bin', 'python3'),
      path.join(root, '.venv-demucs', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'bin', 'python'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
    )
  }

  bins.push('python3', 'python')
  return bins
}

function whichSync(cmd: string): string | null {
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try {
      if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return cmd
    } catch {
      /* 忽略 */
    }
    return null
  }
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

function runCapture(
  bin: string,
  args: string[],
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnTracked(bin, args, {
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    })
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

let cachedProbe: VocalEngineProbe | null = null
let cachedAt = 0

/** 探测 Demucs / UVR / FFmpeg 简易回退是否可用。 */
export async function probeVocalEngine(force = false): Promise<VocalEngineProbe> {
  const now = Date.now()
  if (!force && cachedProbe && now - cachedAt < 15_000) return cachedProbe

  const { ffmpeg } = await resolveFfmpeg()
  const ffmpegFallbackReady = Boolean(ffmpeg)

  let python: string | null = null
  let demucsModuleOk = false
  let demucsVersion: string | undefined
  let demucsCli: string | null = null

  const demucsBin = whichSync('demucs')
  if (demucsBin) demucsCli = demucsBin

  for (const cand of candidatePythonBins()) {
    const resolved = whichSync(cand) || (fs.existsSync(cand) ? cand : null)
    if (!resolved) continue
    const r = await runCapture(
      resolved,
      ['-c', 'import demucs; print(getattr(demucs,"__version__", "ok"))'],
      20_000,
    )
    if (r.code === 0) {
      python = resolved
      demucsModuleOk = true
      demucsVersion = (r.stdout || '').trim().split('\n').pop() || 'ok'
      break
    }
  }

  // 模块可用时优先 `python -m demucs`，否则用 demucs 命令行
  if (!demucsModuleOk && demucsCli) {
    const r = await runCapture(demucsCli, ['-h'], 20_000)
    if (r.code === 0 || (r.stdout + r.stderr).includes('separate')) {
      demucsModuleOk = true
      demucsVersion = demucsVersion || 'cli'
    }
  }

  let uvrReady = false
  let uvrDetail: string | undefined
  const uvrModel = resolveUvrModel()
  const uvrRunner = resolveUvrRunner()
  const pyForUvr = python || candidatePythonBins().map((c) => whichSync(c) || (fs.existsSync(c) ? c : null)).find(Boolean) || null
  if (uvrModel && uvrRunner && pyForUvr) {
    const chk = await runCapture(
      pyForUvr,
      [
        '-c',
        'import types,sys; m=types.ModuleType("onnx2torch"); sys.modules["onnx2torch"]=m; import audio_separator.separator, onnxruntime; print("ok")',
      ],
      25_000,
    )
    if (chk.code === 0 && /ok/.test(chk.stdout)) {
      uvrReady = true
      uvrDetail = `MDX-Net ${uvrModel.model}（ONNX Runtime，CPU）`
    } else {
      uvrDetail = `模型已找到，但 audio-separator / onnxruntime 不可用：${(chk.stderr || chk.stdout).trim().slice(-200)}`
    }
  } else if (uvrModel && !uvrRunner) {
    uvrDetail = '找到 UVR 模型，但缺少 scripts/uvr-separate.py'
  } else {
    uvrDetail = 'UVR · MDX-Net 未就绪。可运行: node scripts/ensure-uvr.mjs'
  }

  cachedProbe = {
    python,
    demucsModuleOk,
    demucsVersion,
    demucsCli,
    installHint: INSTALL_HINT,
    ffmpegFallbackReady,
    uvrReady,
    uvrDetail,
    uvrModel: uvrModel?.model,
  }
  cachedAt = now
  return cachedProbe
}

/** 人声分离引擎的健康项，供总清单第 9 项使用（第 10 项是特殊音乐模块）。 */
export async function getDemucsHealthItem(): Promise<EngineHealthItem> {
  const p = await probeVocalEngine()
  if (p.demucsModuleOk) {
    return {
      id: 'demucs',
      name: 'Demucs（人声分离）',
      status: 'ready',
      covers: '人声 / 伴奏 / 四轨',
      version: p.demucsVersion,
      path: p.python ?? p.demucsCli ?? undefined,
      detail: `Demucs 就绪。${p.uvrReady ? p.uvrDetail || 'UVR · MDX-Net 已接入' : p.uvrDetail || 'UVR 未就绪'}。FFmpeg 简易分离${p.ffmpegFallbackReady ? '可用作降级' : '不可用'}。`,
    }
  }
  return {
    id: 'demucs',
    name: 'Demucs（人声分离）',
    status: 'missing',
    covers: '人声 / 伴奏 / 四轨',
    detail: p.ffmpegFallbackReady
      ? 'Demucs 未安装；可用「FFmpeg 简易分离」降级（质量远不如 Demucs）。' + (p.uvrReady ? 'UVR · MDX-Net 已接入。' : 'UVR 未就绪。') + '\n' +
        '安装：python3 -m venv .venv-demucs && .venv-demucs/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && .venv-demucs/bin/pip install demucs numpy torchaudio'
      : 'Demucs 未安装，且无 FFmpeg 简易降级。' + INSTALL_HINT,
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function defaultOutDir(inputPath: string): string {
  const base = path.basename(inputPath, path.extname(inputPath))
  const dir = path.join(path.dirname(inputPath), `${base}_separated`)
  ensureDir(dir)
  return dir
}

function collectStemFiles(modelOutDir: string, trackBase: string): string[] {
  const candidates = [
    path.join(modelOutDir, trackBase),
    modelOutDir,
  ]
  const found: string[] = []
  for (const dir of candidates) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isFile() && /\.(wav|flac|mp3)$/i.test(name)) {
        found.push(full)
      }
    }
    if (found.length) break
  }
  return found
}

async function separateWithDemucs(
  req: SeparateVocalsRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
  probe: VocalEngineProbe,
): Promise<SeparateVocalsResult> {
  const inputPath = req.inputPath
  const modelKey = req.model && DEMUCS_MODELS[req.model] ? req.model : 'demucs-htdemucs'
  const modelName = DEMUCS_MODELS[modelKey] || 'htdemucs'
  const outRoot = req.outputDir || defaultOutDir(inputPath)
  ensureDir(outRoot)

  const outputs: VocalOutputs = {
    vocals: true,
    instrumental: true,
    drums: false,
    bass: false,
    other: false,
    ...req.outputs,
  }

  const wantStems = Boolean(outputs.drums || outputs.bass || outputs.other)
  const twoStems = !wantStems && (outputs.vocals || outputs.instrumental)

  const args: string[] = [
    '-m',
    'demucs',
    '-n',
    modelName,
    '-d',
    req.device || 'cpu',
    '-o',
    outRoot,
  ]
  if (twoStems) {
    args.push('--two-stems', 'vocals')
  }
  args.push(inputPath)

  const bin = probe.python
  if (!bin) {
    return {
      jobId,
      ok: false,
      error: '未找到可用的 Python（含 demucs）。\n' + INSTALL_HINT,
      engineUsed: 'demucs',
    }
  }

  onProgress({
    jobId,
    percent: 2,
    message: `Demucs ${modelName} 启动（CPU 首次会下载模型）…`,
  })

  return await new Promise<SeparateVocalsResult>((resolve) => {
    const child = spawnTracked(bin, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })
    let stderrBuf = ''
    let lastPct = 2

    const bump = (pct: number, message?: string) => {
      lastPct = Math.max(lastPct, Math.min(99, pct))
      onProgress({ jobId, percent: lastPct, message })
    }

    const handle = (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      if (stderrBuf.length > 300_000) stderrBuf = stderrBuf.slice(-150_000)

      // 解析 demucs 的 tqdm 或下载进度行
      const m = text.match(/(\d{1,3})%/)
      if (m) {
        const p = Number(m[1])
        if (Number.isFinite(p)) bump(5 + p * 0.9, text.trim().slice(0, 120))
      } else if (/Downloading|download|Fetching|huggingface|torch.hub/i.test(text)) {
        bump(8, '正在下载模型权重…')
      } else if (/Separat|Infer|Apply|Forward/i.test(text)) {
        bump(Math.min(90, lastPct + 3), '推理中…')
      }
    }

    child.stderr.on('data', handle)
    child.stdout.on('data', handle)

    child.on('error', (err) => {
      resolve({
        jobId,
        ok: false,
        error: `无法启动 Demucs：${err.message}\n` + INSTALL_HINT,
        engineUsed: 'demucs',
      })
    })

    child.on('close', (code) => {
      const trackBase = path.basename(inputPath, path.extname(inputPath))
      const modelOut = path.join(outRoot, modelName)
      const files = collectStemFiles(modelOut, trackBase)

      if (code === 0 && files.length > 0) {
        // 按用户勾选的轨道筛选并重命名
        const kept: string[] = []
        for (const f of files) {
          const stem = path.basename(f, path.extname(f)).toLowerCase()
          if (stem === 'vocals' && outputs.vocals) kept.push(f)
          else if ((stem === 'no_vocals' || stem === 'instrumental') && outputs.instrumental)
            kept.push(f)
          else if (stem === 'drums' && outputs.drums) kept.push(f)
          else if (stem === 'bass' && outputs.bass) kept.push(f)
          else if (stem === 'other' && outputs.other) kept.push(f)
          else if (wantStems || twoStems) {
            // 用户没限定轨道时保留全部生成文件
            if (
              (stem === 'vocals' && outputs.vocals !== false) ||
              (stem === 'no_vocals' && outputs.instrumental !== false) ||
              (stem === 'drums' && outputs.drums) ||
              (stem === 'bass' && outputs.bass) ||
              (stem === 'other' && outputs.other)
            ) {
              kept.push(f)
            }
          }
        }
        const finalFiles = kept.length ? kept : files
        onProgress({ jobId, percent: 100, message: 'Demucs 完成' })
        resolve({
          jobId,
          ok: true,
          outputPath: finalFiles[0],
          outputPaths: finalFiles,
          engineUsed: `demucs:${modelName}`,
          message: `Demucs ${modelName} 已写出 ${finalFiles.length} 个文件`,
        })
        return
      }

      const tail = stderrBuf.trim().split('\n').slice(-12).join('\n')
      const downloadFail = /URLError|Connection|403|404|timed out|Checksum|HTTPSConnection/i.test(
        stderrBuf,
      )
      resolve({
        jobId,
        ok: false,
        error:
          (downloadFail
            ? 'Demucs 模型下载失败或网络中断。架构已就绪，请稍后重试或手动缓存权重。\n'
            : `Demucs 退出码 ${code ?? 'null'}。\n`) + (tail || ''),
        engineUsed: `demucs:${modelName}`,
      })
    })
  })
}

async function separateWithFfmpegSimple(
  req: SeparateVocalsRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<SeparateVocalsResult> {
  const { ffmpeg } = await resolveFfmpeg()
  if (!ffmpeg) {
    return {
      jobId,
      ok: false,
      error: '未找到 FFmpeg，无法做简易分离。',
      engineUsed: 'ffmpeg-simple',
    }
  }

  const inputPath = req.inputPath
  const outRoot = req.outputDir || defaultOutDir(inputPath)
  ensureDir(outRoot)
  const base = path.basename(inputPath, path.extname(inputPath))
  const outputs: VocalOutputs = {
    vocals: true,
    instrumental: true,
    ...req.outputs,
  }

  const produced: string[] = []
  onProgress({
    jobId,
    percent: 5,
    message: 'FFmpeg 简易分离（中心声道近似，质量远不如 Demucs）…',
  })

  const jobs: { label: string; af: string; out: string }[] = []
  if (outputs.vocals !== false) {
    jobs.push({
      label: 'vocals',
      af: 'pan=mono|c0=0.5*c0+0.5*c1',
      out: path.join(outRoot, `${base}_vocals_simple.wav`),
    })
  }
  if (outputs.instrumental !== false) {
    jobs.push({
      label: 'instrumental',
      af: 'pan=mono|c0=0.5*c0-0.5*c1',
      out: path.join(outRoot, `${base}_instrumental_simple.wav`),
    })
  }

  if (!jobs.length) {
    return { jobId, ok: false, error: '未勾选任何输出轨道', engineUsed: 'ffmpeg-simple' }
  }

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]
    onProgress({
      jobId,
      percent: 10 + (i / jobs.length) * 80,
      message: `写出 ${j.label}…`,
    })
    const r = await runCapture(
      ffmpeg,
      ['-y', '-hide_banner', '-i', inputPath, '-af', j.af, j.out],
      120_000,
    )
    if (r.code !== 0 || !fs.existsSync(j.out)) {
      const tail = (r.stderr || '').trim().split('\n').slice(-6).join('\n')
      return {
        jobId,
        ok: false,
        error: `FFmpeg 简易分离失败（${j.label}）\n${tail}`,
        engineUsed: 'ffmpeg-simple',
      }
    }
    produced.push(j.out)
  }

  onProgress({ jobId, percent: 100, message: '简易分离完成（质量有限）' })
  return {
    jobId,
    ok: true,
    outputPath: produced[0],
    outputPaths: produced,
    engineUsed: 'ffmpeg-simple',
    message:
      '已用 FFmpeg 中心/侧声道近似分离。这不是神经网络分离，立体声效果差的曲子几乎无效；请安装 Demucs 获得真实人声分离。',
  }
}


async function separateWithUvr(
  req: SeparateVocalsRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<SeparateVocalsResult> {
  const probe = await probeVocalEngine(true)
  const model = resolveUvrModel()
  const runner = resolveUvrRunner()
  const py = probe.python || candidatePythonBins().map((c) => whichSync(c) || (fs.existsSync(c) ? c : null)).find(Boolean) || null
  if (!probe.uvrReady || !model || !runner || !py) {
    return {
      jobId,
      ok: false,
      error:
        (probe.uvrDetail || 'UVR · MDX-Net 未就绪。') +
        '\n可运行: node scripts/ensure-uvr.mjs\n也可改用 Demucs 或 FFmpeg 简易分离。',
      engineUsed: 'uvr-mdx',
    }
  }
  const inputPath = req.inputPath
  const outRoot = req.outputDir || defaultOutDir(inputPath)
  ensureDir(outRoot)
  const outputs: VocalOutputs = { vocals: true, instrumental: true, ...req.outputs }

  onProgress({ jobId, percent: 5, message: `UVR · MDX-Net（${model.model}）启动…` })

  return await new Promise<SeparateVocalsResult>((resolve) => {
    const child = spawnTracked(
      py,
      [runner, inputPath, '--output-dir', outRoot, '--model-dir', model.modelDir, '--model', model.model],
      { windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } },
    )
    let buf = ''
    const handle = (chunk: Buffer) => {
      const text = chunk.toString()
      buf += text
      if (buf.length > 200_000) buf = buf.slice(-100_000)
      const m = text.match(/(\d{1,3})%/)
      if (m) {
        const pct = Number(m[1])
        if (Number.isFinite(pct)) onProgress({ jobId, percent: Math.min(99, 8 + pct * 0.85), message: text.trim().slice(0, 120) })
      } else if (/Loading model|Processing file|Starting separation/i.test(text)) {
        onProgress({ jobId, percent: 12, message: 'UVR 推理中…' })
      }
    }
    child.stdout.on('data', handle)
    child.stderr.on('data', handle)
    child.on('error', (err) => {
      resolve({ jobId, ok: false, error: `无法启动 UVR：${err.message}`, engineUsed: 'uvr-mdx' })
    })
    child.on('close', (code) => {
      const files = fs.existsSync(outRoot)
        ? fs.readdirSync(outRoot).filter((n) => /\.(wav|flac|mp3)$/i.test(n)).map((n) => path.join(outRoot, n))
        : []
      const kept: string[] = []
      for (const f of files) {
        const stem = path.basename(f).toLowerCase()
        if (stem.includes('vocal') && outputs.vocals !== false) kept.push(f)
        else if ((stem.includes('instrumental') || stem.includes('no_vocal')) && outputs.instrumental !== false)
          kept.push(f)
      }
      const finalFiles = kept.length ? kept : files
      if (code === 0 && finalFiles.length > 0 && finalFiles.every((f) => fs.statSync(f).size > 44)) {
        onProgress({ jobId, percent: 100, message: 'UVR · MDX-Net 完成' })
        resolve({
          jobId,
          ok: true,
          outputPath: finalFiles[0],
          outputPaths: finalFiles,
          engineUsed: `uvr-mdx:${model.model}`,
          message: `UVR MDX-Net 已写出 ${finalFiles.length} 个文件`,
        })
        return
      }
      const tail = buf.trim().split('\n').slice(-12).join('\n')
      resolve({
        jobId,
        ok: false,
        error: `UVR MDX-Net 退出码 ${code ?? 'null'}。\n` + (tail || ''),
        engineUsed: 'uvr-mdx',
      })
    })
  })
}

/** 在本机分离人声 / 伴奏等轨道。 */
export async function separateVocals(
  req: SeparateVocalsRequest,
  jobId: string,
  onProgress: (ev: ConvertProgressEvent) => void,
): Promise<SeparateVocalsResult> {
  onProgress = decorateProgress(jobId, onProgress)

  const inputPath = req.inputPath
  if (!inputPath || !fs.existsSync(inputPath)) {
    return failResult(jobId, 'E-PATH-MISSING', `输入文件不存在：${inputPath}`)
  }
  if (isCancelRequested(jobId)) return cancelledResult(jobId)
  const destProbe = req.outputDir || path.dirname(inputPath)
  const disk = preflightOutput(jobId, destProbe, { kind: 'vocal', inputPaths: inputPath })
  if (!disk.ok) return disk.result

  const model = req.model || 'demucs-htdemucs'
  const backend: VocalBackend =
    req.backend ||
    (model === 'ffmpeg-simple'
      ? 'ffmpeg-simple'
      : model.startsWith('uvr')
        ? 'uvr'
        : 'demucs')

  if (backend === 'uvr' || model.startsWith('uvr')) {
    if (model === 'uvr-vr') {
      return {
        jobId,
        ok: false,
        error: 'UVR · VR Architecture 尚未接入。请改用 Demucs 或 UVR · MDX-Net。',
        engineUsed: 'uvr',
      }
    }
    return separateWithUvr(req, jobId, onProgress)
  }

  const probe = await probeVocalEngine(true)

  if (backend === 'ffmpeg-simple' || model === 'ffmpeg-simple') {
    return separateWithFfmpegSimple(req, jobId, onProgress)
  }

  // demucs path
  if (!probe.demucsModuleOk) {
    return {
      jobId,
      ok: false,
      error:
        'Demucs 未安装，不会假装分离成功。\n\n' +
        INSTALL_HINT +
        (probe.ffmpegFallbackReady
          ? '\n\n也可在界面选择「FFmpeg 简易分离」作为低质量降级。'
          : ''),
      engineUsed: 'demucs',
    }
  }

  return separateWithDemucs(req, jobId, onProgress, probe)
}

/** Node smoke helper — no Electron BrowserWindow needed */
export async function smokeSeparate(
  inputPath: string,
  outDir: string,
  prefer: 'demucs' | 'ffmpeg-simple' | 'auto' = 'auto',
): Promise<SeparateVocalsResult> {
  const probe = await probeVocalEngine(true)
  const jobId = `smoke-${Date.now()}`
  const onProgress = (ev: ConvertProgressEvent) => {
    console.log(`[vocal ${ev.percent.toFixed(0)}%] ${ev.message || ''}`)
  }
  if (prefer === 'ffmpeg-simple' || (prefer === 'auto' && !probe.demucsModuleOk)) {
    return separateVocals(
      { inputPath, outputDir: outDir, model: 'ffmpeg-simple', backend: 'ffmpeg-simple' },
      jobId,
      onProgress,
    )
  }
  return separateVocals(
    {
      inputPath,
      outputDir: outDir,
      model: 'demucs-htdemucs',
      backend: 'demucs',
      outputs: { vocals: true, instrumental: true },
      device: 'cpu',
    },
    jobId,
    onProgress,
  )
}

// 保留 os 导入，避免未使用告警被清掉；以后 UVR 工作目录还用得上
