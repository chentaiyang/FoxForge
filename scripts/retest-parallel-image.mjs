#!/usr/bin/env node
/**
 * 在纯 Node 下并行/串行回归图片转换（经 load-engine 加载 image.ts）。
 * 此时不在 Electron 里，shouldIsolateSharp() 为 false，可以进程内 Sharp。
 * 隔离路径请再用 electron-sharp-retest.mjs 在真正的 Electron 进程里验证。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngine } from './load-engine.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = path.join(root, 'test-fixtures')
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-retest-'))

const { convertImage } = await loadEngine(path.join(root, 'electron/engines/image.ts'))

function onProgress(jobId, events) {
  return (ev) => {
    events.push({ ...ev })
    const est = ev.estimatedBytes != null ? ` est=${ev.estimatedBytes}` : ''
    console.log(`[${jobId}] ${ev.percent}% ${ev.message || ''}${est}`)
  }
}

async function one(name, input, target, jobId) {
  const events = []
  const outputPath = path.join(outDir, name)
  const started = Date.now()
  const result = await convertImage({ inputPath: input, target, outputPath }, jobId, onProgress(jobId, events))
  const ms = Date.now() - started
  const exists = result.outputPath && fs.existsSync(result.outputPath)
  const size = exists ? fs.statSync(result.outputPath).size : 0
  const hasEstimate = events.some((e) => e.estimatedBytes && e.estimatedBytes > 0)
  const spaceLeft = fs.existsSync(outputPath + '.part.space') || fs.existsSync((result.outputPath || outputPath) + '.space')
  console.log('RESULT', { jobId, ok: result.ok, error: result.error, errorCode: result.errorCode, output: result.outputPath, size, ms, hasEstimate, spaceLeft, engine: result.engineUsed })
  if (!result.ok) throw new Error(`${jobId} failed: ${result.errorCode} ${result.error}`)
  if (!exists || size <= 0) throw new Error(`${jobId} missing output`)
  if (!hasEstimate) throw new Error(`${jobId} did not emit estimatedBytes`)
  if (spaceLeft) throw new Error(`${jobId} left a sidecar space file`)
  return { result, events, size, ms }
}

const png = path.join(fixtures, 'sample.png')
const png2 = path.join(fixtures, 'sample2.png')
if (!fs.existsSync(png) || !fs.existsSync(png2)) {
  throw new Error('missing png fixtures')
}

console.log('--- sequential PNG→JPG (sidecar crash regression) ---')
await one('seq-1.jpg', png, 'jpg', 'job-seq-1')

console.log('--- parallel two PNG→JPG ---')
const t0 = Date.now()
const [a, b] = await Promise.all([
  one('par-a.jpg', png, 'jpg', 'job-par-a'),
  one('par-b.jpg', png2, 'jpg', 'job-par-b'),
])
console.log('parallel wall ms', Date.now() - t0, 'individual', a.ms, b.ms)

console.log('--- PNG→WEBP ---')
await one('seq-2.webp', png, 'webp', 'job-seq-2')

console.log('ALL IMAGE RETESTS OK', outDir)
