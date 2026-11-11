#!/usr/bin/env node
/**
 * 探测 pandoc；加 --install 时先试 apt，再下载官方 linux amd64 包到 resources/bin。
 * 默认是 dry-run，不会卸载已有软件。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const wantInstall = process.argv.includes('--install')
const PANDOC_VER = '3.13'

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH || '').split(sep)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  const local = path.join(root, 'resources', 'bin', process.platform === 'win32' ? `${cmd}.exe` : cmd)
  if (fs.existsSync(local)) return local
  return null
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects > 12) return reject(new Error('too many redirects'))
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

const found = which('pandoc')
if (found) {
  const ver = spawnSync(found, ['--version'], { encoding: 'utf8' })
  console.log('OK pandoc found:', found)
  console.log((ver.stdout || ver.stderr || '').split('\n')[0])
  process.exit(0)
}

console.log('Pandoc not found in PATH or resources/bin.')

if (!wantInstall) {
  console.log('Hint (Linux box): node scripts/ensure-pandoc.mjs --install')
  console.log('Or: sudo apt-get install -y pandoc')
  console.log('Or put pandoc binary into resources/bin/')
  console.log('Windows: install from https://github.com/jgm/pandoc/releases and add to PATH')
  process.exit(1)
}

if (process.platform === 'linux') {
  console.log('Trying apt-get install pandoc…')
  const update = spawnSync('sudo', ['apt-get', 'update'], { stdio: 'inherit' })
  if (update.status === 0) {
    const install = spawnSync('sudo', ['apt-get', 'install', '-y', 'pandoc'], { stdio: 'inherit' })
    if (install.status === 0) {
      const again = which('pandoc')
      if (again) {
        console.log('OK apt installed:', again)
        process.exit(0)
      }
    }
  }
  console.log('apt failed or unavailable; downloading official linux amd64 tarball…')

  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64'
  const url = `https://github.com/jgm/pandoc/releases/download/${PANDOC_VER}/pandoc-${PANDOC_VER}-linux-${arch}.tar.gz`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-pandoc-'))
  const tgz = path.join(tmp, 'pandoc.tar.gz')
  console.log('GET', url)
  try {
    await download(url, tgz)
  } catch (e) {
    console.error('download failed:', e.message || e)
    process.exit(1)
  }
  const extract = spawnSync('tar', ['-xzf', tgz, '-C', tmp], { encoding: 'utf8' })
  if (extract.status !== 0) {
    console.error('tar extract failed', extract.stderr)
    process.exit(1)
  }
  // 在解包结果里查找 bin/pandoc
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        const hit = walk(full)
        if (hit) return hit
      } else if (name === 'pandoc' && st.isFile()) {
        return full
      }
    }
    return null
  }
  const bin = walk(tmp)
  if (!bin) {
    console.error('pandoc binary not found in tarball')
    process.exit(1)
  }
  const destDir = path.join(root, 'resources', 'bin')
  fs.mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, 'pandoc')
  fs.copyFileSync(bin, dest)
  fs.chmodSync(dest, 0o755)
  console.log('OK installed to', dest)
  const ver = spawnSync(dest, ['--version'], { encoding: 'utf8' })
  console.log((ver.stdout || '').split('\n')[0])
  process.exit(0)
}

if (process.platform === 'win32') {
  console.error('--install on Windows: please download pandoc from GitHub releases and add to PATH,')
  console.error('or place pandoc.exe into resources/bin/')
  process.exit(1)
}

console.error('--install currently supports Linux (apt or official tarball). Install pandoc manually otherwise.')
process.exit(1)
