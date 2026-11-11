/**
 * 在真正的 Electron 进程里直接加载 Sharp 并做一次 vips 操作。
 * 用来验证「Electron 内跑 Sharp 会出问题」这一前提，不代表产品路径。
 * 跑法：用项目的 Electron 可执行文件加载本脚本，不要只用系统 Node 跑。
 */
import { app } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const sharp = require('sharp')
const png = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'sample.png')
const out = path.join(os.tmpdir(), 'mf-min-sharp.jpg')

app.whenReady().then(async () => {
  try {
    console.log('in-electron sharp', sharp.versions?.sharp, 'vips', sharp.versions?.vips, 'node', process.version)
    console.log('step create')
    const buf = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3366ff' } }).png().toBuffer()
    console.log('create ok', buf.length)
    console.log('step metadata')
    const meta = await sharp(png).metadata()
    console.log('meta ok', meta.width, meta.height, meta.format)
    console.log('step toFile')
    await sharp(png).jpeg({ quality: 85 }).toFile(out)
    console.log('toFile ok', fs.statSync(out).size)
    app.exit(0)
  } catch (e) {
    console.error('FAIL', e)
    app.exit(1)
  }
})
