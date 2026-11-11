#!/usr/bin/env node
/**
 * 探测本机 LibreOffice；加 --install 时才尝试在 Linux 上 apt 安装 writer/calc/impress。
 * 默认是 dry-run。不会卸载或强行升级无关软件。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function which(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : ['']
  for (const dir of (process.env.PATH || '').split(sep)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  return null
}

const wantInstall = process.argv.includes('--install')
const soffice = which('soffice') || which('libreoffice')

if (soffice) {
  const ver = spawnSync(soffice, ['--version'], { encoding: 'utf8' })
  console.log('OK LibreOffice found:', soffice)
  console.log((ver.stdout || ver.stderr || '').trim())
  process.exit(0)
}

console.log('LibreOffice not found in PATH / common names (soffice, libreoffice).')

if (!wantInstall) {
  console.log('Hint (Linux box): node scripts/ensure-libreoffice.mjs --install')
  console.log('Or: sudo apt-get install -y libreoffice-writer libreoffice-calc libreoffice-impress')
  process.exit(1)
}

if (process.platform !== 'linux') {
  console.error('--install only supported on Linux (apt). Install LibreOffice manually on Windows/macOS.')
  process.exit(1)
}

const pkgs = ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress']
console.log('Attempting: sudo apt-get update && sudo apt-get install -y', pkgs.join(' '))
const update = spawnSync('sudo', ['apt-get', 'update'], { stdio: 'inherit' })
if (update.status !== 0) {
  console.error('apt-get update failed')
  process.exit(update.status ?? 1)
}
const install = spawnSync('sudo', ['apt-get', 'install', '-y', ...pkgs], { stdio: 'inherit' })
if (install.status !== 0) {
  console.error('apt-get install failed')
  process.exit(install.status ?? 1)
}

const again = which('soffice') || which('libreoffice')
if (!again) {
  console.error('Install finished but soffice still not found')
  process.exit(1)
}
console.log('OK installed:', again)
process.exit(0)
