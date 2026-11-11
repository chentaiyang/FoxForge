/**
 * 用 esbuild 把 electron/engines 下的 TypeScript 打成临时 ESM，供冒烟脚本在纯 Node 里加载。
 * 会把 electron 换成 electron-stub.mjs，并把 sharp 标为 external。
 * 纯 Node 冒烟可以进程内 Sharp；不能替代在真正 Electron 进程里验证隔离。
 */
import { buildSync } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

export function loadEngine(entryAbs) {
  const dir = path.join(root, '.tmp-engine')
  fs.mkdirSync(dir, { recursive: true })
  const outfile = path.join(dir, `${path.basename(entryAbs, path.extname(entryAbs))}.mjs`)
  const stub = path.join(here, 'electron-stub.mjs')
  buildSync({
    entryPoints: [entryAbs],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    alias: { electron: stub },
    external: ['sharp', 'electron'],
    absWorkingDir: root,
  })
  return import(pathToFileURL(outfile).href)
}
