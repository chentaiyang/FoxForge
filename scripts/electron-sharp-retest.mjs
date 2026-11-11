/**
 * 在真正的 Electron 进程里走 image.ts 的转换入口做回归。
 * 此时 shouldIsolateSharp() 为 true，必须经系统 Node + sharp-worker.mjs。
 * 仅用系统 Node 跑冒烟不能替代这次验证。
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  const { loadEngine } = await import(pathToFileURL(path.join(root, 'scripts/load-engine.mjs')).href)
  const { convertImage } = await loadEngine(path.join(root, 'electron/engines/image.ts'))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-e-sharp-'))
  const png = path.join(root, 'test-fixtures/sample.png')
  const png2 = path.join(root, 'test-fixtures/sample2.png')

  const run = async (name, input, jobId) => {
    const events = []
    const outputPath = path.join(outDir, name)
    const result = await convertImage({ inputPath: input, target: 'jpg', outputPath }, jobId, (ev) => events.push(ev))
    const exists = result.outputPath && fs.existsSync(result.outputPath) && fs.statSync(result.outputPath).size > 0
    const hasEstimate = events.some((e) => e.estimatedBytes && e.estimatedBytes > 0)
    console.log('RESULT', { jobId, ok: result.ok, error: result.error, size: exists ? fs.statSync(result.outputPath).size : 0, hasEstimate })
    if (!result.ok || !exists) throw new Error(`${jobId} failed: ${result.error || 'no output'}`)
    if (!hasEstimate) throw new Error(`${jobId} missing estimate`)
  }

  console.log('--- electron sequential ---')
  await run('seq.jpg', png, 'job-e-seq')
  console.log('--- electron two jobs back-to-back / parallel ---')
  await Promise.all([
    run('par-a.jpg', png, 'job-e-a'),
    run('par-b.jpg', png2, 'job-e-b'),
  ])
  console.log('ELECTRON SHARP RETEST OK', outDir)
  app.exit(0)
}

app.whenReady().then(() => main().catch((err) => {
  console.error(err)
  app.exit(1)
}))
