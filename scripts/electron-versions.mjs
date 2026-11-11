/**
 * 打印当前 Electron / Node / modules / Chrome 版本。须用 Electron 可执行文件启动。
 */
import { app } from 'electron'
console.log(JSON.stringify({
  electron: process.versions.electron,
  node: process.versions.node,
  modules: process.versions.modules,
  chrome: process.versions.chrome,
}, null, 2))
app.exit(0)
