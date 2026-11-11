/**
 * 灵狐工坊（FoxForge）Electron 主进程。
 *
 * 负责创建窗口、注册 IPC，把渲染进程经 window.mediaForge 发来的转换请求
 * 交给各引擎，并用 jobs.runWithJob / remapIfCancelled 统一挂上进度、暂停和取消。
 *
 * 对外产品名是「灵狐工坊」，因此 Electron userData 落在 ~/.config/灵狐工坊。
 * 内部标识不要改：npm 包名 mediaforge、appId com.mediaforge.app、
 * 预加载桥 window.mediaForge / MediaForgeAPI。
 *
 * 打 Windows 安装包时，NSIS 配置是 oneClick: false 且
 * allowToChangeInstallationDirectory: true，向导会出现「为谁安装」页。
 * 本文件不负责打包。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { ConvertProgressEvent } from './engines/types'
import path from 'node:path'
import {
  convertMedia,
  getEngineHealth,
  type ConvertMediaRequest,
  type VideoCodecId,
} from './engines/ffmpeg'
import {
  convertDocument,
  type ConvertDocumentRequest,
} from './engines/libreoffice'
import {
  convertPdf,
  type ConvertPdfRequest,
  type PdfAction,
} from './engines/pdf'
import {
  convertImage,
  type ConvertImageRequest,
} from './engines/image'
import {
  convertOcr,
  type ConvertOcrRequest,
} from './engines/ocr'
import {
  separateVocals,
  probeVocalEngine,
  type SeparateVocalsRequest,
} from './engines/vocal'
import {
  convertEbook,
  type ConvertEbookRequest,
} from './engines/ebook'
import {
  convertArchive,
  type ConvertArchiveRequest,
} from './engines/archive'
import {
  convertSubtitle,
  type ConvertSubtitleRequest,
} from './engines/subtitle'
import { getJobEstimate, remapIfCancelled, requestCancel, requestPause, requestResume, runWithJob } from './engines/jobs'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null = null
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** 把引擎进度转到渲染进程，并补上任务里记录的偏紧体积估算。 */
function sendProgress(evt: Electron.IpcMainInvokeEvent, jobId: string, progress: ConvertProgressEvent) {
  evt.sender.send('convert:progress', {
    ...progress,
    estimatedBytes: progress.estimatedBytes ?? getJobEstimate(jobId),
  })
}

/** 创建隐藏标题栏的主窗口，标题为「灵狐工坊」。 */
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '灵狐工坊',
    icon: path.join(process.env.VITE_PUBLIC || path.join(__dirname, '../public'), 'icon.png'),
    show: false,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => {
    win?.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(process.env.DIST!, 'index.html'))
  }
}

/**
 * 注册与 window.mediaForge 对应的 IPC。
 * 转换类接口都经 runWithJob 包裹，返回前再用 remapIfCancelled 处理打包阶段的取消。
 */
function registerIpc() {
  ipcMain.handle('engines:getHealth', async () => {
    return getEngineHealth()
  })

  ipcMain.handle('dialog:openFiles', async (_evt, opts?: { filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: opts?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    })
    if (result.canceled) return [] as string[]
    return result.filePaths
  })

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'convert:media',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        target: string
        videoCodec?: VideoCodecId
        outputPath?: string
      },
    ) => {
      const req: ConvertMediaRequest = {
        inputPath: payload.inputPath,
        target: payload.target,
        videoCodec: payload.videoCodec,
        outputPath: payload.outputPath,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertMedia(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )

  ipcMain.handle(
    'convert:document',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        target: string
        outputPath?: string
      },
    ) => {
      const req: ConvertDocumentRequest = {
        inputPath: payload.inputPath,
        target: payload.target,
        outputPath: payload.outputPath,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertDocument(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )


  ipcMain.handle(
    'convert:pdf',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        inputPaths?: string[]
        target?: string
        action?: PdfAction
        password?: string
        ownerPassword?: string
        outputPath?: string
        dpi?: number
      },
    ) => {
      const req: ConvertPdfRequest = {
        inputPath: payload.inputPath,
        inputPaths: payload.inputPaths,
        target: payload.target,
        action: payload.action,
        password: payload.password,
        ownerPassword: payload.ownerPassword,
        outputPath: payload.outputPath,
        dpi: payload.dpi,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertPdf(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )


  ipcMain.handle(
    'convert:image',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        inputPaths?: string[]
        target: string
        outputPath?: string
        quality?: number
      },
    ) => {
      const req: ConvertImageRequest = {
        inputPath: payload.inputPath,
        inputPaths: payload.inputPaths,
        target: payload.target,
        outputPath: payload.outputPath,
        quality: payload.quality,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertImage(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )


  ipcMain.handle(
    'convert:ocr',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        target?: string
        outputPath?: string
        lang?: string
        dpi?: number
      },
    ) => {
      const req: ConvertOcrRequest = {
        inputPath: payload.inputPath,
        target: payload.target,
        outputPath: payload.outputPath,
        lang: payload.lang,
        dpi: payload.dpi,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertOcr(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )


  ipcMain.handle(
    'convert:ebook',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        target: string
        outputPath?: string
      },
    ) => {
      const req: ConvertEbookRequest = {
        inputPath: payload.inputPath,
        target: payload.target,
        outputPath: payload.outputPath,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertEbook(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )



  ipcMain.handle(
    'convert:archive',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        inputPaths?: string[]
        target: string
        outputPath?: string
      },
    ) => {
      const req: ConvertArchiveRequest = {
        inputPath: payload.inputPath,
        inputPaths: payload.inputPaths,
        target: payload.target,
        outputPath: payload.outputPath,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertArchive(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )

  ipcMain.handle(
    'convert:subtitle',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        target: string
        outputPath?: string
      },
    ) => {
      const req: ConvertSubtitleRequest = {
        inputPath: payload.inputPath,
        target: payload.target,
        outputPath: payload.outputPath,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await convertSubtitle(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )

  ipcMain.handle('vocal:probe', async () => {
    return probeVocalEngine(true)
  })

  ipcMain.handle(
    'vocal:separate',
    async (
      evt,
      payload: {
        jobId: string
        inputPath: string
        outputDir?: string
        model?: SeparateVocalsRequest['model']
        backend?: SeparateVocalsRequest['backend']
        outputs?: SeparateVocalsRequest['outputs']
        device?: string
      },
    ) => {
      const req: SeparateVocalsRequest = {
        inputPath: payload.inputPath,
        outputDir: payload.outputDir,
        model: payload.model,
        backend: payload.backend,
        outputs: payload.outputs,
        device: payload.device,
      }
      return runWithJob(payload.jobId, async () => {
        const result = await separateVocals(req, payload.jobId, (progress) => {
          sendProgress(evt, payload.jobId, progress)
        })
        return remapIfCancelled(payload.jobId, result)
      })
    },
  )

  ipcMain.handle('convert:pause', async (_evt, jobId: string) => {
    if (!jobId) return { ok: false, message: '缺少任务编号' }
    return requestPause(jobId)
  })

  ipcMain.handle('convert:resume', async (_evt, jobId: string) => {
    if (!jobId) return { ok: false, message: '缺少任务编号' }
    return requestResume(jobId)
  })

  ipcMain.handle('convert:cancel', async (_evt, jobId: string) => {
    if (!jobId) return { ok: false, message: '缺少任务编号' }
    return requestCancel(jobId)
  })

  ipcMain.handle('shell:showItemInFolder', async (_evt, targetPath: string) => {
    if (!targetPath) return false
    shell.showItemInFolder(targetPath)
    return true
  })

  ipcMain.handle('shell:openPath', async (_evt, targetPath: string) => {
    if (!targetPath) return 'empty path'
    return shell.openPath(targetPath)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
  win = null
})
