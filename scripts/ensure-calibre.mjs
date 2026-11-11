#!/usr/bin/env node
/**
 * 可选的 Calibre（ebook-convert）安装助手，用于 MOBI / AZW3。
 * 默认只探测；加 --install 时尝试把官方 linux x64 包解到 resources/calibre。
 * 不实现、也不协助去除 DRM。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const wantInstall = process.argv.includes('--install')

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const extras = [
    path.join(root, 'resources', 'bin'),
    path.join(root, 'resources', 'calibre'),
    path.join(root, 'resources', 'calibre', 'bin'),
  ]
  for (const dir of [...extras, ...(process.env.PATH || '').split(sep)]) {
    for (const name of [cmd, `${cmd}.exe`]) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  return null
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, n = 0) => {
      const lib = u.startsWith('http://') ? awaitHttp() : https
      lib
        .get(u, { rejectUnauthorized: false }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (n > 12) return reject(new Error('too many redirects'))
            return follow(res.headers.location, n + 1)
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

function awaitHttp() {
  return require('node:http')
}

const found = which('ebook-convert')
if (found) {
  const ver = spawnSync(found, ['--version'], { encoding: 'utf8' })
  console.log('OK ebook-convert:', found)
  console.log((ver.stdout || ver.stderr || '').split('\n')[0])
  process.exit(0)
}

console.log('Calibre ebook-convert not found in PATH or resources/calibre')
if (!wantInstall) {
  console.log('Hint: node scripts/ensure-calibre.mjs --install')
  console.log('Or install Calibre and put ebook-convert on PATH. MOBI (unencrypted) can use the built-in unpacker without Calibre.')
  process.exit(1)
}

if (process.platform !== 'linux' || os.arch() !== 'x64') {
  console.error('--install currently fetches the official Linux x86_64 tarball. Install Calibre manually otherwise.')
  process.exit(1)
}

const versionUrls = [
  'https://code.calibre-ebook.com/latest',
  'https://calibre-ebook.com/latest_version',
]
let version = '8.15.0'
for (const u of versionUrls) {
  try {
    const tmp = path.join(os.tmpdir(), 'mf-calibre-ver.txt')
    await download(u, tmp)
    const v = fs.readFileSync(tmp, 'utf8').trim()
    if (/^\d+\.\d+/.test(v)) {
      version = v.split(/\s+/)[0]
      break
    }
  } catch (e) {
    console.log('version probe failed', u, e.message || e)
  }
}
console.log('Calibre version', version)
const url = `https://download.calibre-ebook.com/${version}/calibre-${version}-x86_64.txz`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-calibre-'))
const txz = path.join(tmp, 'calibre.txz')
console.log('GET', url)
try {
  await download(url, txz)
} catch (e) {
  console.error('download failed:', e.message || e)
  process.exit(1)
}
const destDir = path.join(root, 'resources', 'calibre')
fs.mkdirSync(destDir, { recursive: true })
const extract = spawnSync('tar', ['-xJf', txz, '-C', destDir, '--strip-components=1'], { encoding: 'utf8' })
if (extract.status !== 0) {
  // 有的 tarball 顶层就是 calibre/ 目录，去掉 --strip 再试一次
  const extract2 = spawnSync('tar', ['-xJf', txz, '-C', destDir], { encoding: 'utf8' })
  if (extract2.status !== 0) {
    console.error('tar extract failed', extract.stderr || extract2.stderr)
    process.exit(1)
  }
}
function walk(dir, depth = 0) {
  if (depth > 5) return null
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    let st
    try { st = fs.statSync(full) } catch { continue }
    if (st.isDirectory()) {
      const hit = walk(full, depth + 1)
      if (hit) return hit
    } else if (name === 'ebook-convert' && st.isFile()) {
      return full
    }
  }
  return null
}
const bin = walk(destDir)
if (!bin) {
  console.error('ebook-convert not found after extract')
  process.exit(1)
}
const link = path.join(root, 'resources', 'bin', 'ebook-convert')
fs.mkdirSync(path.dirname(link), { recursive: true })
try {
  fs.symlinkSync(bin, link)
} catch {
  fs.copyFileSync(bin, link)
  try { fs.chmodSync(link, 0o755) } catch {}
}
console.log('OK installed', bin)
const ver = spawnSync(bin, ['--version'], { encoding: 'utf8' })
console.log((ver.stdout || ver.stderr || '').split('\n')[0])
