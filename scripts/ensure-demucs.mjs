/**
 * 在 .venv-demucs 里安装 Demucs，供人声分离使用。
 * 跑法：node scripts/ensure-demucs.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const venv = path.join(root, '.venv-demucs')
const py = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const pip = path.join(venv, process.platform === 'win32' ? 'Scripts/pip.exe' : 'bin/pip')

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log('>', bin, args.join(' '))
    const child = spawn(bin, args, { stdio: 'inherit', windowsHide: true, ...opts })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
}

const doInstall = process.argv.includes('--install')

async function main() {
  if (fs.existsSync(py)) {
    try {
      await run(py, ['-c', 'import demucs; print("demucs", getattr(demucs,"__version__","ok"))'])
      console.log('OK demucs already available at', py)
      return
    } catch {
      console.log('venv exists but demucs missing')
    }
  }

  if (!doInstall) {
    console.log(`Demucs 未就绪。安装（CPU）：`)
    console.log(`  node scripts/ensure-demucs.mjs --install`)
    console.log(`或手动：`)
    console.log(`  python3 -m venv .venv-demucs`)
    console.log(`  .venv-demucs/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu`)
    console.log(`  .venv-demucs/bin/pip install demucs numpy torchaudio`)
    process.exit(1)
  }

  const python = process.platform === 'win32' ? 'python' : 'python3'
  if (!fs.existsSync(py)) {
    await run(python, ['-m', 'venv', venv])
  }
  await run(pip, ['install', '-U', 'pip', 'setuptools', 'wheel'])
  await run(pip, ['install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cpu'])
  await run(pip, ['install', 'demucs', 'numpy', 'torchaudio'])
  await run(py, ['-c', 'import demucs; print("demucs", getattr(demucs,"__version__","ok"))'])
  console.log('OK demucs installed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
