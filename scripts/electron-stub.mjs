/**
 * 给 load-engine.mjs 打包引擎时用的 electron 空壳，方便在纯 Node 里 import 主进程模块。
 */
export const app = { isPackaged: false }
export default { app }
