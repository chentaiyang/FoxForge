/**
 * FFmpeg 音视频转换冒烟。跑法：npm run smoke:ffmpeg
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

function whichSync(cmd) {
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  for (const dir of pathEnv.split(sep)) {
    const full = path.join(dir, cmd)
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
    } catch {}
  }
  return null
}

const ffmpeg = whichSync('ffmpeg')
const ffprobe = whichSync('ffprobe')
if (!ffmpeg) {
  console.error('FAIL: ffmpeg not found')
  process.exit(1)
}
console.log('OK ffmpeg:', ffmpeg)
console.log('OK ffprobe:', ffprobe || '(missing)')

const input = path.join(root, 'test-fixtures', 'tone.wav')
const output = path.join(root, 'test-fixtures', 'tone_smoke.flac')
if (!fs.existsSync(input)) {
  console.error('FAIL: missing', input)
  process.exit(1)
}

const args = ['-y', '-hide_banner', '-stats', '-i', input, '-vn', '-c:a', 'flac', output]
const child = spawn(ffmpeg, args, { windowsHide: true })
let err = ''
child.stderr.on('data', (d) => { err += d.toString() })
child.on('close', (code) => {
  if (code === 0 && fs.existsSync(output)) {
    const st = fs.statSync(output)
    console.log('OK convert flac bytes=', st.size)
    const mainJs = fs.readFileSync(path.join(root, 'dist-electron', 'main.js'), 'utf8')
    for (const needle of ['engines:getHealth', 'convert:media', 'convert:progress', 'libmp3lame']) {
      if (!mainJs.includes(needle)) {
        console.error('FAIL: main.js missing', needle)
        process.exit(1)
      }
    }
    console.log('OK dist-electron/main.js IPC + encoder strings present')
    process.exit(0)
  }
  console.error('FAIL ffmpeg code', code, err.slice(-500))
  process.exit(1)
})
