#!/usr/bin/env node
/**
 * 探测 Poppler（pdftoppm / pdftotext）和 qpdf。
 * --install-qpdf：把便携 qpdf 解到 resources/bin/qpdf-toolkit。
 * --apt：在 Linux 上尝试 apt 安装（源不可用时可能失败）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { createWriteStream } from 'node:fs'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const toolkitDir = path.join(root, 'resources', 'bin', 'qpdf-toolkit')
const installQpdf = process.argv.includes('--install-qpdf')
const apt = process.argv.includes('--apt')

function whichSync(cmd) {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    for (const name of [cmd, `${cmd}.exe`]) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  const local = path.join(toolkitDir, 'bin', process.platform === 'win32' ? `${cmd}.exe` : cmd)
  if (fs.existsSync(local)) return local
  return null
}

function run(bin, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 10) return reject(new Error('too many redirects'))
            return follow(res.headers.location, redirects + 1)
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${u}`))
            res.resume()
            return
          }
          const f = createWriteStream(dest)
          res.pipe(f)
          f.on('finish', () => f.close(() => resolve()))
          f.on('error', reject)
        })
        .on('error', reject)
    }
    follow(url)
  })
}

const pdftoppm = whichSync('pdftoppm')
const pdftotext = whichSync('pdftotext')
let qpdf = whichSync('qpdf')

console.log('pdftoppm:', pdftoppm || '(missing)')
console.log('pdftotext:', pdftotext || '(missing)')
console.log('qpdf:', qpdf || '(missing)')

if (apt && process.platform === 'linux') {
  console.log('Attempting apt install poppler-utils qpdf …')
  try {
    execSync('sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils qpdf', {
      stdio: 'inherit',
    })
  } catch (e) {
    console.warn('apt install failed:', e.message)
  }
}

if (installQpdf && !whichSync('qpdf')) {
  const asset =
    process.platform === 'win32'
      ? 'qpdf-12.4.2-msvc64.zip'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'qpdf-12.4.2-bin-macos-arm64.zip'
          : 'qpdf-12.4.2-bin-macos-x86_64.zip'
        : 'qpdf-12.4.2-bin-linux-x86_64.zip'
  const url = `https://github.com/qpdf/qpdf/releases/download/v12.4.2/${asset}`
  const zipPath = path.join(root, 'resources', 'bin', asset)
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  console.log('Downloading', url)
  await download(url, zipPath)
  fs.mkdirSync(toolkitDir, { recursive: true })
  execSync(`unzip -o "${zipPath}" -d "${toolkitDir}"`, { stdio: 'inherit' })
  // 有的 zip 解出后 bin/ 就在顶层，有的会再套一层，这里做归一化：
  if (!fs.existsSync(path.join(toolkitDir, 'bin')) && fs.existsSync(path.join(toolkitDir, 'qpdf'))) {
    // 已经是可用的几种布局
  }
  qpdf = whichSync('qpdf')
  console.log('Installed portable qpdf →', qpdf || toolkitDir)
}

qpdf = whichSync('qpdf')
if (qpdf) {
  const env = { ...process.env }
  const libDir = path.join(path.dirname(qpdf), '..', 'lib')
  if (fs.existsSync(libDir)) env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : '')
  const r = await run(qpdf, ['--version'], env)
  console.log(r.out.trim().split('\n')[0])
}

const okPoppler = Boolean(whichSync('pdftoppm') && whichSync('pdftotext'))
const okQpdf = Boolean(whichSync('qpdf'))
if (!okPoppler) {
  console.error('FAIL: Poppler incomplete. Try: sudo apt install poppler-utils   or --apt')
  process.exit(1)
}
if (!okQpdf) {
  console.error('WARN: qpdf missing (encrypt/decrypt unavailable). Try: --install-qpdf')
  process.exit(0)
}
console.log('PASS ensure-pdf-tools')
process.exit(0)
