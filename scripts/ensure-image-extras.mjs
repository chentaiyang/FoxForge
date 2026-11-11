#!/usr/bin/env node
/**
 * 探测或安装图片附加解码器（dcraw / LibRaw）并准备夹具目录。
 * --install：若缺少 dcraw 则用 gcc 编译到 resources/bin（不需要 g++）。
 *
 * 不要用截断的 exiftool CR3 当测试夹具，那种文件解码器会误判或解出全黑图。
 * 经典 dcraw 也解不好 CR3，验证新 RAW 请用 dcraw_emu / 完整样本。
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
const binDir = path.join(root, 'resources', 'bin')
const fixtures = path.join(root, 'test-fixtures')
const wantInstall = process.argv.includes('--install')

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of [binDir, ...(process.env.PATH || '').split(sep)]) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  return null
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects = 0) => {
      https
        .get(u, { rejectUnauthorized: false }, (res) => {
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

function compileDcraw() {
  fs.mkdirSync(binDir, { recursive: true })
  const dest = path.join(binDir, process.platform === 'win32' ? 'dcraw.exe' : 'dcraw')
  if (which('dcraw') || which('dcraw_emu')) {
    console.log('OK dcraw already present:', which('dcraw') || which('dcraw_emu'))
    return true
  }
  if (!wantInstall) {
    console.log('dcraw not found. Hint: node scripts/ensure-image-extras.mjs --install')
    return false
  }
  const gcc = which('gcc') || which('cc')
  if (!gcc) {
    console.error('No gcc/cc on PATH; cannot compile dcraw. Place a portable dcraw into resources/bin/')
    return false
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-dcraw-'))
  const src = path.join(tmp, 'dcraw.c')
  const urls = [
    'https://raw.githubusercontent.com/ncruces/dcraw/master/dcraw.c',
    'https://www.dechifro.org/dcraw/dcraw.c',
  ]
  return (async () => {
    let ok = false
    for (const url of urls) {
      try {
        console.log('GET', url)
        await download(url, src)
        ok = true
        break
      } catch (e) {
        console.log('download failed:', e.message || e)
      }
    }
    if (!ok) return false
    const out = spawnSync(gcc, ['-O2', '-o', dest, src, '-lm', '-DNO_JPEG', '-DNO_LCMS', '-DNO_JASPER'], {
      encoding: 'utf8',
    })
    if (out.status !== 0 || !fs.existsSync(dest)) {
      console.error('gcc failed', out.stderr || out.stdout)
      return false
    }
    try {
      fs.chmodSync(dest, 0o755)
    } catch {}
    console.log('OK compiled dcraw →', dest)
    return true
  })()
}

const compiled = compileDcraw()
if (compiled && typeof compiled.then === 'function') {
  const r = await compiled
  if (!r && wantInstall) process.exitCode = 1
} else if (!compiled && wantInstall) {
  process.exitCode = 1
}

const found = which('dcraw') || which('dcraw_emu')
if (found) {
  const ver = spawnSync(found, [], { encoding: 'utf8' })
  console.log((ver.stdout || ver.stderr || '').split('\n').slice(0, 2).join('\n'))
}

fs.mkdirSync(fixtures, { recursive: true })
console.log('fixtures dir', fixtures)
console.log('Tip: smoke with  node scripts/smoke-image-extras.mjs')
