#!/usr/bin/env node
/**
 * 电子书引擎冒烟（Pandoc，以及可选的 LibreOffice / 内置 MOBI 拆包）。
 * 跑法：npm run smoke:ebook
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEngine } from './load-engine.mjs'

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
      } catch {}
    }
  }
  const local = path.join(root, 'resources', 'bin', process.platform === 'win32' ? `${cmd}.exe` : cmd)
  if (fs.existsSync(local)) return local
  return null
}

function run(bin, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true })
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, out: out + '\n[timeout]' })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
  })
}

function fileUrl(p) {
  const resolved = path.resolve(p)
  if (process.platform === 'win32') return `file:///${resolved.replace(/\\/g, '/')}`
  return `file://${resolved}`
}

const pandoc = whichSync('pandoc')
if (!pandoc) {
  console.error('FAIL: pandoc not found (try: node scripts/ensure-pandoc.mjs --install)')
  process.exit(1)
}
console.log('OK pandoc:', pandoc)
const ver = spawnSync(pandoc, ['--version'], { encoding: 'utf8' })
console.log((ver.stdout || '').split('\n')[0])

const fixtures = path.join(root, 'test-fixtures')
fs.mkdirSync(fixtures, { recursive: true })
const md = path.join(fixtures, 'ebook-hello.md')
const txt = path.join(fixtures, 'ebook-hello.txt')
fs.writeFileSync(md, '# MediaForge Ebook\n\nHello **Pandoc** smoke test.\n\n- item one\n- item two\n')
fs.writeFileSync(txt, 'MediaForge plain text ebook smoke.\nLine two.\n')

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ebook-smoke-'))

// md → epub
const epub = path.join(outDir, 'hello.epub')
let r = await run(pandoc, [md, '-f', 'markdown', '-t', 'epub', '-o', epub, '--standalone'])
if (r.code !== 0 || !fs.existsSync(epub) || fs.statSync(epub).size < 100) {
  console.error('FAIL md→epub', r.code, r.out.slice(-400))
  process.exit(1)
}
console.log('OK md→epub bytes=', fs.statSync(epub).size)

// epub → html
const html = path.join(outDir, 'hello.html')
r = await run(pandoc, [epub, '-f', 'epub', '-t', 'html', '-o', html, '--standalone'])
if (r.code !== 0 || !fs.existsSync(html)) {
  console.error('FAIL epub→html', r.code, r.out.slice(-400))
  process.exit(1)
}
console.log('OK epub→html bytes=', fs.statSync(html).size)

// txt → md
const md2 = path.join(outDir, 'from-txt.md')
r = await run(pandoc, [txt, '-f', 'markdown', '-t', 'markdown', '-o', md2])
if (r.code !== 0 || !fs.existsSync(md2)) {
  console.error('FAIL txt→md', r.code, r.out.slice(-400))
  process.exit(1)
}
console.log('OK txt→md bytes=', fs.statSync(md2).size)

// epub → txt
const txt2 = path.join(outDir, 'from-epub.txt')
r = await run(pandoc, [epub, '-f', 'epub', '-t', 'plain', '-o', txt2])
if (r.code !== 0 || !fs.existsSync(txt2)) {
  console.error('FAIL epub→txt', r.code, r.out.slice(-400))
  process.exit(1)
}
console.log('OK epub→txt bytes=', fs.statSync(txt2).size)

// html → epub
const epub2 = path.join(outDir, 'from-html.epub')
r = await run(pandoc, [html, '-f', 'html', '-t', 'epub', '-o', epub2, '--standalone'])
if (r.code !== 0 || !fs.existsSync(epub2)) {
  console.error('FAIL html→epub', r.code, r.out.slice(-400))
  process.exit(1)
}
console.log('OK html→epub bytes=', fs.statSync(epub2).size)

// 有 LibreOffice 时：html→pdf，以及 epub 经 html 中转到 pdf
const soffice = whichSync('soffice') || whichSync('libreoffice')
if (soffice) {
  console.log('OK soffice:', soffice)
  const loOut = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ebook-lo-'))
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ebook-lo-prof-'))
  const pdfFromHtml = path.join(loOut, 'hello.pdf')
  const loArgs = [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nodefault',
    '--nofirststartwizard',
    `-env:UserInstallation=${fileUrl(profile)}`,
    '--convert-to',
    'pdf',
    '--outdir',
    loOut,
    html,
  ]
  const lo = await run(soffice, loArgs, 120000)
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {}
  const produced = fs.existsSync(pdfFromHtml)
    ? pdfFromHtml
    : fs.readdirSync(loOut).filter((f) => f.endsWith('.pdf')).map((f) => path.join(loOut, f))[0]
  if (lo.code !== 0 || !produced || !fs.existsSync(produced)) {
    console.error('FAIL html→pdf via LO', lo.code, lo.out.slice(-400))
    process.exit(1)
  }
  console.log('OK html→pdf (LibreOffice) bytes=', fs.statSync(produced).size)

  // epub → html 中转已经覆盖；再试 Pandoc 直接 epub→docx
  const docx = path.join(outDir, 'hello.docx')
  r = await run(pandoc, [epub, '-f', 'epub', '-t', 'docx', '-o', docx])
  if (r.code !== 0 || !fs.existsSync(docx)) {
    console.error('FAIL epub→docx', r.code, r.out.slice(-400))
    process.exit(1)
  }
  console.log('OK epub→docx bytes=', fs.statSync(docx).size)
} else {
  console.log('SKIP LibreOffice complementary (soffice not found)')
}


// JSON / XML / YAML 经 Markdown 中转 + Pandoc；MOBI 走内置拆包
const { writeMinimalMobi, unpackMobiToHtml } = await loadEngine(path.join(root, 'electron/engines/mobi.ts'))
const { convertEbook } = await loadEngine(path.join(root, 'electron/engines/ebook.ts'))

function pathToFileURLSafe(p) {
  return 'file://' + path.resolve(p)
}

const jsonF = path.join(fixtures, 'ebook-hello.json')
const xmlF = path.join(fixtures, 'ebook-hello.xml')
const yamlF = path.join(fixtures, 'ebook-hello.yaml')
const mobiF = path.join(fixtures, 'ebook-hello.mobi')
fs.writeFileSync(jsonF, JSON.stringify({ name: 'MediaForge', items: [1, 2, 3], ok: true, note: '你好' }, null, 2))
fs.writeFileSync(xmlF, '<root><item id="1">Hello</item><item id="2">世界</item></root>\n')
fs.writeFileSync(yamlF, 'name: MediaForge\nitems:\n  - one\n  - two\nflag: true\n')
writeMinimalMobi(
  '<html><head><meta charset="utf-8"></head><body><h1>MediaForge MOBI</h1><p>Hello 电子书</p></body></html>',
  mobiF,
)
console.log('OK wrote data/mobi fixtures')

async function ebookConv(inputPath, target) {
  const outputPath = path.join(outDir, path.basename(inputPath, path.extname(inputPath)) + '.' + target)
  const r = await convertEbook({ inputPath, target, outputPath }, `smoke-ebook-${target}`, (ev) => {
    if (ev.message) console.log('  ', ev.message)
  })
  if (!r.ok || !r.outputPath || !fs.existsSync(r.outputPath) || fs.statSync(r.outputPath).size < 8) {
    throw new Error(`FAIL ${path.basename(inputPath)}→${target}: ${r.error || 'empty'}`)
  }
  console.log(`OK ${path.basename(inputPath)}→${target} bytes=`, fs.statSync(r.outputPath).size, r.engineUsed || '')
  return r.outputPath
}

try {
  const jsonMd = await ebookConv(jsonF, 'md')
  if (!fs.readFileSync(jsonMd, 'utf8').includes('MediaForge')) throw new Error('JSON md missing content')
  await ebookConv(jsonF, 'html')
  await ebookConv(xmlF, 'md')
  await ebookConv(yamlF, 'html')
  const mobiHtml = path.join(outDir, 'unpacked-mobi.html')
  unpackMobiToHtml(mobiF, mobiHtml)
  const ht = fs.readFileSync(mobiHtml, 'utf8')
  if (!ht.includes('MediaForge') && !ht.includes('电子书')) throw new Error('MOBI unpack missing text')
  console.log('OK mobi unpack bytes=', fs.statSync(mobiHtml).size)
  await ebookConv(mobiF, 'html')
  await ebookConv(mobiF, 'md')
} catch (err) {
  console.error(String(err))
  process.exit(1)
}

const mainJs = path.join(root, 'dist-electron', 'main.js')
if (fs.existsSync(mainJs)) {
  const src = fs.readFileSync(mainJs, 'utf8')
  for (const needle of ['convert:ebook', 'Pandoc', 'getPandocHealthItem']) {
    if (!src.includes(needle) && needle !== 'getPandocHealthItem') {
      // getPandocHealthItem 打包后可能被改名；有 convert:ebook 和 Pandoc 即可
      if (needle === 'convert:ebook' || needle === 'Pandoc') {
        console.error('FAIL: main.js missing', needle)
        process.exit(1)
      }
    }
  }
  if (!src.includes('convert:ebook')) {
    console.error('FAIL: main.js missing convert:ebook')
    process.exit(1)
  }
  if (!src.includes('Pandoc')) {
    console.error('FAIL: main.js missing Pandoc string')
    process.exit(1)
  }
  console.log('OK dist-electron/main.js has ebook IPC strings')
} else {
  console.log('SKIP main.js check (not built yet)')
}

console.log('PASS smoke-ebook')
process.exit(0)
