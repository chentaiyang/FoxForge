#!/usr/bin/env node
/**
 * 探测 tesseract 以及 chi_sim / eng 语言包。
 * --apt：尝试 apt 安装（源不可用时可能失败）。
 * --install-debs：从镜像拉取 deb 后在 Debian/Ubuntu amd64 上 dpkg -i。
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const wantApt = process.argv.includes('--apt')
const wantDebs = process.argv.includes('--install-debs')

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
  const local = path.join(root, 'resources', 'bin', process.platform === 'win32' ? `${cmd}.exe` : cmd)
  if (fs.existsSync(local)) return local
  return null
}

function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true })
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

async function probe() {
  const bin = whichSync('tesseract')
  if (!bin) {
    console.log('MISSING tesseract')
    return { ok: false, langs: [] }
  }
  const ver = await run(bin, ['--version'])
  console.log('OK tesseract:', bin)
  console.log((ver.out || '').split('\n')[0])
  const langsR = await run(bin, ['--list-langs'])
  const langs = (langsR.out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/list of available|available languages/i.test(l))
  console.log('langs:', langs.join(', ') || '(none)')
  const need = ['chi_sim', 'eng']
  const missing = need.filter((l) => !langs.includes(l))
  if (missing.length) {
    console.log('MISSING langs:', missing.join(', '))
    return { ok: false, langs }
  }
  console.log('OK language packs chi_sim + eng')
  return { ok: true, langs }
}

if (wantApt && process.platform === 'linux') {
  console.log('Trying apt install…')
  try {
    execSync(
      'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng',
      { stdio: 'inherit' },
    )
  } catch (e) {
    console.error('apt failed:', e.message || e)
  }
}

if (wantDebs && process.platform === 'linux') {
  console.log('Downloading Debian amd64 debs from USTC…')
  const base = 'https://mirrors.ustc.edu.cn/debian/pool/main'
  const tmp = fs.mkdtempSync('/tmp/mf-tess-')
  const files = [
    ['l/leptonlib/libleptonica6_1.84.1-4_amd64.deb', 'libleptonica6.deb'],
    ['liba/libarchive/libarchive13t64_3.7.4-4+deb13u1_amd64.deb', 'libarchive13t64.deb'],
    ['t/tesseract/libtesseract5_5.5.0-1+b1_amd64.deb', 'libtesseract5.deb'],
    ['t/tesseract/tesseract-ocr_5.5.0-1+b1_amd64.deb', 'tesseract-ocr.deb'],
    ['t/tesseract-lang/tesseract-ocr-eng_4.1.0-2_all.deb', 'eng.deb'],
    ['t/tesseract-lang/tesseract-ocr-osd_4.1.0-2_all.deb', 'osd.deb'],
    ['t/tesseract-lang/tesseract-ocr-chi-sim_4.1.0-2_all.deb', 'chi.deb'],
  ]
  try {
    for (const [rel, name] of files) {
      const dest = path.join(tmp, name)
      const url = `${base}/${rel}`
      console.log('GET', url)
      await download(url, dest)
    }
    const args = files.map(([, name]) => path.join(tmp, name))
    execSync(`sudo dpkg -i ${args.join(' ')}`, { stdio: 'inherit' })
  } catch (e) {
    console.error('install-debs failed:', e.message || e)
    console.error('You may need matching Debian trixie amd64. Try --apt when mirrors work.')
  }
}

const result = await probe()
if (!result.ok) {
  console.log(`
Install hints:
  Linux apt:  sudo apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
  Or:         node scripts/ensure-tesseract.mjs --apt
  Or (trixie): node scripts/ensure-tesseract.mjs --install-debs
  Windows:    install UB Mannheim Tesseract, add to PATH, install chi_sim+eng
  Portable:   put tesseract into resources/bin/
`)
  process.exit(1)
}
process.exit(0)
