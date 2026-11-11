#!/usr/bin/env node
/**
 * 把 UVR · MDX-Net 依赖装进 .venv-demucs，并下载默认 ONNX 模型。
 * 不编译 diffq（需要 Python.h）。MDX-Net 走 ONNX Runtime。
 * 跑法：node scripts/ensure-uvr.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const venvPy = path.join(
  root,
  '.venv-demucs',
  process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'),
)
const modelDir = path.join(root, 'resources', 'uvr-models')
const modelName = 'UVR_MDXNET_1_9703.onnx'
const modelPath = path.join(modelDir, modelName)

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: 'inherit', cwd: root })
  return r.status ?? 1
}

if (!fs.existsSync(venvPy)) {
  console.error('缺少 .venv-demucs。请先: node scripts/ensure-demucs.mjs')
  process.exit(1)
}

console.log('Installing audio-separator runtime deps (no diffq / no python headers)...')
const pkgs = [
  'audio-separator',
  'onnxruntime',
  'onnx',
  'librosa',
  'soundfile',
  'numpy',
  'scipy',
  'ml_collections',
  'pydub',
  'pyyaml',
  'requests',
  'tqdm',
  'einops',
  'audioread',
  'resampy',
  'six',
  'packaging',
  'audioop-lts',
]
const pip = run(venvPy, ['-m', 'pip', 'install', '-U', ...pkgs])
if (pip !== 0) {
  console.error('pip install failed')
  process.exit(1)
}

fs.mkdirSync(modelDir, { recursive: true })
if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024) {
  console.log('OK model already present', modelPath, fs.statSync(modelPath).size)
} else {
  console.log('Downloading', modelName)
  const code = run(venvPy, [
    '-m',
    'audio_separator.utils.cli',
    '--download_model_only',
    '-m',
    modelName,
    '--model_file_dir',
    modelDir,
  ])
  // 必要时顺着 console script 找到模块脚本路径
  if (code !== 0) {
    const cli = path.join(path.dirname(venvPy), 'audio-separator')
    const code2 = run(cli, ['--download_model_only', '-m', modelName, '--model_file_dir', modelDir])
    if (code2 !== 0) process.exit(1)
  }
}

if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1024 * 1024) {
  console.error('model missing after download')
  process.exit(1)
}
console.log('OK UVR MDX-Net model', modelPath)
process.exit(0)
