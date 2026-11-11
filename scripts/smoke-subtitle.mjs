#!/usr/bin/env node
/**
 * 字幕格式互转冒烟。跑法：npm run smoke:subtitle
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngine } from './load-engine.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const fixtures = path.join(root, 'test-fixtures')
fs.mkdirSync(fixtures, { recursive: true })

const srt = path.join(fixtures, 'sample.srt')
fs.writeFileSync(
  srt,
  `1
00:00:00,000 --> 00:00:01,500
Hello MediaForge

2
00:00:01,500 --> 00:00:03,000
你好，字幕
`,
  'utf8',
)

const { convertSubtitle } = await loadEngine(path.join(root, 'electron/engines/subtitle.ts'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-sub-smoke-'))

async function conv(input, target) {
  const outputPath = path.join(tmp, `out.${target}`)
  const r = await convertSubtitle({ inputPath: input, target, outputPath }, `smoke-${target}`, () => {})
  if (!r.ok || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 8) {
    throw new Error(`FAIL ${path.basename(input)}→${target}: ${r.error}`)
  }
  const text = fs.readFileSync(outputPath, 'utf8')
  if (!text.includes('Hello') && !text.includes('你好')) throw new Error(`FAIL ${target} missing text`)
  console.log(`OK ${path.basename(input)}→${target} bytes=${text.length}`)
  return outputPath
}

try {
  const vtt = await conv(srt, 'vtt')
  const ass = await conv(srt, 'ass')
  await conv(vtt, 'srt')
  await conv(ass, 'srt')
  await conv(srt, 'txt')
} catch (e) {
  console.error(String(e))
  process.exit(1)
}
console.log('SMOKE SUBTITLE PASS')
