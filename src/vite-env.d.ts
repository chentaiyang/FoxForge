/// <reference types="vite/client" />

/**
 * 渲染进程对 window.mediaForge（MediaForgeAPI）的类型声明。
 * 桥名称是内部标识，与对外产品名「灵狐工坊」无关；实现见 electron/preload.ts。
 */

type EngineStatus = 'ready' | 'missing' | 'optional'

interface EngineHealthItem {
  id: string
  name: string
  status: EngineStatus
  covers: string
  version?: string
  path?: string
  detail?: string
}

type VideoCodecId = 'h264' | 'h265' | 'av1' | 'copy'

type ConvertPhase = 'convert' | 'pack' | 'finalize'

interface ConvertProgressEvent {
  jobId: string
  percent: number
  timeSec?: number
  durationSec?: number
  message?: string
  phase?: ConvertPhase
  estimatedBytes?: number
}

interface ConvertResult {
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

interface VocalProbe {
  python: string | null
  demucsModuleOk: boolean
  demucsVersion?: string
  demucsCli: string | null
  installHint: string
  ffmpegFallbackReady: boolean
  uvrReady: boolean
  uvrDetail?: string
}

interface FileFilter {
  name: string
  extensions: string[]
}

interface MediaForgeAPI {
  platform: string
  version: string
  getPathForFile(file: File): string
  getEngineHealth(): Promise<EngineHealthItem[]>
  openFiles(filters?: FileFilter[]): Promise<string[]>
  openDirectory(): Promise<string | null>
  convertMedia(payload: {
    jobId: string
    inputPath: string
    target: string
    videoCodec?: VideoCodecId
    outputPath?: string
  }): Promise<ConvertResult>
  convertDocument(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult>
  convertPdf(payload: {
    jobId: string
    inputPath: string
    inputPaths?: string[]
    target?: string
    action?: 'convert' | 'split' | 'merge' | 'encrypt' | 'decrypt' | 'ocr'
    password?: string
    ownerPassword?: string
    outputPath?: string
    dpi?: number
  }): Promise<ConvertResult>
  convertImage(payload: {
    jobId: string
    inputPath: string
    inputPaths?: string[]
    target: string
    outputPath?: string
    quality?: number
  }): Promise<ConvertResult>
  convertOcr(payload: {
    jobId: string
    inputPath: string
    target?: string
    outputPath?: string
    lang?: string
    dpi?: number
  }): Promise<ConvertResult>
  convertEbook(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult>
  convertArchive(payload: {
    jobId: string
    inputPath: string
    inputPaths?: string[]
    target: string
    outputPath?: string
  }): Promise<ConvertResult>
  convertSubtitle(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult>
  probeVocalEngine(): Promise<VocalProbe>
  separateVocals(payload: {
    jobId: string
    inputPath: string
    outputDir?: string
    model?: string
    backend?: 'demucs' | 'ffmpeg-simple' | 'uvr'
    outputs?: {
      vocals?: boolean
      instrumental?: boolean
      drums?: boolean
      bass?: boolean
      other?: boolean
    }
    device?: string
  }): Promise<ConvertResult>
  pauseConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }>
  resumeConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }>
  cancelConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }>
  onConvertProgress(handler: (ev: ConvertProgressEvent) => void): () => void
  showItemInFolder(targetPath: string): Promise<boolean>
  openPath(targetPath: string): Promise<string>
}

interface Window {
  mediaForge?: MediaForgeAPI
}
