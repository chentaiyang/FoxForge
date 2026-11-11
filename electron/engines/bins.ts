/**
 * 查找随包或系统里的外部二进制，以及给 Sharp 隔离用的「真正的 Node.js」。
 *
 * Sharp 绝不能在 Electron 进程内跑真实 vips 操作。解析 Node 时禁止使用
 * process.execPath（Electron 里那是 Electron 自己）和 ELECTRON_RUN_AS_NODE。
 * 仅当当前进程不是 Electron 时，才允许把 process.execPath 当作 Node。
 * 冒烟脚本在纯 Node 下可以进程内加载 Sharp。
 */
import { spawnTracked } from './jobs'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function requireElectron(): { app?: { isPackaged?: boolean } } | null {
  try {
    const req = createRequire(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url))
    return req('electron') as { app?: { isPackaged?: boolean } }
  } catch {
    return null
  }
}
/**
 * 安装包里引擎的常见子目录。LibreOffice / Poppler / qpdf / Calibre 不会全部平铺在 bin/，
 * 避免不同工具包的 DLL 重名互相覆盖。
 *
 * Poppler / qpdf 的官方 zip 常带一层版本目录，除下列常见路径外，findBinary
 * 还会在 RECURSIVE_PACKAGED_ROOTS 下按文件名再向下找几层。
 */
export const PACKAGED_ENGINE_SUBDIRS = [
  path.join('bin', 'poppler'),
  path.join('bin', 'poppler', 'bin'),
  path.join('bin', 'poppler', 'Library', 'bin'),
  path.join('bin', 'qpdf-toolkit', 'bin'),
  path.join('bin', 'qpdf-toolkit'),
  path.join('bin', 'tesseract'),
  path.join('LibreOffice', 'program'),
  path.join('libreoffice', 'program'),
  'calibre',
  path.join('calibre', 'bin'),
  path.join('calibre', 'Calibre'),
  path.join('Calibre Portable', 'Calibre'),
]

/** 按打包/开发环境列出可能存放外部工具的目录。 */
export function candidateBinDirs(extraSubdirs: string[] = []): string[] {
  const dirs: string[] = []
  const push = (p: string) => {
    if (p && !dirs.includes(p)) dirs.push(p)
  }
  const subs = [...PACKAGED_ENGINE_SUBDIRS, ...extraSubdirs]
  try {
    // 延迟加载 electron，方便冒烟脚本在非 Electron 环境里 import 引擎
    const el = requireElectron()
    if (el?.app?.isPackaged) {
      push(path.join(process.resourcesPath, 'bin'))
      for (const sub of subs) push(path.join(process.resourcesPath, sub))
      push(path.join(path.dirname(process.execPath), 'resources', 'bin'))
    }
  } catch {
    /* 不在 Electron 里，或当前 ESM 无法 require */
  }
  push(path.join(process.cwd(), 'bin'))
  push(path.join(process.cwd(), 'resources', 'bin'))
  for (const sub of subs) {
    push(path.join(process.cwd(), 'resources', sub))
    push(path.join(process.cwd(), sub))
  }
  return dirs
}

/**
 * 给 Windows 子进程把 exe 所在目录放到 PATH 最前面，以便加载同目录 DLL。
 * 非 Windows 则同时补上 LD_LIBRARY_PATH / DYLD_LIBRARY_PATH。
 */
export function envWithExeDir(bin: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  const dir = path.dirname(bin)
  if (!dir || dir === '.' ) return env
  env.PATH = dir + path.delimiter + (env.PATH || '')
  if (process.platform !== 'win32') {
    const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
    env[key] = env[key] ? `${dir}${path.delimiter}${env[key]}` : dir
  }
  return env
}

/** 在 PATH 里查找可执行文件；已是绝对路径则只检查是否存在。 */
export function whichSync(cmd: string): string | null {
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try {
      if (fs.existsSync(cmd) && fs.statSync(cmd).isFile()) return cmd
    } catch {
      /* 忽略 */
    }
    return null
  }
  const pathEnv = process.env.PATH || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, process.platform === 'win32' ? cmd + ext : cmd)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* 忽略 */
      }
    }
  }
  return null
}

/**
 * 只在这些打包根目录下按文件名向下再找几层。
 * 官方 Poppler / qpdf zip 常多一层版本目录（如 Release-26.09.0-0/Library/bin），
 * 不要把递归范围扩大到整个磁盘或整个 resources。
 */
export const RECURSIVE_PACKAGED_ROOTS = [
  path.join('bin', 'poppler'),
  path.join('bin', 'qpdf-toolkit'),
]

const RECURSIVE_PACKAGED_MAX_DEPTH = 6

function packagedRecursiveRoots(): string[] {
  const roots: string[] = []
  const push = (p: string) => {
    if (p && !roots.includes(p)) roots.push(p)
  }
  try {
    const el = requireElectron()
    if (el?.app?.isPackaged) {
      for (const sub of RECURSIVE_PACKAGED_ROOTS) {
        push(path.join(process.resourcesPath, sub))
        push(path.join(path.dirname(process.execPath), 'resources', sub))
      }
    }
  } catch {
    /* 不在 Electron 里 */
  }
  for (const sub of RECURSIVE_PACKAGED_ROOTS) {
    push(path.join(process.cwd(), 'resources', sub))
    push(path.join(process.cwd(), sub))
  }
  return roots
}

function isFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 在 root 下按文件名递归查找，深度有限。 */
export function findNamedFileUnder(root: string, names: string[], maxDepth = RECURSIVE_PACKAGED_MAX_DEPTH): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  const walk = (dir: string, depth: number): string | null => {
    if (!dir || depth < 0) return null
    let st: fs.Stats
    try {
      st = fs.statSync(dir)
    } catch {
      return null
    }
    if (!st.isDirectory()) return null
    for (const name of names) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext)
        if (isFile(full)) return full
      }
    }
    if (depth === 0) return null
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return null
    }
    for (const name of entries) {
      const found = walk(path.join(dir, name), depth - 1)
      if (found) return found
    }
    return null
  }
  return walk(root, maxDepth)
}

/** 先在 candidateBinDirs 里找；再在打包的 poppler / qpdf 树下递归按文件名找；最后查 PATH。 */
export function findBinary(names: string[], extraSubdirs: string[] = []): string | null {
  const exts = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of candidateBinDirs(extraSubdirs)) {
    for (const name of names) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext)
        if (isFile(full)) return full
      }
    }
  }
  for (const root of packagedRecursiveRoots()) {
    const found = findNamedFileUnder(root, names)
    if (found) return found
  }
  for (const name of names) {
    const fromPath = whichSync(name)
    if (fromPath) return fromPath
  }
  return null
}

/**
 * 「未找到已打包引擎」的提示：Windows（尤其是安装包）不要把 apt 放在最前面，
 * 应说明工具本该在安装目录的 resources/bin/... 下，缺失通常是打包问题。
 */
export function missingBundledToolMessage(tool: string, packagedSubdir: string, linuxHint?: string): string {
  const where = `安装目录的 resources/${packagedSubdir.replace(/\\/g, '/')}`
  if (process.platform === 'win32') {
    return `未找到 ${tool}。正式安装包应已将其放在 ${where} 下；若仍缺失，通常是打包问题。`
  }
  const extra = linuxHint ? ` ${linuxHint}` : ''
  return `未找到 ${tool}。请将其放入 resources/${packagedSubdir.replace(/\\/g, '/')}，或从系统包管理器安装。${extra}`.trim()
}

/** 运行外部命令并捕获 stdout/stderr，超时则 SIGKILL。 */
export function runCapture(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnTracked(bin, args, {
      windowsHide: true,
      cwd: opts?.cwd,
      env: envWithExeDir(bin, opts?.env ? { ...process.env, ...opts.env } : process.env),
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

export function extOf(p: string): string {
  return path.extname(p).replace(/^\./, '').toLowerCase()
}

/** 在源文件旁生成不冲突的输出路径；与输入同名时加 _converted。 */
export function defaultOutputPath(inputPath: string, target: string): string {
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const ext = target.toLowerCase() === 'jpeg' ? 'jpg' : target.toLowerCase() === 'tif' ? 'tiff' : target.toLowerCase()
  let candidate = path.join(dir, `${base}.${ext}`)
  if (candidate.toLowerCase() === inputPath.toLowerCase()) {
    candidate = path.join(dir, `${base}_converted.${ext}`)
  }
  if (!fs.existsSync(candidate)) return candidate
  let i = 1
  while (true) {
    const p = path.join(dir, `${base}_converted_${i}.${ext}`)
    if (!fs.existsSync(p)) return p
    i += 1
  }
}

/** 在 parent 下生成尚未占用的目录名。 */
export function uniqueDir(parent: string, name: string): string {
  let candidate = path.join(parent, name)
  if (!fs.existsSync(candidate)) return candidate
  let i = 1
  while (true) {
    const p = path.join(parent, `${name}_${i}`)
    if (!fs.existsSync(p)) return p
    i += 1
  }
}

/** 删除文件，忽略不存在或权限错误。 */
export function unlinkQuiet(p: string | undefined | null) {
  if (!p) return
  try {
    fs.unlinkSync(p)
  } catch {
    /* 忽略 */
  }
}

/** 递归删除文件或目录，忽略错误。 */
export function rmQuiet(p: string | undefined | null) {
  if (!p) return
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export function tmpPath(prefix: string, ext: string): string {
  const e = ext.replace(/^\./, '')
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.${e}`,
  )
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}


/**
 * 解析真正的系统 Node.js，绝不要返回 Electron 可执行文件。
 * Electron 里 process.execPath 是 Electron 本身，禁止用来跑 Sharp；
 * 也不要设置 ELECTRON_RUN_AS_NODE。可用 MEDIAFORGE_NODE 覆盖。
 */
export function resolveSystemNode(): string | null {
  const candidates: Array<string | null | undefined> = [
    process.env.MEDIAFORGE_NODE,
    process.versions.electron ? undefined : process.execPath,
    process.env.npm_node_execpath,
    whichSync('node'),
    process.platform === 'win32' ? whichSync('node.exe') : undefined,
    '/usr/local/lib/nodejs/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const c of candidates) {
    if (!c) continue
    const base = path.basename(c).toLowerCase()
    if (base.includes('electron')) continue
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      /* 忽略 */
    }
  }
  return null
}

/**
 * 给系统 Node 子进程用的环境：去掉 ELECTRON_RUN_AS_NODE 和 Electron 的库路径，
 * 避免子进程仍链到 Electron 自带的 libvips / 预加载库。
 */
export function envForSystemNode(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.LD_PRELOAD
  delete env.DYLD_INSERT_LIBRARIES
  const electronLib = /node_modules[\\/]electron[\\/]dist/i
  for (const key of ['LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH']) {
    if (!env[key]) continue
    env[key] = env[key]
      .split(path.delimiter)
      .filter((p) => p && !electronLib.test(p))
      .join(path.delimiter)
    if (!env[key]) delete env[key]
  }
  return env
}

/** 定位 resources/bin/sharp-worker.mjs（开发态或打包 extraResources）。 */
export function findSharpWorker(): string | null {
  const names = ['sharp-worker.mjs']
  return findBinary(names) || whichSync(path.join(process.cwd(), 'resources', 'bin', 'sharp-worker.mjs'))
}

/** 找到含 node_modules/sharp 的根目录，作为工作进程的 cwd，以便 require('sharp')。 */
export function sharpModuleRoot(): string {
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), 'resources'),
    typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'app.asar.unpacked') : '',
    typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'app') : '',
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'node_modules', 'sharp'))) return c
  }
  return process.cwd()
}
