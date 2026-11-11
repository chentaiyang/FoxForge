#!/usr/bin/env node
/**
 * Tesseract OCR 冒烟（图片、PDF，以及可选的 docx）。跑法：npm run smoke:ocr
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
const fixtures = path.join(root, 'test-fixtures')

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
  return null
}

function run(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })
}

const tesseract = whichSync('tesseract')
const pdftoppm = whichSync('pdftoppm')
if (!tesseract) {
  console.error('FAIL: tesseract not found')
  process.exit(1)
}
console.log('OK tesseract:', tesseract)

const langsR = await run(tesseract, ['--list-langs'])
const langs = (langsR.out + '\n' + langsR.err)
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !/list of available|available languages/i.test(l))
console.log('langs:', langs.join(', '))
const haveChi = langs.includes('chi_sim')
const haveEng = langs.includes('eng')
if (!haveChi && !haveEng) {
  console.error('FAIL: need chi_sim and/or eng language packs')
  process.exit(1)
}
const lang = haveChi && haveEng ? 'chi_sim+eng' : haveChi ? 'chi_sim' : 'eng'
console.log('using -l', lang)

let png = path.join(fixtures, 'ocr-hello.png')
if (!fs.existsSync(png)) {
  console.error('FAIL missing fixture', png, '(generate with PIL or smoke will fail)')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ocr-smoke-'))
const outBase = path.join(tmp, 'hello')

// 图片识别到 stdout 文本
let r = await run(tesseract, [png, 'stdout', '-l', lang, '--psm', '3'])
if (r.code !== 0) {
  console.error('FAIL image OCR', r.code, (r.err || r.out).slice(-400))
  process.exit(1)
}
const text = r.out || ''
console.log('OCR text sample:', JSON.stringify(text.trim().slice(0, 120)))
if (!/MediaForge|Tesseract|Hello|OCR|12345/i.test(text)) {
  console.error('FAIL: OCR text did not contain expected tokens')
  process.exit(1)
}
fs.writeFileSync(outBase + '.txt', text, 'utf8')
console.log('OK image→txt')

// 包成 Markdown
fs.writeFileSync(outBase + '.md', `# OCR Result\n\n${text.trim()}\n`, 'utf8')
console.log('OK image→md wrap')

// PDF 路径：优先用夹具 PDF，没有就把 png 嵌进去
let pdf = path.join(fixtures, 'ocr-hello.pdf')
if (!fs.existsSync(pdf)) {
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(fs.readFileSync(png))
  const page = doc.addPage([img.width, img.height])
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
  fs.writeFileSync(pdf, await doc.save())
  console.log('created', pdf)
}

if (!pdftoppm) {
  console.error('FAIL: pdftoppm required for PDF OCR smoke')
  process.exit(1)
}
const prefix = path.join(tmp, 'page')
r = await run(pdftoppm, ['-png', '-r', '150', pdf, prefix])
const pagePng = fs
  .readdirSync(tmp)
  .filter((f) => f.startsWith('page') && f.endsWith('.png'))
  .sort()
  .map((f) => path.join(tmp, f))
if (r.code !== 0 || !pagePng.length) {
  console.error('FAIL pdftoppm', r.code, (r.err || r.out).slice(-300))
  process.exit(1)
}
r = await run(tesseract, [pagePng[0], 'stdout', '-l', lang, '--psm', '3'])
if (r.code !== 0 || !/MediaForge|Tesseract|Hello|OCR|12345/i.test(r.out || '')) {
  console.error('FAIL pdf OCR', r.code, JSON.stringify((r.out || '').trim().slice(0, 120)))
  process.exit(1)
}
console.log('OK pdf→pdftoppm→OCR')

// 若有 soffice，再试输出 docx
const soffice = whichSync('soffice') || whichSync('libreoffice')
if (soffice) {
  const txt = outBase + '.txt'
  r = await run(soffice, [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--convert-to',
    'docx',
    '--outdir',
    tmp,
    txt,
  ])
  const docx = path.join(tmp, 'hello.docx')
  if (r.code === 0 && fs.existsSync(docx)) {
    console.log('OK txt→docx via LibreOffice')
  } else {
    console.log('WARN docx via LO failed (non-fatal for OCR core)', r.code)
  }
} else {
  console.log('SKIP docx (no LibreOffice)')
}

console.log('SMOKE OCR OK', tmp)
process.exit(0)
