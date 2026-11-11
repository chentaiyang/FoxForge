/**
 * 人声分离冒烟：检查架构字符串、FFmpeg 简易回退，以及可选的 Demucs / UVR。
 * 跑法：npm run smoke:vocal
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const require = createRequire(import.meta.url)

function whichSync(cmd) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    const full = path.join(dir, cmd)
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
    } catch {}
  }
  return null
}

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true, env: process.env })
    let stdout = '', stderr = ''
    const t = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: String(e) }) })
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

const input = path.join(root, 'test-fixtures', 'tone.wav')
const outDir = path.join(root, 'test-fixtures', 'vocal-smoke-out')
fs.mkdirSync(outDir, { recursive: true })

if (!fs.existsSync(input)) {
  // 若被 gitignore 或缺失，就重新生成一小段测试音调
  const ffmpeg = whichSync('ffmpeg')
  if (!ffmpeg) {
    console.error('FAIL: missing tone.wav and ffmpeg')
    process.exit(1)
  }
  const r = await run(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-ac', '2', input,
  ])
  if (r.code !== 0) {
    console.error('FAIL: cannot create tone.wav', r.stderr.slice(-300))
    process.exit(1)
  }
  console.log('OK recreated', input)
}

console.log('input:', input)

// 1) 检查已构建的 main（若有）或源码里的架构字符串
const mainSrc = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8')
for (const needle of ['vocal:separate', 'vocal:probe', 'separateVocals']) {
  if (!mainSrc.includes(needle)) {
    console.error('FAIL: main.ts missing', needle)
    process.exit(1)
  }
}
console.log('OK IPC wiring in main.ts')

const vocalSrc = fs.readFileSync(path.join(root, 'electron', 'engines', 'vocal.ts'), 'utf8')
for (const needle of ['probeVocalEngine', 'ffmpeg-simple', 'INSTALL_HINT', 'demucs']) {
  if (!vocalSrc.includes(needle)) {
    console.error('FAIL: vocal.ts missing', needle)
    process.exit(1)
  }
}
console.log('OK vocal engine module present')

// 2) FFmpeg 简易回退冒烟（只要有 ffmpeg 就必须过）
const ffmpeg = whichSync('ffmpeg')
if (!ffmpeg) {
  console.error('FAIL: ffmpeg missing (needed for fallback smoke)')
  process.exit(1)
}

const vOut = path.join(outDir, 'tone_vocals_simple.wav')
const iOut = path.join(outDir, 'tone_instrumental_simple.wav')
const r1 = await run(ffmpeg, ['-y', '-hide_banner', '-i', input, '-af', 'pan=mono|c0=0.5*c0+0.5*c1', vOut])
const r2 = await run(ffmpeg, ['-y', '-hide_banner', '-i', input, '-af', 'pan=mono|c0=0.5*c0-0.5*c1', iOut])
if (r1.code !== 0 || !fs.existsSync(vOut) || r2.code !== 0 || !fs.existsSync(iOut)) {
  console.error('FAIL ffmpeg-simple', r1.stderr.slice(-400), r2.stderr.slice(-400))
  process.exit(1)
}
console.log('OK ffmpeg-simple vocals bytes=', fs.statSync(vOut).size, 'instrumental=', fs.statSync(iOut).size)

// 3) 探测 Demucs，并在可用时跑一小段 CPU 任务
const venvPy = path.join(root, '.venv-demucs', 'bin', 'python')
const py = (fs.existsSync(venvPy) ? venvPy : null) || whichSync('python3') || whichSync('python')
let demucsOk = false
if (py) {
  const chk = await run(py, ['-c', 'import demucs; print(getattr(demucs,"__version__","ok"))'], 30000)
  if (chk.code === 0) {
    demucsOk = true
    console.log('OK demucs module via', py, (chk.stdout || '').trim())
  } else {
    console.log('WARN demucs not importable:', (chk.stderr || '').slice(-200))
  }
} else {
  console.log('WARN no python for demucs')
}

const preferDemucs = process.env.MEDIAFORGE_SMOKE_DEMUCS === '1' || process.argv.includes('--demucs')
if (demucsOk && preferDemucs) {
  console.log('Running Demucs CPU smoke (may download model, can take minutes)…')
  const demucsOut = path.join(outDir, 'demucs')
  fs.mkdirSync(demucsOut, { recursive: true })
  const args = ['-m', 'demucs', '-n', 'htdemucs', '-d', 'cpu', '--two-stems', 'vocals', '-o', demucsOut, input]
  const dr = await run(py, args, 600_000)
  const trackDir = path.join(demucsOut, 'htdemucs', 'tone')
  const vocals = path.join(trackDir, 'vocals.wav')
  const noVocals = path.join(trackDir, 'no_vocals.wav')
  if (dr.code === 0 && fs.existsSync(vocals)) {
    console.log('OK demucs vocals bytes=', fs.statSync(vocals).size)
    if (fs.existsSync(noVocals)) console.log('OK demucs no_vocals bytes=', fs.statSync(noVocals).size)
  } else {
    console.error('FAIL demucs smoke code', dr.code)
    console.error((dr.stderr || dr.stdout).slice(-800))
    console.log('NOTE: architecture + ffmpeg-simple already OK; demucs model/network issue')
    process.exit(2)
  }
} else if (demucsOk) {
  console.log('SKIP demucs inference (set MEDIAFORGE_SMOKE_DEMUCS=1 or pass --demucs to run). Probe OK.')
} else {
  console.log('SKIP demucs inference (not installed). Install via: node scripts/ensure-demucs.mjs')
}


// 模型和运行器都在时，再试 UVR · MDX-Net（ONNX Runtime）
const uvrModel = path.join(root, 'resources', 'uvr-models', 'UVR_MDXNET_1_9703.onnx')
const uvrRunner = path.join(root, 'scripts', 'uvr-separate.py')
if (fs.existsSync(uvrModel) && fs.existsSync(uvrRunner) && py) {
  const uvrOut = path.join(outDir, 'uvr')
  fs.mkdirSync(uvrOut, { recursive: true })
  console.log('Running UVR MDX-Net smoke…')
  const ur = await run(py, [
    uvrRunner,
    input,
    '--output-dir',
    uvrOut,
    '--model-dir',
    path.dirname(uvrModel),
    '--model',
    'UVR_MDXNET_1_9703.onnx',
  ], 180_000)
  const produced = fs.existsSync(uvrOut)
    ? fs.readdirSync(uvrOut).filter((n) => n.toLowerCase().endsWith('.wav')).map((n) => path.join(uvrOut, n))
    : []
  const okFiles = produced.filter((f) => fs.statSync(f).size > 44)
  if (ur.code === 0 && okFiles.length >= 2) {
    for (const f of okFiles) console.log('OK uvr', path.basename(f), 'bytes=', fs.statSync(f).size)
  } else {
    console.error('FAIL uvr smoke code', ur.code)
    console.error((ur.stderr || ur.stdout).slice(-800))
    process.exit(1)
  }
} else {
  console.log('SKIP UVR MDX-Net (run: node scripts/ensure-uvr.mjs)')
}

console.log('PASS smoke-vocal')
process.exit(0)
