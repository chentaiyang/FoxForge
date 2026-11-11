/**
 * 主进程引擎与预加载桥共用的健康状态、进度和转换结果类型。
 *
 * EngineStatus 含 optional。清单里的「特殊音乐模块」永远是 optional、从不 ready，
 * 但仍计入引擎总数（分母），不要把这项从计数里拿掉。
 */
/** ready 已接入；missing 应有却没找到；optional 允许长期缺失（如特殊音乐模块）。 */
export type EngineStatus = 'ready' | 'missing' | 'optional'

export interface EngineHealthItem {
  id: string
  name: string
  status: EngineStatus
  covers: string
  version?: string
  path?: string
  detail?: string
}

export type VideoCodecId = 'h264' | 'h265' | 'av1' | 'copy'

export type ConvertPhase = 'convert' | 'pack' | 'finalize'

export interface ConvertProgressEvent {
  jobId: string
  percent: number
  timeSec?: number
  durationSec?: number
  message?: string
  phase?: ConvertPhase
  estimatedBytes?: number
}

export interface ConvertResult {
  jobId: string
  ok: boolean
  outputPath?: string
  outputPaths?: string[]
  engineUsed?: string
  message?: string
  error?: string
  errorCode?: string
  errorDetail?: string
}
