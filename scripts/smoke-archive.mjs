#!/usr/bin/env node
/**
 * 压缩包引擎冒烟：打包与解压。跑法：npm run smoke:archive
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngine } from './load-engine.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const { convertArchive, packZip, unpackZipBuffer } = await loadEngine(path.join(root, 'electron/engines/archive.ts'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-zip-smoke-'))
const dir = path.join(tmp, 'src')
fs.mkdirSync(dir)
fs.writeFileSync(path.join(dir, 'hello.txt'), 'MediaForge zip smoke\n', 'utf8')
fs.writeFileSync(path.join(dir, '中文文件名.txt'), '你好，压缩包\n', 'utf8')
const png = path.join(root, 'test-fixtures', 'sample.png')
if (fs.existsSync(png)) fs.copyFileSync(png, path.join(dir, 'pic.png'))

const zipPath = path.join(tmp, 'packed.zip')
packZip([dir], zipPath)
if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 40) {
  console.error('FAIL pack empty')
  process.exit(1)
}
console.log('OK pack bytes=', fs.statSync(zipPath).size)

const outDir = path.join(tmp, 'out')
const files = unpackZipBuffer(fs.readFileSync(zipPath), outDir)
const names = files.map((f) => path.basename(f))
if (!names.includes('hello.txt') || !names.includes('中文文件名.txt')) {
  console.error('FAIL names', names)
  process.exit(1)
}
const cn = files.find((f) => f.endsWith('中文文件名.txt'))
if (fs.readFileSync(cn, 'utf8').trim() !== '你好，压缩包') {
  console.error('FAIL chinese content')
  process.exit(1)
}
console.log('OK unpack', names.join(', '))

const r = await convertArchive(
  { inputPath: zipPath, target: '解压', outputPath: path.join(tmp, 'via-engine') },
  'smoke-unzip',
  (ev) => ev.message && console.log(' ', ev.message),
)
if (!r.ok || !r.outputPath || !fs.existsSync(r.outputPath)) {
  console.error('FAIL convertArchive unpack', r)
  process.exit(1)
}
console.log('OK convertArchive 解压 →', r.outputPath)

const r2 = await convertArchive(
  {
    inputPath: path.join(dir, 'hello.txt'),
    inputPaths: [path.join(dir, 'hello.txt'), path.join(dir, '中文文件名.txt')],
    target: 'zip',
    outputPath: path.join(tmp, 'engine.zip'),
  },
  'smoke-zip',
  (ev) => ev.message && console.log(' ', ev.message),
)
if (!r2.ok || !r2.outputPath || fs.statSync(r2.outputPath).size < 40) {
  console.error('FAIL convertArchive pack', r2)
  process.exit(1)
}
console.log('OK convertArchive pack bytes=', fs.statSync(r2.outputPath).size)
console.log('SMOKE ARCHIVE PASS')
