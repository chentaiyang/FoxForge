#!/usr/bin/env node
/**
 * PDF 引擎冒烟：转图/转文本、合并拆分、可选的 qpdf 加密解密。跑法：npm run smoke:pdf
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PDFDocument } = require('pdf-lib')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const toolkitQpdf = path.join(root, 'resources', 'bin', 'qpdf-toolkit', 'bin', 'qpdf')

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
  if (cmd === 'qpdf' && fs.existsSync(toolkitQpdf)) return toolkitQpdf
  return null
}

function run(bin, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.stdout.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code: code ?? -1, err }))
  })
}

function qpdfEnv(qpdfPath) {
  const env = { ...process.env }
  const libDir = path.join(path.dirname(qpdfPath), '..', 'lib')
  if (fs.existsSync(libDir)) {
    env.LD_LIBRARY_PATH = libDir + (env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : '')
  }
  return env
}

const pdftoppm = whichSync('pdftoppm')
const pdftotext = whichSync('pdftotext')
const qpdf = whichSync('qpdf')

if (!pdftoppm || !pdftotext) {
  console.error('FAIL: need pdftoppm + pdftotext')
  process.exit(1)
}
console.log('OK pdftoppm:', pdftoppm)
console.log('OK pdftotext:', pdftotext)
console.log('OK qpdf:', qpdf || '(missing — encrypt/decrypt will skip)')

const sample = path.join(root, 'test-fixtures', 'sample.pdf')
const sample2 = path.join(root, 'test-fixtures', 'sample2.pdf')
for (const f of [sample, sample2]) {
  if (!fs.existsSync(f)) {
    console.error('FAIL missing', f)
    process.exit(1)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-pdf-smoke-'))

// PDF → PNG
const pngPrefix = path.join(tmp, 'page')
let r = await run(pdftoppm, ['-png', '-r', '72', sample, pngPrefix])
const png = path.join(tmp, 'page-1.png')
if (r.code !== 0 || !fs.existsSync(png)) {
  console.error('FAIL pdftoppm', r.code, r.err.slice(-300))
  process.exit(1)
}
console.log('OK pdf→png bytes=', fs.statSync(png).size)

// PDF → TXT
const txt = path.join(tmp, 'sample.txt')
r = await run(pdftotext, ['-layout', sample, txt])
if (r.code !== 0 || !fs.existsSync(txt)) {
  console.error('FAIL pdftotext', r.code, r.err.slice(-300))
  process.exit(1)
}
const text = fs.readFileSync(txt, 'utf8')
if (!text.trim()) {
  console.error('FAIL txt empty')
  process.exit(1)
}
console.log('OK pdf→txt chars=', text.trim().length, 'preview=', JSON.stringify(text.trim().slice(0, 40)))

// 经 pdf-lib 合并
const mergedPath = path.join(tmp, 'merged.pdf')
{
  const merged = await PDFDocument.create()
  for (const p of [sample, sample2]) {
    const donor = await PDFDocument.load(fs.readFileSync(p))
    const pages = await merged.copyPages(donor, donor.getPageIndices())
    pages.forEach((pg) => merged.addPage(pg))
  }
  fs.writeFileSync(mergedPath, await merged.save())
  const check = await PDFDocument.load(fs.readFileSync(mergedPath))
  if (check.getPageCount() !== 2) {
    console.error('FAIL merge page count', check.getPageCount())
    process.exit(1)
  }
  console.log('OK pdf-lib merge pages=2')
}

// 拆分
{
  const src = await PDFDocument.load(fs.readFileSync(mergedPath))
  const outPage = path.join(tmp, 'split-001.pdf')
  const doc = await PDFDocument.create()
  const [pg] = await doc.copyPages(src, [0])
  doc.addPage(pg)
  fs.writeFileSync(outPage, await doc.save())
  console.log('OK pdf-lib split bytes=', fs.statSync(outPage).size)
}

// 经 qpdf 加密 / 解密
if (qpdf) {
  const enc = path.join(tmp, 'enc.pdf')
  const dec = path.join(tmp, 'dec.pdf')
  r = await run(qpdf, ['--encrypt', 'testpass', 'testpass', '256', '--', sample, enc], qpdfEnv(qpdf))
  if ((r.code !== 0 && r.code !== 3) || !fs.existsSync(enc)) {
    console.error('FAIL qpdf encrypt', r.code, r.err.slice(-400))
    process.exit(1)
  }
  console.log('OK qpdf encrypt code=', r.code)
  r = await run(qpdf, ['--password=testpass', '--decrypt', enc, dec], qpdfEnv(qpdf))
  if ((r.code !== 0 && r.code !== 3) || !fs.existsSync(dec)) {
    console.error('FAIL qpdf decrypt', r.code, r.err.slice(-400))
    process.exit(1)
  }
  console.log('OK qpdf decrypt')
} else {
  console.log('SKIP qpdf encrypt/decrypt')
}

const mainJs = path.join(root, 'dist-electron', 'main.js')
if (fs.existsSync(mainJs)) {
  const src = fs.readFileSync(mainJs, 'utf8')
  for (const needle of ['convert:pdf', 'pdftoppm', 'pdftotext', 'qpdf', 'ignoreEncryption']) {
    if (!src.includes(needle)) {
      console.error('FAIL: main.js missing', needle)
      process.exit(1)
    }
  }
  console.log('OK dist-electron/main.js PDF IPC strings')
} else {
  console.log('SKIP main.js check (not built yet)')
}

console.log('PASS smoke-pdf')
process.exit(0)
