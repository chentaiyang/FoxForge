/**
 * 预加载脚本：在隔离上下文里把 MediaForgeAPI 挂到 window.mediaForge，
 * 供渲染进程调用主进程的对话框、转换、人声分离和系统资源管理器。
 *
 * 内部桥名称必须保持 window.mediaForge / MediaForgeAPI，与产品名「灵狐工坊」无关。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type VideoCodecId = 'h264' | 'h265' | 'av1' | 'copy'

export interface EngineHealthItem {
  id: string
  name: string
  status: 'ready' | 'missing' | 'optional'
  covers: string
  version?: string
  path?: string
  detail?: string
}

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

export interface VocalProbe {
  python: string | null
  demucsModuleOk: boolean
  demucsVersion?: string
  demucsCli: string | null
  installHint: string
  ffmpegFallbackReady: boolean
  uvrReady: boolean
  uvrDetail?: string
}

/** 暴露给渲染进程的 MediaForgeAPI，IPC 通道名与方法一一对应。 */
const mediaForge = {
  platform: process.platform,
  version: '0.1.1',

  getPathForFile(file: File): string {
    try {
      // Electron 32+ 起优先用 webUtils.getPathForFile
      if (typeof webUtils?.getPathForFile === 'function') {
        return webUtils.getPathForFile(file) || ''
      }
    } catch {
      /* 忽略 */
    }
    // 旧版 Electron 会把绝对路径挂在 File.path 上
    const legacy = (file as File & { path?: string }).path
    return legacy || ''
  },

  getEngineHealth(): Promise<EngineHealthItem[]> {
    return ipcRenderer.invoke('engines:getHealth')
  },

  openFiles(filters?: { name: string; extensions: string[] }[]): Promise<string[]> {
    return ipcRenderer.invoke('dialog:openFiles', { filters })
  },

  openDirectory(): Promise<string | null> {
    return ipcRenderer.invoke('dialog:openDirectory')
  },

  convertMedia(payload: {
    jobId: string
    inputPath: string
    target: string
    videoCodec?: VideoCodecId
    outputPath?: string
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:media', payload)
  },

  convertDocument(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:document', payload)
  },

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
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:pdf', payload)
  },

  convertImage(payload: {
    jobId: string
    inputPath: string
    inputPaths?: string[]
    target: string
    outputPath?: string
    quality?: number
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:image', payload)
  },


  convertOcr(payload: {
    jobId: string
    inputPath: string
    target?: string
    outputPath?: string
    lang?: string
    dpi?: number
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:ocr', payload)
  },

  convertEbook(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:ebook', payload)
  },

  convertArchive(payload: {
    jobId: string
    inputPath: string
    inputPaths?: string[]
    target: string
    outputPath?: string
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:archive', payload)
  },

  convertSubtitle(payload: {
    jobId: string
    inputPath: string
    target: string
    outputPath?: string
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('convert:subtitle', payload)
  },

  probeVocalEngine(): Promise<VocalProbe> {
    return ipcRenderer.invoke('vocal:probe')
  },

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
  }): Promise<ConvertResult> {
    return ipcRenderer.invoke('vocal:separate', payload)
  },

  pauseConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }> {
    return ipcRenderer.invoke('convert:pause', jobId)
  },

  resumeConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }> {
    return ipcRenderer.invoke('convert:resume', jobId)
  },

  cancelConvert(jobId: string): Promise<{ ok: boolean; deferred?: boolean; message?: string }> {
    return ipcRenderer.invoke('convert:cancel', jobId)
  },

  onConvertProgress(handler: (ev: ConvertProgressEvent) => void): () => void {
    const listener = (_: Electron.IpcRendererEvent, data: ConvertProgressEvent) => handler(data)
    ipcRenderer.on('convert:progress', listener)
    return () => {
      ipcRenderer.removeListener('convert:progress', listener)
    }
  },

  showItemInFolder(targetPath: string): Promise<boolean> {
    return ipcRenderer.invoke('shell:showItemInFolder', targetPath)
  },

  openPath(targetPath: string): Promise<string> {
    return ipcRenderer.invoke('shell:openPath', targetPath)
  },
}

contextBridge.exposeInMainWorld('mediaForge', mediaForge)

export type MediaForgeAPI = typeof mediaForge
