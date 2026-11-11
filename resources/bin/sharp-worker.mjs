#!/usr/bin/env node
/**
 * 在「真正的系统 Node.js」里运行 Sharp / libvips 的工作进程。
 *
 * Electron 进程加载 libvips 会中止（VObject 赋值等），所以主进程绝不能在
 * 自身里做真实 vips 操作，也不能用 process.execPath 或 ELECTRON_RUN_AS_NODE
 * 把 Electron 伪装成 Node。主进程应通过 resolveSystemNode() 找到系统 Node，
 * 再用 envForSystemNode() 清掉 Electron 的库路径后 spawn 本脚本。
 *
 * 请求 JSON 从 stdin 读入，一条 JSON 结果写到 stdout。
 * 纯 Node 冒烟可以进程内加载 Sharp；只要 process.versions.electron 存在，就必须走这里。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

function loadSharp() {
  const roots = [process.cwd(), path.dirname(process.cwd())]
  let lastErr
  for (const root of roots) {
    try {
      const require = createRequire(path.join(root, 'package.json'))
      return require('sharp')
    } catch (err) {
      lastErr = err
    }
  }
  try {
    return createRequire(import.meta.url)('sharp')
  } catch (err) {
    throw lastErr || err
  }
}

const sharp = loadSharp()
try {
  sharp.cache({ memory: 0, files: 0, items: 0 })
  sharp.concurrency(1)
} catch {
  /* 忽略 */
}

const req = JSON.parse(fs.readFileSync(0, 'utf8'))

function pipelineFrom(req) {
  if (req.raw && req.rawPath) {
    const buf = fs.readFileSync(req.rawPath)
    return sharp(buf, {
      raw: { width: req.width, height: req.height, channels: req.channels || 4 },
    })
  }
  const opts = { failOn: req.failOn || 'none', animated: Boolean(req.animated) }
  return sharp(req.inputPath, opts)
}

async function applyEncode(pipeline, target, quality) {
  const t = target === 'jpeg' ? 'jpg' : target
  const q = Math.min(100, Math.max(1, quality ?? 85))
  switch (t) {
    case 'jpg':
      return pipeline.jpeg({ quality: q, mozjpeg: true })
    case 'png':
      return pipeline.png({ compressionLevel: 8 })
    case 'webp':
      return pipeline.webp({ quality: q })
    case 'avif':
      return pipeline.avif({ quality: q })
    case 'gif':
      return pipeline.gif()
    case 'tiff':
    case 'tif':
      return pipeline.tiff({ compression: 'lzw', quality: q })
    default:
      throw new Error(`Sharp 不支持输出：${t}`)
  }
}

async function handle(req) {
  const op = req.op
  if (op === 'versions') {
    return { versions: sharp.versions || {} }
  }
  if (op === 'metadata') {
    const meta = await pipelineFrom(req).metadata()
    return {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      hasAlpha: meta.hasAlpha === true,
    }
  }
  if (op === 'stats') {
    const stats = await pipelineFrom(req).stats()
    return {
      channels: (stats.channels || []).map((c) => ({ mean: c.mean, stdev: c.stdev })),
    }
  }
  if (op === 'convert' || op === 'toFile' || op === 'rawToFile') {
    if (!req.outputPath) throw new Error('缺少 outputPath')
    let pipeline = pipelineFrom(req)
    if (req.rotate !== false) pipeline = pipeline.rotate()
    pipeline = await applyEncode(pipeline, req.target || 'png', req.quality)
    await pipeline.toFile(req.outputPath)
    const size = fs.existsSync(req.outputPath) ? fs.statSync(req.outputPath).size : 0
    if (size <= 0) throw new Error('Sharp 未写出有效文件')
    return { outputPath: req.outputPath, size }
  }
  if (op === 'toBuffer') {
    let pipeline = pipelineFrom(req)
    if (req.rotate !== false) pipeline = pipeline.rotate()
    pipeline = await applyEncode(pipeline, req.target || 'png', req.quality)
    const buffer = await pipeline.toBuffer()
    return { base64: buffer.toString('base64'), bytes: buffer.length }
  }
  throw new Error(`未知 Sharp 任务：${op}`)
}

try {
  const result = await handle(req)
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }))
  process.exitCode = 1
}
