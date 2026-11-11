#!/usr/bin/env node
/**
 * RAW / PSD / AI / JPEG 2000 / JPEG XL / QOI 等附加格式的真实转换冒烟。
 * 经 load-engine 加载图片引擎。跑法：npm run smoke:image-extras
 *
 * 不要用截断的 exiftool CR3 当夹具；经典 dcraw 也解不好 CR3。
 * 这是纯 Node 冒烟，不能替代在真正 Electron 进程里验证 Sharp 隔离。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadEngine } from './load-engine.mjs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const fixtures = path.join(root, 'test-fixtures')
fs.mkdirSync(fixtures, { recursive: true })

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const extras = [path.join(root, 'resources', 'bin')]
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

function run(bin, args, timeoutMs = 120000) {
  const r = spawnSync(bin, args, { encoding: 'buffer', timeout: timeoutMs })
  return { code: r.status ?? -1, out: Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]) }
}

const { convertImage } = await loadEngine(path.join(root, 'electron/engines/image.ts'))

function onProg(ev) {
  if (ev.message) console.log(`  [${ev.percent.toFixed(0)}%] ${ev.message}`)
}

async function mustConvert(inputPath, target, outDir) {
  const outputPath = path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.${target}`)
  const r = await convertImage({ inputPath, target, outputPath }, `smoke-${target}-${Date.now()}`, onProg)
  if (!r.ok || !r.outputPath || !fs.existsSync(r.outputPath) || fs.statSync(r.outputPath).size < 16) {
    throw new Error(`FAIL ${path.basename(inputPath)}→${target}: ${r.error || 'empty output'}`)
  }
  // 尝试用 Sharp 或 FFmpeg 打开，确认夹具可读
  const ext = path.extname(r.outputPath).slice(1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'tiff', 'tif', 'gif', 'avif'].includes(ext)) {
    const meta = await sharp(r.outputPath).metadata()
    if (!meta.width || !meta.height) throw new Error(`FAIL ${ext} unreadable by sharp`)
    console.log(`OK ${path.basename(inputPath)}→${target} bytes=${fs.statSync(r.outputPath).size} ${meta.width}x${meta.height}`)
  } else {
    const ffmpeg = which('ffmpeg')
    if (ffmpeg && ['jp2', 'j2k', 'jxl', 'qoi', 'png'].includes(ext)) {
      const probe = path.join(outDir, `probe-${path.basename(r.outputPath)}.png`)
      const chk = run(ffmpeg, ['-y', '-hide_banner', '-i', r.outputPath, '-frames:v', '1', '-update', '1', probe])
      if (chk.code !== 0 || !fs.existsSync(probe) || fs.statSync(probe).size < 16) {
        throw new Error(`FAIL ${target} not decodable: ${chk.out.toString().slice(-200)}`)
      }
      console.log(`OK ${path.basename(inputPath)}→${target} bytes=${fs.statSync(r.outputPath).size} (ffmpeg opened)`)
    } else {
      console.log(`OK ${path.basename(inputPath)}→${target} bytes=${fs.statSync(r.outputPath).size}`)
    }
  }
  return r.outputPath
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-img-extras-'))
const png = path.join(fixtures, 'sample.png')
if (!fs.existsSync(png)) {
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 144, b: 255 } } })
    .png()
    .toFile(png)
}

// 缺少附加格式夹具时用 FFmpeg 生成
const ffmpeg = which('ffmpeg')
if (!ffmpeg) {
  console.error('FAIL: ffmpeg required for JXL/JP2/QOI smoke')
  process.exit(1)
}

async function ensureEncoded(ext) {
  const dest = path.join(fixtures, `sample.${ext}`)
  const r = run(ffmpeg, ['-y', '-hide_banner', '-i', png, '-frames:v', '1', '-update', '1', dest])
  if (r.code !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 16) {
    throw new Error(`cannot create fixture .${ext}: ${r.out.toString().slice(-200)}`)
  }
  return dest
}

const jxl = await ensureEncoded('jxl')
const jp2 = await ensureEncoded('jp2')
const j2k = await ensureEncoded('j2k')
const qoi = await ensureEncoded('qoi')
console.log('OK fixtures', { jxl, jp2, j2k, qoi })

const psd = path.join(fixtures, 'sample.psd')
const ai = path.join(fixtures, 'sample.ai')
const dng = path.join(fixtures, 'sample.dng')

try {
  if (fs.existsSync(dng) && (which('dcraw') || which('dcraw_emu'))) {
    await mustConvert(dng, 'png', tmp)
    await mustConvert(dng, 'jpg', tmp)
  } else {
    console.error('FAIL: RAW fixture or dcraw missing (run: node scripts/ensure-image-extras.mjs --install)')
    process.exit(1)
  }
  if (!fs.existsSync(psd)) throw new Error('missing sample.psd')
  await mustConvert(psd, 'png', tmp)
  if (!fs.existsSync(ai)) throw new Error('missing sample.ai')
  await mustConvert(ai, 'png', tmp)
  await mustConvert(jxl, 'png', tmp)
  await mustConvert(jp2, 'png', tmp)
  await mustConvert(j2k, 'png', tmp)
  await mustConvert(qoi, 'png', tmp)
  // 从 png 编码出各目标格式
  await mustConvert(png, 'jxl', tmp)
  await mustConvert(png, 'jp2', tmp)
  await mustConvert(png, 'qoi', tmp)
} catch (err) {
  console.error(String(err))
  process.exit(1)
}

console.log('SMOKE IMAGE EXTRAS PASS', tmp)
