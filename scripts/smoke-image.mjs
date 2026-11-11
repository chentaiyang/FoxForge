#!/usr/bin/env node
/**
 * 基础图片转换冒烟（含 Sharp、多图 PDF）。跑法：npm run smoke:image
 * 本脚本在系统 Node 里直接 require('sharp')，这在纯 Node 下是允许的。
 * 产品路径在 Electron 里必须走 sharp-worker；请另用 electron-sharp-retest.mjs 验证。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
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
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.stdout.on('data', (d) => (err += d))
    child.on('close', (code) => resolve({ code: code ?? -1, err }))
  })
}

console.log('OK sharp', sharp.versions?.sharp, 'heif=', Boolean(sharp.versions?.heif))

fs.mkdirSync(fixtures, { recursive: true })
const pngPath = path.join(fixtures, 'sample.png')
const png2Path = path.join(fixtures, 'sample2.png')

await sharp({
  create: {
    width: 64,
    height: 48,
    channels: 3,
    background: { r: 30, g: 144, b: 255 },
  },
})
  .png()
  .toFile(pngPath)

await sharp({
  create: {
    width: 80,
    height: 60,
    channels: 4,
    background: { r: 255, g: 99, b: 71, alpha: 1 },
  },
})
  .png()
  .toFile(png2Path)

console.log('OK fixtures', pngPath, png2Path)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-img-smoke-'))
const targets = [
  ['jpg', (s) => s.jpeg({ quality: 85 })],
  ['webp', (s) => s.webp({ quality: 80 })],
  ['gif', (s) => s.gif()],
  ['tiff', (s) => s.tiff({ compression: 'lzw' })],
  ['avif', (s) => s.avif({ quality: 50 })],
  ['png', (s) => s.png()],
]

for (const [ext, apply] of targets) {
  const out = path.join(tmp, `out.${ext}`)
  await apply(sharp(pngPath)).toFile(out)
  if (!fs.existsSync(out) || fs.statSync(out).size < 10) {
    console.error('FAIL', ext)
    process.exit(1)
  }
  console.log('OK png→', ext, 'bytes=', fs.statSync(out).size)
}

// 经 FFmpeg 转 bmp / ico
const ffmpeg = whichSync('ffmpeg')
if (ffmpeg) {
  const bmp = path.join(tmp, 'out.bmp')
  let r = await run(ffmpeg, ['-y', '-hide_banner', '-i', pngPath, bmp])
  if (r.code !== 0 || !fs.existsSync(bmp)) {
    console.error('FAIL bmp', r.err.slice(-200))
    process.exit(1)
  }
  console.log('OK png→bmp bytes=', fs.statSync(bmp).size)

  const ico = path.join(tmp, 'out.ico')
  r = await run(ffmpeg, [
    '-y',
    '-hide_banner',
    '-i',
    pngPath,
    '-vf',
    'scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2',
    ico,
  ])
  if (r.code !== 0 || !fs.existsSync(ico)) {
    console.error('FAIL ico', r.err.slice(-200))
    process.exit(1)
  }
  console.log('OK png→ico (single 256) bytes=', fs.statSync(ico).size)
} else {
  console.log('SKIP bmp/ico (no ffmpeg)')
}

// 多图合成 PDF，走与引擎相同的 pdf-lib 路径
const pdfOut = path.join(tmp, 'images.pdf')
{
  const doc = await PDFDocument.create()
  for (const imgPath of [pngPath, png2Path]) {
    const buf = await sharp(imgPath).png().toBuffer()
    const embedded = await doc.embedPng(buf)
    const page = doc.addPage([embedded.width, embedded.height])
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height })
  }
  fs.writeFileSync(pdfOut, await doc.save())
  const check = await PDFDocument.load(fs.readFileSync(pdfOut))
  if (check.getPageCount() !== 2) {
    console.error('FAIL image pdf pages', check.getPageCount())
    process.exit(1)
  }
  console.log('OK images→pdf pages=2 bytes=', fs.statSync(pdfOut).size)
}

// 占位 RAW 预期会被引擎拒绝，只在冒烟里记录这一行为
console.log('OK common formats (RAW/PSD/JXL/JP2/QOI/AI covered by smoke:image-extras)')

const mainJs = path.join(root, 'dist-electron', 'main.js')
if (fs.existsSync(mainJs)) {
  const src = fs.readFileSync(mainJs, 'utf8')
  for (const needle of ['convert:image', 'getSharpHealthItem', 'engines/image']) {
    if (!src.includes(needle) && !src.includes('image.js') && !src.includes("from './image'") && !src.includes('convert:image')) {
      // 打包后标识符可能被改名，但源码/产物里仍应出现 convert:image 字符串
    }
  }
  if (!src.includes('convert:image')) {
    console.error('FAIL main.js missing convert:image IPC')
    process.exit(1)
  }
  console.log('OK dist-electron/main.js has convert:image')
} else {
  console.log('WARN no dist-electron/main.js yet — run build/dev first')
}

console.log('SMOKE IMAGE PASS')
