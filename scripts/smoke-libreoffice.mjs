#!/usr/bin/env node
/**
 * LibreOffice 文档转换冒烟。跑法：npm run smoke:libreoffice
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function whichSync(cmd) {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    for (const name of [cmd, `${cmd}.exe`]) {
      const full = path.join(dir, name)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* 忽略 */
      }
    }
  }
  return null
}

function fileUrl(p) {
  const resolved = path.resolve(p)
  if (process.platform === 'win32') return `file:///${resolved.replace(/\\/g, '/')}`
  return `file://${resolved}`
}

function convert(soffice, input, filter, outDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lo-prof-'))
  const args = [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=${fileUrl(profile)}`,
    '--convert-to',
    filter,
    '--outdir',
    outDir,
    input,
  ]
  return new Promise((resolve) => {
    const child = spawn(soffice, args, { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.stdout.on('data', (d) => {
      err += d.toString()
    })
    child.on('close', (code) => {
      try {
        fs.rmSync(profile, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
      resolve({ code, err })
    })
  })
}

const soffice = whichSync('soffice') || whichSync('libreoffice')
if (!soffice) {
  console.error('FAIL: soffice/libreoffice not found (try: node scripts/ensure-libreoffice.mjs)')
  process.exit(1)
}
console.log('OK soffice:', soffice)

const inputOdt = path.join(root, 'test-fixtures', 'mf-hello.odt')
const inputDocx = path.join(root, 'test-fixtures', 'mf-hello.docx')
for (const p of [inputOdt, inputDocx]) {
  if (!fs.existsSync(p)) {
    console.error('FAIL: missing fixture', p)
    process.exit(1)
  }
}

const out1 = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lo-smoke-'))
const r1 = await convert(soffice, inputOdt, 'pdf', out1)
const pdf1 = path.join(out1, 'mf-hello.pdf')
if (r1.code !== 0 || !fs.existsSync(pdf1)) {
  console.error('FAIL odt→pdf', r1.code, r1.err.slice(-400))
  process.exit(1)
}
console.log('OK odt→pdf bytes=', fs.statSync(pdf1).size)

const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lo-smoke-'))
const r2 = await convert(soffice, inputDocx, 'pdf', out2)
const pdf2 = path.join(out2, 'mf-hello.pdf')
if (r2.code !== 0 || !fs.existsSync(pdf2)) {
  console.error('FAIL docx→pdf', r2.code, r2.err.slice(-400))
  process.exit(1)
}
console.log('OK docx→pdf bytes=', fs.statSync(pdf2).size)


for (const [name, target] of [
  ['sample.et', 'xlsx'],
  ['sample.ett', 'pdf'],
  ['sample.dps', 'pdf'],
  ['sample.dpt', 'pdf'],
]) {
  const input = path.join(root, 'test-fixtures', name)
  if (!fs.existsSync(input)) {
    console.error('FAIL: missing fixture', input)
    process.exit(1)
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-lo-wps-'))
  const r = await convert(soffice, input, target, out)
  const produced = fs.readdirSync(out).find((f) => f.toLowerCase().endsWith('.' + target))
  const full = produced ? path.join(out, produced) : null
  if (r.code !== 0 || !full || !fs.existsSync(full) || fs.statSync(full).size < 64) {
    console.error(`FAIL ${name}→${target}`, r.code, (r.err || '').slice(-400))
    process.exit(1)
  }
  console.log(`OK ${name}→${target} bytes=`, fs.statSync(full).size)
}

const mainJs = path.join(root, 'dist-electron', 'main.js')
if (fs.existsSync(mainJs)) {
  const src = fs.readFileSync(mainJs, 'utf8')
  for (const needle of ['convert:document', 'LibreOffice', 'convert-to']) {
    if (!src.includes(needle)) {
      console.error('FAIL: main.js missing', needle)
      process.exit(1)
    }
  }
  console.log('OK dist-electron/main.js has document IPC strings')
} else {
  console.log('SKIP main.js check (not built yet)')
}

console.log('PASS smoke-libreoffice')
process.exit(0)
