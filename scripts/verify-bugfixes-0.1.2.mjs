#!/usr/bin/env node
/**
 * 校验 v0.1.2 的三处修复：Poppler/qpdf 目录铺平与递归查找、
 * 临时文件保留真实扩展名、FFmpeg 显式 -f muxer。
 * 用法：node scripts/verify-bugfixes-0.1.2.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hoistSingleTopDir, normalizePackagedToolkit } from './ensure-windows-engines.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
let failed = 0

function assert(cond, msg) {
  if (cond) {
    console.log('  OK', msg)
  } else {
    failed += 1
    console.error('  FAIL', msg)
  }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true })
}

function touch(p) {
  mkdirp(path.dirname(p))
  fs.writeFileSync(p, '')
}

function testHoist() {
  console.log('=== 铺平官方 zip 的版本前缀目录 ===')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-hoist-'))
  try {
    const poppler = path.join(tmp, 'poppler')
    touch(path.join(poppler, 'Release-26.09.0-0', 'Library', 'bin', 'pdftoppm.exe'))
    touch(path.join(poppler, 'Release-26.09.0-0', 'Library', 'bin', 'pdftotext.exe'))
    touch(path.join(poppler, 'Release-26.09.0-0', 'Library', 'bin', 'poppler.dll'))
    mkdirp(path.join(poppler, 'Release-26.09.0-0', 'Library', 'share', 'poppler'))
    fs.writeFileSync(path.join(poppler, 'Release-26.09.0-0', 'Library', 'share', 'poppler', 'nameToUnicode'), 'x')

    const got = normalizePackagedToolkit(poppler, 'pdftoppm.exe', ['Library/bin', 'bin'])
    const rel = got ? path.relative(poppler, got).split(path.sep).join('/') : null
    assert(rel === 'Library/bin/pdftoppm.exe', `poppler exe 位于 Library/bin，实际: ${rel}`)
    assert(fs.existsSync(path.join(poppler, 'Library', 'bin', 'pdftotext.exe')), 'pdftotext.exe 一并提升')
    assert(fs.existsSync(path.join(poppler, 'Library', 'bin', 'poppler.dll')), '同目录 DLL 一并提升')
    assert(
      fs.existsSync(path.join(poppler, 'Library', 'share', 'poppler', 'nameToUnicode')),
      'poppler-data 保留在 Library/share',
    )
    assert(!fs.existsSync(path.join(poppler, 'Release-26.09.0-0')), '版本前缀目录已去掉')

    const again = normalizePackagedToolkit(poppler, 'pdftoppm.exe', ['Library/bin', 'bin'])
    assert(
      again && path.relative(poppler, again).split(path.sep).join('/') === 'Library/bin/pdftoppm.exe',
      '目标布局重复 normalize 保持不变',
    )

    const qpdf = path.join(tmp, 'qpdf-toolkit')
    touch(path.join(qpdf, 'qpdf-12.4.2-msvc64', 'bin', 'qpdf.exe'))
    touch(path.join(qpdf, 'qpdf-12.4.2-msvc64', 'bin', 'qpdf.dll'))
    touch(path.join(qpdf, 'qpdf-12.4.2-msvc64', 'lib', 'qpdf.lib'))
    const qgot = normalizePackagedToolkit(qpdf, 'qpdf.exe', ['bin', ''])
    const qrel = qgot ? path.relative(qpdf, qgot).split(path.sep).join('/') : null
    assert(qrel === 'bin/qpdf.exe', `qpdf exe 位于 bin/，实际: ${qrel}`)
    assert(fs.existsSync(path.join(qpdf, 'lib', 'qpdf.lib')), 'qpdf ../lib 仍在')
    assert(!fs.existsSync(path.join(qpdf, 'qpdf-12.4.2-msvc64')), 'qpdf 版本前缀已去掉')
    const libFromBin = path.join(path.dirname(qgot), '..', 'lib')
    assert(fs.existsSync(path.join(libFromBin, 'qpdf.lib')), 'qpdfEnv 的 ../lib 仍然有效')

    const already = path.join(tmp, 'already-bin')
    touch(path.join(already, 'bin', 'qpdf.exe'))
    assert(hoistSingleTopDir(already) === false, '只有 bin/ 时不提升')
    assert(fs.existsSync(path.join(already, 'bin', 'qpdf.exe')), '已扁平的 bin/ 保持不动')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function testLookupAndTempAndMuxer() {
  console.log('=== 递归查找 / 临时扩展名 / FFmpeg muxer ===')
  const esbuild = path.join(root, 'node_modules', '.bin', 'esbuild')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-verify-'))
  const outfile = path.join(tmp, 'bundle.mjs')
  const runner = path.join(tmp, 'run.mjs')
  const entry = path.join(tmp, 'entry.ts')
  const fixture = path.join(tmp, 'fixture')
  try {
    fs.writeFileSync(
      entry,
      `
export { findBinary, findNamedFileUnder, missingBundledToolMessage } from ${JSON.stringify(path.join(root, 'electron/engines/bins.ts'))}
export { siblingTempPath } from ${JSON.stringify(path.join(root, 'electron/engines/jobs.ts'))}
export { buildFfmpegArgs, ffmpegMuxerForTarget } from ${JSON.stringify(path.join(root, 'electron/engines/ffmpeg.ts'))}
`,
    )
    const stub = path.join(tmp, 'electron-stub.mjs')
    fs.writeFileSync(stub, 'export const app = { isPackaged: false }\nexport default { app }\n')
    const build = spawnSync(
      esbuild,
      [entry, '--bundle', '--platform=node', '--format=esm', `--alias:electron=${stub}`, `--outfile=${outfile}`],
      { encoding: 'utf8' },
    )
    if (build.status !== 0 || !fs.existsSync(outfile)) {
      console.error(build.stdout || '')
      console.error(build.stderr || '')
      assert(false, 'esbuild 打包校验入口失败')
      return
    }
    const runnerSrc = `
import fs from 'node:fs'
import path from 'node:path'
import { findBinary, findNamedFileUnder, missingBundledToolMessage, siblingTempPath, buildFfmpegArgs, ffmpegMuxerForTarget } from ${JSON.stringify(outfile)}

const fixture = ${JSON.stringify(fixture)}
const popplerNested = path.join(fixture, 'resources', 'bin', 'poppler', 'Release-26.09.0-0', 'Library', 'bin')
const qpdfNested = path.join(fixture, 'resources', 'bin', 'qpdf-toolkit', 'qpdf-12.4.2-msvc64', 'bin')
fs.mkdirSync(popplerNested, { recursive: true })
fs.mkdirSync(qpdfNested, { recursive: true })
fs.writeFileSync(path.join(popplerNested, 'pdftoppm'), '')
fs.writeFileSync(path.join(popplerNested, 'pdftotext'), '')
fs.writeFileSync(path.join(qpdfNested, 'qpdf'), '')

const prev = process.cwd()
process.chdir(fixture)
const ppm = findBinary(['pdftoppm'])
const txt = findBinary(['pdftotext'])
const qpdf = findBinary(['qpdf'])
process.chdir(prev)

const checks = []
const ok = (cond, msg) => { checks.push([!!cond, msg]) }

ok(!!(ppm && ppm.endsWith(path.join('Library', 'bin', 'pdftoppm'))), 'findBinary 递归找到嵌套的 pdftoppm: ' + ppm)
ok(!!(txt && txt.endsWith(path.join('Library', 'bin', 'pdftotext'))), 'findBinary 递归找到嵌套的 pdftotext: ' + txt)
ok(!!(qpdf && qpdf.endsWith(path.join('qpdf-12.4.2-msvc64', 'bin', 'qpdf'))), 'findBinary 递归找到嵌套的 qpdf: ' + qpdf)

const deepRoot = path.join(fixture, 'resources', 'bin', 'poppler')
ok(!!findNamedFileUnder(deepRoot, ['pdftoppm'])?.endsWith('pdftoppm'), 'findNamedFileUnder 在版本目录下找到 pdftoppm')

const movOut = path.join('B:', 'DouyinVideo', '2026-09-17-22-01-06.mov')
const movTemp = siblingTempPath(movOut)
ok(movTemp === path.join('B:', 'DouyinVideo', '2026-09-17-22-01-06.part.mov'), 'mov 临时文件为 *.part.mov: ' + movTemp)
ok(!movTemp.endsWith('.mov.part'), '不再使用 .mov.part')
ok(siblingTempPath(path.join('/tmp', 'song.mp3')) === path.join('/tmp', 'song.part.mp3'), 'mp3 临时文件为 *.part.mp3')
ok(siblingTempPath(path.join('/tmp', 'output')) === path.join('/tmp', 'output.part'), '无扩展名时为 name.part')
const space = movTemp + '.space'
ok(space === path.join('B:', 'DouyinVideo', '2026-09-17-22-01-06.part.mov.space'), 'spacePath 不与临时文件或最终路径冲突')

ok(ffmpegMuxerForTarget('mov') === 'mov', 'mov muxer')
ok(ffmpegMuxerForTarget('mkv') === 'matroska', 'mkv muxer = matroska')
ok(ffmpegMuxerForTarget('mp3') === 'mp3', 'mp3 muxer')
ok(ffmpegMuxerForTarget('.aac') === 'adts', 'aac muxer = adts')
ok(ffmpegMuxerForTarget('m4a') === 'ipod', 'm4a muxer = ipod')
ok(ffmpegMuxerForTarget('wma') === 'asf', 'wma muxer = asf')

const argsMov = buildFfmpegArgs('/in.mp4', '/tmp/clip.part.mov', 'mov', 'h264')
const outIdx = argsMov.lastIndexOf('/tmp/clip.part.mov')
ok(outIdx > 2 && argsMov[outIdx - 2] === '-f' && argsMov[outIdx - 1] === 'mov', 'mov 参数在输出路径前带 -f mov: ' + argsMov.slice(-6).join(' '))
const argsMkv = buildFfmpegArgs('/in.mp4', '/tmp/clip.part.mkv', 'mkv', 'h264')
const mkvIdx = argsMkv.lastIndexOf('/tmp/clip.part.mkv')
ok(argsMkv[mkvIdx - 2] === '-f' && argsMkv[mkvIdx - 1] === 'matroska', 'mkv 参数带 -f matroska')
const argsMp3 = buildFfmpegArgs('/in.mp4', '/tmp/song.part.mp3', 'mp3')
const mp3Idx = argsMp3.lastIndexOf('/tmp/song.part.mp3')
ok(argsMp3[mp3Idx - 2] === '-f' && argsMp3[mp3Idx - 1] === 'mp3', 'mp3 参数带 -f mp3')

const msg = missingBundledToolMessage('qpdf', 'bin/qpdf-toolkit', 'Linux 可 apt install qpdf。')
if (process.platform === 'win32') {
  ok(msg.includes('打包问题') && !/^Linux/.test(msg.trim()) && !msg.includes('apt install'), 'Windows 缺失提示不拿 apt 打头: ' + msg)
} else {
  ok(msg.includes('resources/bin/qpdf-toolkit'), '非 Windows 提示仍给出目录: ' + msg)
  ok(!msg.startsWith('Linux: apt'), '非 Windows 也不把 apt 放在最前面: ' + msg)
}

let nfail = 0
for (const [cond, text] of checks) {
  if (cond) console.log('  OK', text)
  else {
    nfail += 1
    console.error('  FAIL', text)
  }
}
if (nfail) process.exit(1)
`
    fs.writeFileSync(runner, runnerSrc)
    const run = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
    process.stdout.write(run.stdout || '')
    process.stderr.write(run.stderr || '')
    if (run.status !== 0) {
      failed += 1
      assert(false, '查找/临时名/muxer 子进程退出码 ' + run.status)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

testHoist()
testLookupAndTempAndMuxer()

if (failed) {
  console.error("\n" + failed + " 项失败")
  process.exit(1)
}
console.log('\n全部校验通过')
