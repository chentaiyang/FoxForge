#!/usr/bin/env node
/**
 * 为 Windows 安装包下载并布置全部转换引擎，供 electron-builder extraResources 打包。
 *
 * 用法：node scripts/ensure-windows-engines.mjs --install
 *
 * 为什么单独做这个脚本、而不是把二进制提交进 git：
 *   引擎合计可能超过 1 GB（尤其是 LibreOffice、Calibre、PyTorch CPU），不适合进版本库。
 *   CI（windows-latest）和本机 Windows 开发机在打包前运行本脚本即可。
 *
 * 陷阱：
 *   - 不要把不同工具包的 DLL 平铺进同一个目录，zlib / libpng 等很容易互相覆盖。
 *   - Windows venv / pip 生成的 Scripts/*.exe 经常写死绝对路径，打包后会失效；
 *     人声分离一律用「便携 Python 目录里的 python.exe -m demucs」，不要调 demucs.exe。
 *   - TESSDATA_PREFIX 若直接指向名为 tessdata 的目录，Tesseract 还会再找一层 tessdata/tessdata。
 *   - NSIS 的 /D= 安装路径不能加引号，且必须放在命令行最后。
 *   - 本脚本只支持 Windows x64；在 Linux 上运行会直接退出，避免误下 Windows 包。
 *   - 不下载、不捆绑任何加密音乐（NCM / MGG / KGM）解密器。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const wantInstall = process.argv.includes('--install')
const cacheDir = process.env.FOXFORGE_ENGINE_CACHE || path.join(root, '.cache', 'windows-engines')

const binDir = path.join(root, 'resources', 'bin')
const loDir = path.join(root, 'resources', 'LibreOffice')
const calibreDir = path.join(root, 'resources', 'calibre')
const pyDir = path.join(root, 'resources', 'vocal-python')
const tessdataDir = path.join(root, 'resources', 'tessdata')
const uvrDir = path.join(root, 'resources', 'uvr-models')
const popplerDir = path.join(binDir, 'poppler')
const qpdfDir = path.join(binDir, 'qpdf-toolkit')
const tesseractDir = path.join(binDir, 'tesseract')

const UA = 'FoxForge-engine-bootstrap/0.1.2 (https://github.com/chentaiyang/FoxForge)'

const PYTHON_CANDIDATES = ['3.12.10', '3.12.9', '3.12.8', '3.12.7', '3.11.13', '3.11.11']
const PANDOC_VER = '3.13'
const UVR_MODEL = 'UVR_MDXNET_1_9703.onnx'
const UVR_URLS = [
  `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${UVR_MODEL}`,
]

function log(...args) {
  console.log('[engines]', ...args)
}

function fail(msg) {
  console.error('[engines] FAIL:', msg)
  process.exit(1)
}

function existsFile(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function walkFiles(dir, acc = [], depth = 0) {
  if (!dir || !fs.existsSync(dir) || depth > 12) return acc
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of names) {
    const full = path.join(dir, name)
    let st
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walkFiles(full, acc, depth + 1)
    else acc.push(full)
  }
  return acc
}

function findFile(rootDir, predicate) {
  for (const full of walkFiles(rootDir)) {
    if (predicate(path.basename(full), full)) return full
  }
  return null
}

function request(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 16) return reject(new Error(`too many redirects: ${url}`))
    const lib = url.startsWith('http://') ? http : https
    const req = lib.get(
      url,
      {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: 10 * 60 * 1000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, url).toString()
          return resolve(request(next, dest, redirects + 1))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
        }
        mkdir(path.dirname(dest))
        const tmp = `${dest}.partial`
        const out = fs.createWriteStream(tmp)
        const total = Number(res.headers['content-length'] || 0)
        let got = 0
        let lastLog = Date.now()
        res.on('data', (chunk) => {
          got += chunk.length
          if (total && Date.now() - lastLog > 3000) {
            lastLog = Date.now()
            log(`  ${path.basename(dest)} ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
          }
        })
        res.pipe(out)
        out.on('finish', () => {
          out.close(() => {
            fs.renameSync(tmp, dest)
            resolve(dest)
          })
        })
        out.on('error', reject)
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`timeout downloading ${url}`)))
  })
}

async function fetchText(url) {
  const tmp = path.join(os.tmpdir(), `foxforge-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  await request(url, tmp)
  const text = fs.readFileSync(tmp, 'utf8')
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* 忽略 */
  }
  return text
}

async function cachedDownload(url, filename) {
  mkdir(cacheDir)
  const dest = path.join(cacheDir, filename)
  if (existsFile(dest) && fs.statSync(dest).size > 1024) {
    log('cache hit', filename, `${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`)
    return dest
  }
  log('GET', url)
  await request(url, dest)
  log('saved', filename, `${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`)
  return dest
}

function run(bin, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) }
  log('>', bin, args.join(' '))
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.stdio || 'pipe',
    cwd: opts.cwd || root,
    env,
    timeout: opts.timeout ?? 10 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return r
}

function find7z() {
  const cands = [
    '7z',
    '7z.exe',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]
  for (const c of cands) {
    if (path.isAbsolute(c) && existsFile(c)) return c
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8', windowsHide: true })
    const line = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (line && existsFile(line)) return line
  }
  return null
}

async function ensure7z() {
  const existing = find7z()
  if (existing) return existing
  // 官方 7-Zip 安装包；静默装到缓存目录，只为解 NSIS / MSI 服务
  const installer = await cachedDownload('https://www.7-zip.org/a/7z2501-x64.exe', '7z2501-x64.exe').catch(async () =>
    cachedDownload('https://www.7-zip.org/a/7z2409-x64.exe', '7z2409-x64.exe'),
  )
  const dest = path.join(cacheDir, '7zip')
  mkdir(dest)
  const r = run(installer, [`/S`, `/D=${dest}`])
  const exe = path.join(dest, '7z.exe')
  if (existsFile(exe)) return exe
  // 有的 7-Zip 安装器 /S 失败时，再试 chocolatey（仅 CI）
  const choco = run('choco', ['install', '7zip', '-y', '--no-progress'], { stdio: 'inherit' })
  if ((choco.status ?? 1) === 0) {
    const again = find7z()
    if (again) return again
  }
  throw new Error(`无法安装 7-Zip：${(r.stderr || r.stdout || '').slice(0, 400)}`)
}

function extractZip(zip, dest) {
  mkdir(dest)
  const tar = run('tar', ['-xf', zip, '-C', dest])
  if ((tar.status ?? 1) === 0) return
  const ps = run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Force -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}'`,
  ])
  if ((ps.status ?? 1) === 0) return
  throw new Error(`解压 zip 失败：${zip}\n${tar.stderr || ps.stderr || ''}`)
}

function extractMsi(msi, dest) {
  mkdir(dest)
  const r = run('msiexec', ['/a', msi, '/qn', `TARGETDIR=${dest}`], { stdio: 'inherit', timeout: 30 * 60 * 1000 })
  if ((r.status ?? 1) !== 0) {
    throw new Error(`msiexec /a 失败（${r.status}）：${msi}`)
  }
}

async function extractArchive(archive, dest) {
  mkdir(dest)
  const ext = path.extname(archive).toLowerCase()
  if (ext === '.zip') {
    extractZip(archive, dest)
    return
  }
  if (ext === '.msi') {
    extractMsi(archive, dest)
    return
  }
  const seven = await ensure7z()
  const r = run(seven, ['x', `-o${dest}`, '-y', archive], { stdio: 'inherit' })
  if ((r.status ?? 1) !== 0) throw new Error(`7z 解压失败：${archive}`)
}

function copyFile(src, dest) {
  mkdir(path.dirname(dest))
  fs.copyFileSync(src, dest)
}

function copyAdjacentDlls(srcExe, destDir) {
  const srcDir = path.dirname(srcExe)
  mkdir(destDir)
  for (const name of fs.readdirSync(srcDir)) {
    if (!/\.(dll|exe|pdb|xml|manifest)$/i.test(name) && !name.endsWith('.exe')) continue
    if (/\.(dll|exe)$/i.test(name)) copyFile(path.join(srcDir, name), path.join(destDir, name))
  }
}

function copyTree(src, dest) {
  mkdir(dest)
  for (const name of fs.readdirSync(src)) {
    if (name === '.' || name === '..') continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    const st = fs.statSync(from)
    if (st.isDirectory()) copyTree(from, to)
    else copyFile(from, to)
  }
}

/**
 * 官方 zip 常带一层版本目录（如 Release-26.09.0-0/ 或 qpdf-12.4.2-msvc64/）。
 * 若 dest 下恰好只有这一层前缀目录，就把它的内容提升到 dest，去掉多余前缀。
 * 已经是 bin/ 或 Library/ 这种目标布局则保持不变。可重复调用。
 */
export function hoistSingleTopDir(dest, keepNames = ['bin', 'Library', 'lib', 'share']) {
  if (!dest || !fs.existsSync(dest)) return false
  let entries
  try {
    entries = fs.readdirSync(dest).filter((n) => n !== '.' && n !== '..')
  } catch {
    return false
  }
  if (entries.length !== 1) return false
  const onlyName = entries[0]
  if (keepNames.some((k) => k.toLowerCase() === onlyName.toLowerCase())) return false
  const only = path.join(dest, onlyName)
  let st
  try {
    st = fs.statSync(only)
  } catch {
    return false
  }
  if (!st.isDirectory()) return false
  const children = fs.readdirSync(only)
  for (const child of children) {
    const from = path.join(only, child)
    const to = path.join(dest, child)
    if (fs.existsSync(to)) {
      const fromSt = fs.statSync(from)
      const toSt = fs.statSync(to)
      if (fromSt.isDirectory() && toSt.isDirectory()) {
        copyTree(from, to)
        fs.rmSync(from, { recursive: true, force: true })
        continue
      }
      throw new Error(`提升目录时目标已存在：${to}`)
    }
    fs.renameSync(from, to)
  }
  fs.rmSync(only, { recursive: true, force: true })
  return true
}

/**
 * 反复去掉版本前缀，直到 pdftoppm.exe / qpdf.exe 落在已知布局：
 *   poppler/Library/bin 或 poppler/bin
 *   qpdf-toolkit/bin（依赖库可保留在 ../lib）
 */
export function normalizePackagedToolkit(dest, exeName, preferredRelDirs) {
  if (!dest || !fs.existsSync(dest)) return null
  // 最多提升几层，避免死循环
  for (let i = 0; i < 4; i++) {
    if (!hoistSingleTopDir(dest)) break
  }
  const exe = findFile(dest, (n) => n.toLowerCase() === exeName.toLowerCase())
  if (!exe) return null
  const relDir = path.relative(dest, path.dirname(exe))
  const normalized = relDir.split(path.sep).join('/')
  const preferred = preferredRelDirs.map((d) => d.split(/[\\/]/).join('/').replace(/\/$/, ''))
  if (preferred.includes(normalized)) return exe
  // 若仍嵌在意外路径，再尝试把 exe 所在目录的父级提升一次
  hoistSingleTopDir(dest)
  return findFile(dest, (n) => n.toLowerCase() === exeName.toLowerCase()) || exe
}

function withExeDir(bin) {
  const env = { ...process.env }
  env.PATH = path.dirname(bin) + path.delimiter + (env.PATH || '')
  return env
}

function runBin(bin, args, timeout = 120000, extraEnv = {}) {
  return run(bin, args, { timeout, env: { ...withExeDir(bin), ...extraEnv } })
}

function already(bin, args, test, extraEnv = {}) {
  if (!existsFile(bin)) return false
  const r = runBin(bin, args, 120000, extraEnv)
  const text = `${r.stdout || ''}\n${r.stderr || ''}`
  if (typeof test === 'function') return test(r, text)
  // 进程能启动就算过（有的工具无 --version，退出码非 0 但会打印用法）
  return r.error?.code !== 'ENOENT'
}

async function installFfmpeg() {
  const ffmpeg = path.join(binDir, 'ffmpeg.exe')
  const ffprobe = path.join(binDir, 'ffprobe.exe')
  if (already(ffmpeg, ['-version'], (_r, t) => /ffmpeg version/i.test(t)) && already(ffprobe, ['-version'], (_r, t) => /ffprobe|ffmpeg/i.test(t))) {
    log('OK ffmpeg already present')
    return
  }
  // gyan.dev 的 essentials 是常用的官方社区构建；BtbN 官方 GitHub 构建作为后备（静态 gpl，无需额外 DLL）
  const urls = [
    ['https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', 'ffmpeg-release-essentials.zip'],
    ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', 'ffmpeg-btbn-win64-gpl.zip'],
  ]
  let zip
  let lastErr
  for (const [url, name] of urls) {
    try {
      zip = await cachedDownload(url, name)
      break
    } catch (e) {
      lastErr = e
      log('ffmpeg source failed', url, e.message || e)
    }
  }
  if (!zip) throw lastErr || new Error('FFmpeg 下载失败')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-ffmpeg-'))
  extractZip(zip, tmp)
  const ff = findFile(tmp, (n) => n.toLowerCase() === 'ffmpeg.exe')
  const fp = findFile(tmp, (n) => n.toLowerCase() === 'ffprobe.exe')
  if (!ff || !fp) throw new Error('FFmpeg zip 里没有 ffmpeg.exe / ffprobe.exe')
  mkdir(binDir)
  copyAdjacentDlls(ff, binDir)
  copyFile(ff, ffmpeg)
  copyFile(fp, ffprobe)
  log('OK ffmpeg', ffmpeg)
}

async function installPoppler() {
  if (fs.existsSync(popplerDir)) {
    normalizePackagedToolkit(popplerDir, 'pdftoppm.exe', ['Library/bin', 'bin'])
  }
  const exe = findFile(popplerDir, (n) => n.toLowerCase() === 'pdftoppm.exe')
  const txt = findFile(popplerDir, (n) => n.toLowerCase() === 'pdftotext.exe')
  if (exe && txt && already(exe, ['-v'], () => true)) {
    log('OK poppler already present', exe)
    return
  }
  // 官方 Poppler 不直接提供 Windows 预编译包。使用维护中的 oschwartz10612/poppler-windows：
  // 从 conda-forge poppler-feedstock 打包，附带依赖 DLL 与 poppler-data，Chocolatey 也用这一源。
  let tag = 'v26.09.0-0'
  let asset = 'Release-26.09.0-0.zip'
  try {
    const api = JSON.parse(await fetchText('https://api.github.com/repos/oschwartz10612/poppler-windows/releases/latest'))
    if (api.tag_name) tag = api.tag_name
    const zip = (api.assets || []).find((a) => /Release-.*\.zip$/i.test(a.name) && !/debug/i.test(a.name))
    if (zip) asset = zip.name
  } catch (e) {
    log('poppler latest lookup failed, using pinned', e.message || e)
  }
  const url = `https://github.com/oschwartz10612/poppler-windows/releases/download/${tag}/${asset}`
  const zip = await cachedDownload(url, asset)
  if (fs.existsSync(popplerDir)) fs.rmSync(popplerDir, { recursive: true, force: true })
  mkdir(popplerDir)
  extractZip(zip, popplerDir)
  const got = normalizePackagedToolkit(popplerDir, 'pdftoppm.exe', ['Library/bin', 'bin'])
  if (!got) throw new Error('Poppler zip 里没有 pdftoppm.exe')
  const rel = path.relative(popplerDir, path.dirname(got)).split(path.sep).join('/')
  if (rel !== 'Library/bin' && rel !== 'bin') {
    log('WARN poppler 布局仍含额外层级', rel, got)
  }
  if (!findFile(popplerDir, (n) => n.toLowerCase() === 'pdftotext.exe')) {
    throw new Error('Poppler zip 里没有 pdftotext.exe')
  }
  log('OK poppler', got)
}

async function installQpdf() {
  if (fs.existsSync(qpdfDir)) {
    normalizePackagedToolkit(qpdfDir, 'qpdf.exe', ['bin', ''])
  }
  const existing = findFile(qpdfDir, (n) => n.toLowerCase() === 'qpdf.exe') || path.join(binDir, 'qpdf.exe')
  if (existsFile(existing) && already(existing, ['--version'], (_r, t) => /qpdf/i.test(t))) {
    log('OK qpdf already present', existing)
    return
  }
  let tag = 'v12.4.2'
  let asset = 'qpdf-12.4.2-msvc64.zip'
  try {
    const api = JSON.parse(await fetchText('https://api.github.com/repos/qpdf/qpdf/releases/latest'))
    if (api.tag_name) tag = api.tag_name
    const assets = api.assets || []
    const prefer = assets.find((a) => /msvc64\.zip$/i.test(a.name)) || assets.find((a) => /mingw64\.zip$/i.test(a.name) || /mingw.*64.*\.zip$/i.test(a.name))
    if (prefer) asset = prefer.name
  } catch (e) {
    log('qpdf latest lookup failed, using pinned', e.message || e)
  }
  const url = `https://github.com/qpdf/qpdf/releases/download/${tag}/${asset}`
  const zip = await cachedDownload(url, asset)
  if (fs.existsSync(qpdfDir)) fs.rmSync(qpdfDir, { recursive: true, force: true })
  mkdir(qpdfDir)
  extractZip(zip, qpdfDir)
  const got = normalizePackagedToolkit(qpdfDir, 'qpdf.exe', ['bin', ''])
  if (!got) throw new Error('qpdf zip 里没有 qpdf.exe')
  const rel = path.relative(qpdfDir, path.dirname(got)).split(path.sep).join('/')
  if (rel !== 'bin' && rel !== '') {
    log('WARN qpdf 布局仍含额外层级', rel, got)
  }
  log('OK qpdf', got)
}

async function installPandoc() {
  const dest = path.join(binDir, 'pandoc.exe')
  if (already(dest, ['--version'], (_r, t) => /pandoc/i.test(t))) {
    log('OK pandoc already present')
    return
  }
  let ver = PANDOC_VER
  try {
    const api = JSON.parse(await fetchText('https://api.github.com/repos/jgm/pandoc/releases/latest'))
    if (api.tag_name && /^\d+\.\d+/.test(api.tag_name)) ver = api.tag_name.replace(/^v/, '')
  } catch {
    /* 与 ensure-pandoc.mjs 保持 3.13 一致作为后备 */
  }
  const asset = `pandoc-${ver}-windows-x86_64.zip`
  const url = `https://github.com/jgm/pandoc/releases/download/${ver}/${asset}`
  const zip = await cachedDownload(url, asset)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pandoc-'))
  extractZip(zip, tmp)
  const exe = findFile(tmp, (n) => n.toLowerCase() === 'pandoc.exe')
  if (!exe) throw new Error('Pandoc zip 里没有 pandoc.exe')
  mkdir(binDir)
  copyFile(exe, dest)
  log('OK pandoc', dest)
}

async function installLibraw() {
  const dest = path.join(binDir, 'dcraw_emu.exe')
  if (already(dest, [], () => true)) {
    log('OK dcraw_emu already present')
    return
  }
  // 官方 Windows 64 位构建：https://www.libraw.org/download （含 dcraw_emu.exe 与 DLL）
  let urls = [
    'https://www.libraw.org/data/LibRaw-0.22.3-Win64.zip',
    'https://www.libraw.org/data/LibRaw-0.22.2-Win64.zip',
    'https://www.libraw.org/data/LibRaw-0.21.5-Win64.zip',
  ]
  try {
    const html = await fetchText('https://www.libraw.org/download')
    const found = [...html.matchAll(/https?:\/\/[^"'+\s]+LibRaw-[0-9.]+-Win64\.zip/gi)].map((m) => m[0])
    const rel = [...html.matchAll(/LibRaw-([0-9.]+)-Win64\.zip/gi)].map((m) => `https://www.libraw.org/data/LibRaw-${m[1]}-Win64.zip`)
    urls = [...new Set([...found, ...rel, ...urls])]
  } catch (e) {
    log('libraw page parse failed, using pinned URLs', e.message || e)
  }
  let zip
  let lastErr
  for (const url of urls) {
    try {
      zip = await cachedDownload(url, path.basename(new URL(url).pathname))
      break
    } catch (e) {
      lastErr = e
      log('libraw source failed', url, e.message || e)
    }
  }
  if (!zip) throw lastErr || new Error('LibRaw 下载失败')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-libraw-'))
  extractZip(zip, tmp)
  const exe = findFile(tmp, (n) => n.toLowerCase() === 'dcraw_emu.exe')
  if (!exe) throw new Error('LibRaw zip 里没有 dcraw_emu.exe')
  mkdir(binDir)
  copyAdjacentDlls(exe, binDir)
  copyFile(exe, dest)
  log('OK dcraw_emu', dest)
}

async function installTesseract() {
  const exe = path.join(tesseractDir, 'tesseract.exe')
  mkdir(tessdataDir)
  const hasLangs = existsFile(path.join(tessdataDir, 'chi_sim.traineddata')) && existsFile(path.join(tessdataDir, 'eng.traineddata'))
  if (existsFile(exe) && hasLangs && already(exe, ['--tessdata-dir', tessdataDir, '--list-langs'], (_r, t) => /chi_sim/.test(t) && /(^|[\/\s])eng(\s|$)/m.test(t), { TESSDATA_PREFIX: tessdataDir })) {
    log('OK tesseract already present')
    return
  }
  // UB Mannheim 是 Tesseract 文档推荐的 Windows 构建来源
  let installerName = 'tesseract-ocr-w64-setup-5.4.0.20240606.exe'
  try {
    const html = await fetchText('https://digi.bib.uni-mannheim.de/tesseract/')
    const names = [...html.matchAll(/tesseract-ocr-w64-setup-(?:v)?5[\w.-]+\.exe/gi)]
      .map((m) => m[0])
      .filter((n) => !/alpha|beta|rc|dev/i.test(n))
    const scored = names.map((n) => {
      const m = n.match(/setup-v?(\d+(?:\.\d+)*)(?:\.(\d+))?/i)
      const ver = m ? m[1].split('.').map((x) => Number(x) || 0) : [0]
      const date = m && m[2] ? Number(m[2]) : 0
      return { n, ver, date }
    })
    scored.sort((a, b) => {
      const len = Math.max(a.ver.length, b.ver.length)
      for (let i = 0; i < len; i += 1) {
        const d = (a.ver[i] || 0) - (b.ver[i] || 0)
        if (d) return d
      }
      return a.date - b.date
    })
    if (scored.length) installerName = scored[scored.length - 1].n
  } catch (e) {
    log('tesseract directory listing failed, using pinned installer', e.message || e)
  }
  const url = `https://digi.bib.uni-mannheim.de/tesseract/${installerName}`
  const installer = await cachedDownload(url, installerName)
  mkdir(tesseractDir)
  // NSIS：/D= 不能加引号，必须放在最后。失败再 7z 解包。
  const silent = run(installer, ['/S', `/D=${tesseractDir}`], { stdio: 'inherit', timeout: 10 * 60 * 1000 })
  if (!existsFile(exe)) {
    log('silent tesseract install did not produce exe, extracting with 7z')
    const seven = await ensure7z()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tess-'))
    const xr = run(seven, ['x', `-o${tmp}`, '-y', installer], { stdio: 'inherit' })
    if ((xr.status ?? 1) !== 0) throw new Error(`Tesseract 安装/解压失败（msiec ${silent.status}）`)
    const found = findFile(tmp, (n) => n.toLowerCase() === 'tesseract.exe')
    if (!found) throw new Error('Tesseract 包里没有 tesseract.exe')
    copyAdjacentDlls(found, tesseractDir)
    copyFile(found, exe)
    const packedData = path.join(path.dirname(found), 'tessdata')
    if (fs.existsSync(packedData)) {
      for (const name of fs.readdirSync(packedData)) {
        if (name.endsWith('.traineddata')) copyFile(path.join(packedData, name), path.join(tessdataDir, name))
      }
    }
  } else {
    const bundled = path.join(tesseractDir, 'tessdata')
    if (fs.existsSync(bundled)) {
      for (const name of fs.readdirSync(bundled)) {
        if (name.endsWith('.traineddata')) copyFile(path.join(bundled, name), path.join(tessdataDir, name))
      }
    }
  }
  // 官方 tessdata 仓库补齐 chi_sim / eng（安装器有时只带 eng）
  for (const lang of ['eng', 'chi_sim', 'osd']) {
    const dest = path.join(tessdataDir, `${lang}.traineddata`)
    if (existsFile(dest) && fs.statSync(dest).size > 10000) continue
    const langUrl = `https://github.com/tesseract-ocr/tessdata/raw/main/${lang}.traineddata`
    const file = await cachedDownload(langUrl, `${lang}.traineddata`)
    copyFile(file, dest)
  }
  if (!existsFile(exe)) throw new Error('tesseract.exe 安装失败')
  log('OK tesseract', exe)
}

async function installLibreOffice() {
  const existing = findFile(loDir, (n) => n.toLowerCase() === 'soffice.exe')
  if (existing && already(existing, ['--headless', '--version'], (_r, t) => /libreoffice|openoffice/i.test(t) || t.length > 0)) {
    log('OK LibreOffice already present', existing)
    return
  }
  // 官方稳定版 MSI：https://download.documentfoundation.org/libreoffice/stable/
  let version = '26.8.2'
  try {
    const html = await fetchText('https://download.documentfoundation.org/libreoffice/stable/')
    const vers = [...html.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1])
    vers.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    if (vers.length) version = vers[vers.length - 1]
  } catch (e) {
    log('LibreOffice version listing failed, using pinned', e.message || e)
  }
  const asset = `LibreOffice_${version}_Win_x86-64.msi`
  const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/${asset}`
  const msi = await cachedDownload(url, asset)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-lo-'))
  extractMsi(msi, tmp)
  const soffice = findFile(tmp, (n, full) => n.toLowerCase() === 'soffice.exe' && /[\\/]program[\\/]/i.test(full))
  if (!soffice) throw new Error('LibreOffice MSI 解包后没有 program/soffice.exe')
  // program/ 的上一级才是完整安装树（program + share + readmes …）
  const tree = path.dirname(path.dirname(soffice))
  if (fs.existsSync(loDir)) fs.rmSync(loDir, { recursive: true, force: true })
  mkdir(path.dirname(loDir))
  try {
    fs.renameSync(tree, loDir)
  } catch {
    // Windows 上临时盘与仓库可能不在同一卷，rename 会失败
    copyTree(tree, loDir)
    fs.rmSync(tree, { recursive: true, force: true })
  }
  const got = path.join(loDir, 'program', 'soffice.exe')
  if (!existsFile(got)) throw new Error('移动 LibreOffice 树之后找不到 soffice.exe')
  log('OK LibreOffice', got)
}

async function installCalibre() {
  const existing = findFile(calibreDir, (n) => n.toLowerCase() === 'ebook-convert.exe')
  if (existing && already(existing, ['--version'], (_r, t) => /calibre|ebook-convert/i.test(t))) {
    log('OK calibre already present', existing)
    return
  }
  let version = '9.18.0'
  for (const u of ['https://code.calibre-ebook.com/latest', 'https://calibre-ebook.com/latest_version']) {
    try {
      const v = (await fetchText(u)).trim().split(/\s+/)[0]
      if (/^\d+\.\d+/.test(v)) {
        version = v
        break
      }
    } catch {
      /* 下一个 */
    }
  }
  log('Calibre version', version)
  const msiNames = [`calibre-64bit-${version}.msi`, `calibre-${version}.msi`]
  let installed = false
  let lastErr
  for (const name of msiNames) {
    try {
      const url = `https://download.calibre-ebook.com/${version}/${name}`
      const msi = await cachedDownload(url, name)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-calibre-'))
      extractMsi(msi, tmp)
      const exe = findFile(tmp, (n) => n.toLowerCase() === 'ebook-convert.exe')
      if (!exe) throw new Error('msiexec 解包后没有 ebook-convert.exe')
      const tree = path.dirname(exe)
      if (fs.existsSync(calibreDir)) fs.rmSync(calibreDir, { recursive: true, force: true })
      mkdir(path.dirname(calibreDir))
      // 保留 ebook-convert 所在目录的完整树（Calibre 需要同目录 DLL / resources）
      copyTree(tree, calibreDir)
      installed = true
      break
    } catch (e) {
      lastErr = e
      log('calibre MSI path failed', name, e.message || e)
    }
  }
  if (!installed) {
    // 官方便携安装器：calibre-portable-installer.exe "目标目录"
    const name = `calibre-portable-installer-${version}.exe`
    const url = `https://download.calibre-ebook.com/${version}/${name}`
    const installer = await cachedDownload(url, name)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-calibre-port-'))
    const r = run(installer, [tmp], { stdio: 'inherit', timeout: 30 * 60 * 1000 })
    if ((r.status ?? 1) !== 0) throw lastErr || new Error(`Calibre 便携安装失败：${r.status}`)
    const exe = findFile(tmp, (n) => n.toLowerCase() === 'ebook-convert.exe')
    if (!exe) throw new Error('Calibre 便携安装后没有 ebook-convert.exe')
    if (fs.existsSync(calibreDir)) fs.rmSync(calibreDir, { recursive: true, force: true })
    copyTree(path.dirname(exe), calibreDir)
  }
  const got = findFile(calibreDir, (n) => n.toLowerCase() === 'ebook-convert.exe')
  if (!got) throw new Error('Calibre 安装失败')
  log('OK calibre', got)
}

async function installPythonEnv() {
  const py = path.join(pyDir, 'python.exe')
  const probe = `import demucs, onnxruntime, audio_separator; print('demucs-ok', getattr(demucs,'__version__','ok')); print('ort', onnxruntime.__version__)`
  if (existsFile(py)) {
    const r = runBin(py, ['-c', probe], 180000)
    if ((r.status ?? 1) === 0) {
      log('OK vocal python already present', py)
      return
    }
    log('python exists but packages missing, will install deps')
  }
  if (!existsFile(py)) {
    // 用官方 Windows x64 安装器装到 resources/vocal-python（完整发行，可随目录搬迁）。
    // 不用 venv：Scripts/*.exe 会写死 CI 绝对路径，用户机器上会失效。调用时一律 python.exe -m。
    let installer
    let lastErr
    for (const ver of PYTHON_CANDIDATES) {
      const name = `python-${ver}-amd64.exe`
      const url = `https://www.python.org/ftp/python/${ver}/${name}`
      try {
        installer = await cachedDownload(url, name)
        break
      } catch (e) {
        lastErr = e
        log('python installer missed', ver, e.message || e)
      }
    }
    if (!installer) throw lastErr || new Error('官方 Python 安装器下载失败')
    if (fs.existsSync(pyDir)) fs.rmSync(pyDir, { recursive: true, force: true })
    mkdir(pyDir)
    const args = [
      '/quiet',
      'InstallAllUsers=0',
      'PrependPath=0',
      'Include_launcher=0',
      'Include_test=0',
      'Include_doc=0',
      'Include_pip=1',
      'Include_tcltk=0',
      `TargetDir=${pyDir}`,
    ]
    const r = run(installer, args, { stdio: 'inherit', timeout: 15 * 60 * 1000 })
    if (!existsFile(py)) throw new Error(`Python 静默安装失败（${r.status}）`)
  }
  const pipArgs = ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel']
  let pip = runBin(py, pipArgs, 10 * 60 * 1000)
  if ((pip.status ?? 1) !== 0) throw new Error(`pip 升级失败：${pip.stderr || pip.stdout}`)
  pip = runBin(py, ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'], 30 * 60 * 1000)
  if ((pip.status ?? 1) !== 0) throw new Error(`安装 torch CPU 失败：${pip.stderr || pip.stdout}`)
  // audioop-lts 只给 Python 3.13+（标准库移除了 audioop）；3.12 自带该模块，强行安装会失败
  const verOut = runBin(py, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'])
  const pyVer = (verOut.stdout || '').trim()
  const pkgs = [
    'demucs',
    'numpy',
    'torchaudio',
    'onnxruntime',
    'audio-separator',
    'onnx',
    'librosa',
    'soundfile',
    'scipy',
    'ml_collections',
    'pydub',
    'pyyaml',
    'requests',
    'tqdm',
    'einops',
    'audioread',
    'resampy',
    'six',
    'packaging',
  ]
  const minor = Number((pyVer.split('.')[1] || '0'))
  const major = Number((pyVer.split('.')[0] || '0'))
  if (major > 3 || (major === 3 && minor >= 13)) pkgs.push('audioop-lts')
  pip = runBin(py, ['-m', 'pip', 'install', ...pkgs], 30 * 60 * 1000)
  if ((pip.status ?? 1) !== 0) throw new Error(`安装 demucs/UVR 依赖失败：${pip.stderr || pip.stdout}`)
  const check = runBin(py, ['-c', probe], 180000)
  if ((check.status ?? 1) !== 0) throw new Error(`校验 Python 环境失败：${check.stderr || check.stdout}`)
  log('OK vocal python', py)
}

async function installUvrModel() {
  mkdir(uvrDir)
  const dest = path.join(uvrDir, UVR_MODEL)
  if (existsFile(dest) && fs.statSync(dest).size > 1024 * 1024) {
    log('OK UVR model already present', dest, fs.statSync(dest).size)
    return
  }
  // 开发机上可能已经有 gitignored 的模型文件
  const local = path.join(root, 'resources', 'uvr-models', UVR_MODEL)
  if (local !== dest && existsFile(local) && fs.statSync(local).size > 1024 * 1024) {
    copyFile(local, dest)
    log('OK UVR model copied from local', dest)
    return
  }
  let lastErr
  for (const url of UVR_URLS) {
    try {
      const file = await cachedDownload(url, UVR_MODEL)
      copyFile(file, dest)
      if (fs.statSync(dest).size > 1024 * 1024) {
        log('OK UVR model', dest)
        return
      }
    } catch (e) {
      lastErr = e
      log('UVR model download failed', url, e.message || e)
    }
  }
  throw lastErr || new Error('UVR 模型下载失败')
}

function verifyAll() {
  const problems = []
  const check = (label, bin, args, ok) => {
    if (!bin || !existsFile(bin)) {
      problems.push(`${label}: 找不到 ${bin || '(null)'}`)
      return
    }
    const r = runBin(bin, args, 180000, ok?.env || {})
    const text = `${r.stdout || ''}\n${r.stderr || ''}`
    const pass = ok?.test ? ok.test(r, text) : r.error?.code !== 'ENOENT'
    if (!pass) problems.push(`${label}: 运行失败\n${text.slice(0, 500)}`)
    else log('verify', label, 'OK', (text.split(/\r?\n/).find((l) => l.trim()) || '').slice(0, 120))
  }

  const ffmpeg = path.join(binDir, 'ffmpeg.exe')
  const ffprobe = path.join(binDir, 'ffprobe.exe')
  const pandoc = path.join(binDir, 'pandoc.exe')
  const dcraw = path.join(binDir, 'dcraw_emu.exe')
  const tesseract = path.join(tesseractDir, 'tesseract.exe')
  const soffice = path.join(loDir, 'program', 'soffice.exe')
  const qpdf = findFile(qpdfDir, (n) => n.toLowerCase() === 'qpdf.exe')
  const pdftoppm = findFile(popplerDir, (n) => n.toLowerCase() === 'pdftoppm.exe')
  const pdftotext = findFile(popplerDir, (n) => n.toLowerCase() === 'pdftotext.exe')
  const calibre = findFile(calibreDir, (n) => n.toLowerCase() === 'ebook-convert.exe')
  const py = path.join(pyDir, 'python.exe')
  const model = path.join(uvrDir, UVR_MODEL)
  const runner = path.join(root, 'scripts', 'uvr-separate.py')

  check('ffmpeg', ffmpeg, ['-version'], { test: (_r, t) => /ffmpeg version/i.test(t) })
  check('ffprobe', ffprobe, ['-version'], { test: (_r, t) => /ffprobe|ffmpeg/i.test(t) })
  check('pdftoppm', pdftoppm, ['-v'], { test: () => true })
  check('pdftotext', pdftotext, ['-v'], { test: () => true })
  check('qpdf', qpdf, ['--version'], { test: (_r, t) => /qpdf/i.test(t) })
  check('pandoc', pandoc, ['--version'], { test: (_r, t) => /pandoc/i.test(t) })
  check('dcraw_emu', dcraw, [], { test: (r) => r.error?.code !== 'ENOENT' })
  check('tesseract', tesseract, ['--tessdata-dir', tessdataDir, '--list-langs'], {
    env: { TESSDATA_PREFIX: tessdataDir },
    test: (_r, t) => /chi_sim/.test(t) && /(^|[\/\s])eng(\s|$)/m.test(t),
  })
  const sofficeCli = existsFile(path.join(loDir, 'program', 'soffice.com'))
    ? path.join(loDir, 'program', 'soffice.com')
    : soffice
  check('soffice', sofficeCli, ['--version'], {
    test: (r, t) => r.error?.code !== 'ENOENT' && (t.length > 0 || (r.status ?? 1) === 0),
  })
  check('ebook-convert', calibre, ['--version'], { test: (_r, t) => /calibre|ebook-convert/i.test(t) })
  check('python-demucs-uvr', py, ['-c', 'import demucs, onnxruntime; print("ok")'], {
    test: (_r, t) => /\bok\b/.test(t),
  })
  if (!existsFile(model) || fs.statSync(model).size < 1024 * 1024) problems.push(`UVR 模型缺失或过小：${model}`)
  else log('verify UVR model OK', fs.statSync(model).size)
  if (!existsFile(runner)) problems.push(`缺少 scripts/uvr-separate.py`)
  if (!existsFile(path.join(tessdataDir, 'chi_sim.traineddata'))) problems.push('缺少 chi_sim.traineddata')
  if (!existsFile(path.join(tessdataDir, 'eng.traineddata'))) problems.push('缺少 eng.traineddata')

  if (problems.length) {
    fail('引擎校验未通过：\n- ' + problems.join('\n- '))
  }
  log('All required Windows engines verified.')
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('ensure-windows-engines.mjs --install 只在 Windows x64 上下载引擎。当前平台是', process.platform)
    console.log('请在 GitHub Actions windows-latest 或本机 Windows 上运行。')
    process.exit(wantInstall ? 1 : 0)
  }
  if (os.arch() !== 'x64') {
    fail(`仅支持 Windows x64，当前是 ${os.arch()}`)
  }
  if (!wantInstall) {
    console.log('探测模式。要下载并布置全部 Windows 引擎，请加 --install。')
    verifyAll()
    return
  }
  mkdir(binDir)
  mkdir(cacheDir)
  await installFfmpeg()
  await installPoppler()
  await installQpdf()
  await installPandoc()
  await installLibraw()
  await installTesseract()
  await installLibreOffice()
  await installCalibre()
  await installPythonEnv()
  await installUvrModel()
  verifyAll()
}

// 被其它脚本 import 时不要自动跑安装流程
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
