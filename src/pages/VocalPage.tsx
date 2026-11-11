/**
 * 人声分离页：选择音轨与后端（Demucs / UVR / FFmpeg 简易），经 window.mediaForge.separateVocals 在本机处理。
 * 不处理平台加密音乐；那是健康清单里的可选项，应用内不破解。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import ProgressMock from '../components/ProgressMock'
import { useToast } from '../hooks/ToastContext'
import { useJobSession } from '../hooks/JobSessionContext'
import { classifyError, shortFailureToast } from '../data/errorCatalog'
import FailureNotice from '../components/FailureNotice'

type ModelId =
  | 'demucs-htdemucs'
  | 'demucs-htdemucs_ft'
  | 'ffmpeg-simple'
  | 'uvr-mdx'
  | 'uvr-vr'

type VocalProbe = {
  python: string | null
  demucsModuleOk: boolean
  demucsVersion?: string
  demucsCli: string | null
  installHint: string
  ffmpegFallbackReady: boolean
  uvrReady: boolean
  uvrDetail?: string
  uvrModel?: string
}

const MODELS: {
  id: ModelId
  name: string
  desc: string
  kind: 'demucs' | 'ffmpeg' | 'uvr'
}[] = [
  {
    id: 'demucs-htdemucs',
    name: 'Demucs · htdemucs',
    desc: 'Meta 开源四轨，质量稳，适合日常使用',
    kind: 'demucs',
  },
  {
    id: 'demucs-htdemucs_ft',
    name: 'Demucs · htdemucs_ft',
    desc: '微调版，人声更干净，速度更慢',
    kind: 'demucs',
  },
  {
    id: 'ffmpeg-simple',
    name: 'FFmpeg · 简易分离',
    desc: '中心/侧声道近似，质量远不如 Demucs，仅作降级',
    kind: 'ffmpeg',
  },
  {
    id: 'uvr-mdx',
    name: 'UVR · MDX-Net',
    desc: '本机 ONNX Runtime，CPU 可跑；默认仍建议 Demucs',
    kind: 'uvr',
  },
  {
    id: 'uvr-vr',
    name: 'UVR · VR Architecture',
    desc: '尚未接入，不会假装可用',
    kind: 'uvr',
  },
]

function modelAvailable(id: ModelId, probe: VocalProbe | null): boolean {
  const m = MODELS.find((x) => x.id === id)
  if (!m) return false
  if (m.kind === 'uvr') return m.id === 'uvr-mdx' && Boolean(probe?.uvrReady)
  if (m.kind === 'ffmpeg') return Boolean(probe?.ffmpegFallbackReady)
  return Boolean(probe?.demucsModuleOk)
}

/** 人声分离页。 */
export default function VocalPage() {
  const [inputPath, setInputPath] = useState('')
  const [fileLabel, setFileLabel] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [model, setModel] = useState<ModelId>('demucs-htdemucs')
  const [outputs, setOutputs] = useState({
    vocals: true,
    instrumental: true,
    drums: false,
    bass: false,
    other: false,
  })
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [doneMsg, setDoneMsgState] = useState('')
  const [errorMsg, setErrorMsgState] = useState('')
  const [errorInfo, setErrorInfo] = useState<{ message: string; code?: string; detail?: string; jobId?: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const toast = useToast()
  const jobSession = useJobSession()
  const setDoneMsg = (msg: string) => {
    setDoneMsgState(msg)
    if (msg) toast.success(msg)
  }
  const setErrorMsg = (msg: string, extra?: { code?: string; detail?: string; jobId?: string }) => {
    setErrorMsgState(msg)
    if (!msg) {
      setErrorInfo(null)
      return
    }
    const entry = classifyError(msg, extra?.code)
    setErrorInfo({
      message: msg,
      code: extra?.code || entry.code,
      detail: extra?.detail || msg,
      jobId: extra?.jobId,
    })
    toast.error(shortFailureToast(msg, extra?.code || entry.code), {
      actionLabel: '查看详情',
      onAction: () => jobSession.openPopover(extra?.jobId),
    })
  }
  const [probe, setProbe] = useState<VocalProbe | null>(null)
  const [probeError, setProbeError] = useState('')
  const unsubRef = useRef<(() => void) | null>(null)

  const anyOutput = Object.values(outputs).some(Boolean)
  const api = typeof window !== 'undefined' ? window.mediaForge : undefined

  const refreshProbe = () => {
    setProbeError('')
    if (!api?.probeVocalEngine) {
      setProbe(null)
      setProbeError('不在 Electron 环境，无法探测 Demucs。')
      return
    }
    api
      .probeVocalEngine()
      .then((p) => setProbe(p as VocalProbe))
      .catch((e) => {
        setProbe(null)
        setProbeError(String(e))
      })
  }

  useEffect(() => {
    refreshProbe()
    return () => {
      unsubRef.current?.()
    }
  }, [])

  const demucsReady = Boolean(probe?.demucsModuleOk)
  const ffmpegReady = Boolean(probe?.ffmpegFallbackReady)

  useEffect(() => {
    if (!probe) return
    if (!modelAvailable(model, probe)) {
      if (demucsReady) setModel('demucs-htdemucs')
      else if (ffmpegReady) setModel('ffmpeg-simple')
    }
  }, [probe, model, demucsReady, ffmpegReady])

  const statusBanner = useMemo(() => {
    if (probeError) return { kind: 'error' as const, title: '探测失败', text: probeError }
    if (!probe) return { kind: 'muted' as const, title: '正在探测引擎', text: '正在检查本机 Demucs 与 FFmpeg…' }
    if (demucsReady) {
      return {
        kind: 'success' as const,
        title: 'Demucs 就绪',
        text: probe.demucsVersion ? `版本 ${probe.demucsVersion}` : '本机可用',
      }
    }
    return {
      kind: 'warn' as const,
      title: 'Demucs 未安装',
      text: ffmpegReady
        ? '可改用 FFmpeg 简易分离，质量有限；也可按下方指引安装 Demucs。'
        : 'Demucs 与 FFmpeg 都不可用，暂时无法分离。',
    }
  }, [probe, probeError, demucsReady, ffmpegReady])

  const pickFile = async () => {
    if (!api?.openFiles) return
    const paths = await api.openFiles([
      { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] },
    ])
    if (paths[0]) {
      setInputPath(paths[0])
      setFileLabel(paths[0].split(/[/\\]/).pop() || paths[0])
      setDoneMsg('')
      setErrorMsg('')
      setProgress(0)
    }
  }

  const pickOutDir = async () => {
    if (!api?.openDirectory) return
    const dir = await api.openDirectory()
    if (dir) {
      setOutputDir(dir)
      toast.success('已设置输出目录')
    }
  }

  const start = async () => {
    if (!api?.separateVocals || !inputPath || running || !anyOutput) return
    if (!modelAvailable(model, probe)) {
      setErrorMsg(
        model === 'uvr-vr'
          ? 'UVR · VR Architecture 尚未接入。请改用 Demucs 或 UVR · MDX-Net。'
          : model.startsWith('uvr')
            ? 'UVR · MDX-Net 未就绪。请运行 node scripts/ensure-uvr.mjs，或改用 Demucs。'
          : '所选模型当前不可用。',
        { code: 'E-VOCAL-MISSING' },
      )
      return
    }

    setRunning(true)
    setDoneMsg('')
    setErrorMsg('')
    setProgress(1)
    setProgressLabel('准备中…')

    unsubRef.current?.()
    unsubRef.current = api.onConvertProgress((ev) => {
      if (!ev.jobId.startsWith('vocal-')) return
      setProgress(ev.percent)
      if (ev.message) setProgressLabel(ev.message)
    })

    const nextJobId = `vocal-${Date.now()}`
    setJobId(nextJobId)
    jobSession.setQueuePaused(false)
    jobSession.registerJobs([
      {
        id: nextJobId,
        name: fileLabel || '人声分离',
        sourcePath: inputPath,
        target: '人声分离',
        label: '准备中…',
      },
    ])
    jobSession.updateJob(nextJobId, { status: 'running', percent: 1, label: '准备中…' })
    const backend =
      model === 'ffmpeg-simple' ? 'ffmpeg-simple' : model.startsWith('uvr') ? 'uvr' : 'demucs'

    try {
      const result = await api.separateVocals({
        jobId: nextJobId,
        inputPath,
        outputDir: outputDir || undefined,
        model,
        backend,
        outputs,
        device: 'cpu',
      })
      if (result.ok) {
        const paths = result.outputPaths?.length
          ? result.outputPaths
          : result.outputPath
            ? [result.outputPath]
            : []
        setProgress(100)
        setProgressLabel('完成')
        jobSession.updateJob(nextJobId, {
          status: 'completed',
          percent: 100,
          label: '完成',
          outputPath: paths[0],
        })
        setDoneMsg(
          [
            result.message || '分离完成',
            result.engineUsed ? `引擎：${result.engineUsed}` : '',
            paths.length ? `输出：\n${paths.join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      } else {
        const cancelled = result.errorCode === 'E-CANCELLED' || /任务已取消/.test(result.error || '')
        if (cancelled) {
          jobSession.updateJob(nextJobId, {
            status: 'cancelled',
            label: '已取消',
            errorCode: 'E-CANCELLED',
            errorReason: '任务已取消',
          })
          setProgressLabel('已取消')
        } else {
          const entry = classifyError(result.error, result.errorCode)
          jobSession.updateJob(nextJobId, {
            status: 'failed',
            label: entry.reason,
            errorCode: entry.code,
            errorReason: entry.reason,
            errorDetail: result.errorDetail || result.error,
          })
          setErrorMsg(result.error || '分离失败', {
            code: result.errorCode,
            detail: result.errorDetail || result.error,
            jobId: nextJobId,
          })
        }
      }
    } catch (e) {
      jobSession.updateJob(nextJobId, {
        status: 'failed',
        label: classifyError(String(e)).reason,
        errorCode: classifyError(String(e)).code,
        errorReason: classifyError(String(e)).reason,
        errorDetail: String(e),
      })
      setErrorMsg(String(e), { jobId: nextJobId })
    } finally {
      setRunning(false)
      unsubRef.current?.()
      unsubRef.current = null
    }
  }

  const openOut = () => {
    const firstLine = doneMsg
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('/') || /^[A-Za-z]:\\/.test(l))
    if (firstLine && api?.showItemInFolder) {
      api.showItemInFolder(firstLine)
      toast.success('已打开输出目录')
    } else if (outputDir && api?.openPath) {
      api.openPath(outputDir)
      toast.success('已打开输出目录')
    } else {
      toast.error('还没有可打开的输出')
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>人声分离</h1>
          <p>优先使用本机 Demucs；UVR · MDX-Net 在模型就绪时可选用（CPU）。未安装时可改用 FFmpeg 简易分离（质量有限）。</p>
        </div>
      </header>

      <section className="panel vocal-page">
        <div className={`status-bar status-bar-${statusBanner.kind}`}>
          <div className="status-bar-copy">
            <strong>{statusBanner.title}</strong>
            <span>{statusBanner.text}</span>
          </div>
          <button type="button" className="btn ghost" onClick={refreshProbe} disabled={running}>
            重新探测
          </button>
        </div>

        {!demucsReady && (
          <pre
            className="full-span"
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              padding: 12,
              borderRadius: 8,
              background: 'rgba(127,127,127,0.12)',
              overflow: 'auto',
            }}
          >
            {probe?.installHint ||
              '安装：python3 -m venv .venv-demucs && .venv-demucs/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu && .venv-demucs/bin/pip install demucs numpy torchaudio'}
          </pre>
        )}

        <div className="vocal-top">
        <div
          className="dropzone compact"
          onClick={() => !running && pickFile()}
          role="button"
          tabIndex={0}
        >
          <div className="dropzone-icon">♪</div>
          <h3>{fileLabel || '选择音频文件'}</h3>
          <p>{inputPath ? '点击可更换文件' : '支持 MP3、WAV、FLAC、M4A、OGG 等'}</p>
        </div>

        <div className="vocal-options">
          <h3>分离模型</h3>
          <div className="model-grid">
            {MODELS.map((m) => {
              const avail = modelAvailable(m.id, probe)
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`model-card${model === m.id ? ' active' : ''}`}
                  onClick={() => setModel(m.id)}
                  disabled={running || !avail}
                  title={avail ? '可用' : m.id === 'uvr-vr' ? '未接入' : m.kind === 'uvr' ? '未就绪' : '当前环境不可用'}
                >
                  <strong>
                    {m.name}
                    {!avail ? (m.id === 'uvr-vr' ? ' · 未接入' : m.kind === 'uvr' ? ' · 未就绪' : ' · 不可用') : ''}
                  </strong>
                  <span>{m.desc}</span>
                </button>
              )
            })}
          </div>

          <h3>输出目录（可选）</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn ghost" onClick={pickOutDir} disabled={running}>
              选择目录
            </button>
            <span className="path-text" title={outputDir || ''}>
              {outputDir || '默认写到音频同目录的 *_separated/'}
            </span>
          </div>

          <h3>输出轨道</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={outputs.vocals}
              onChange={(e) => setOutputs((o) => ({ ...o, vocals: e.target.checked }))}
            />
            <span>人声</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={outputs.instrumental}
              onChange={(e) => setOutputs((o) => ({ ...o, instrumental: e.target.checked }))}
            />
            <span>伴奏</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={outputs.drums}
              disabled={model === 'ffmpeg-simple'}
              onChange={(e) => setOutputs((o) => ({ ...o, drums: e.target.checked }))}
            />
            <span>鼓（仅 Demucs）</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={outputs.bass}
              disabled={model === 'ffmpeg-simple'}
              onChange={(e) => setOutputs((o) => ({ ...o, bass: e.target.checked }))}
            />
            <span>贝斯</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={outputs.other}
              disabled={model === 'ffmpeg-simple'}
              onChange={(e) => setOutputs((o) => ({ ...o, other: e.target.checked }))}
            />
            <span>其它</span>
          </label>

          <p className="hint">首次运行会下载模型，CPU 推理较慢是正常的。</p>

          <div className="convert-controls">
          <button
            type="button"
            className="btn primary"
            disabled={!inputPath || running || !anyOutput || !modelAvailable(model, probe)}
            onClick={start}
          >
            {running ? (jobSession.queuePaused ? '已暂停' : '分离中…') : '开始分离'}
          </button>
          {running && !jobSession.queuePaused && jobId && (
            <button type="button" className="btn ghost" onClick={() => void jobSession.pauseJob(jobId)}>
              暂停
            </button>
          )}
          {running && jobSession.queuePaused && jobId && (
            <button type="button" className="btn ghost" onClick={() => void jobSession.resumeJob(jobId)}>
              继续
            </button>
          )}
          {running && jobId && (
            <button type="button" className="btn ghost danger-text" onClick={() => void jobSession.cancelJob(jobId)}>
              取消
            </button>
          )}
          </div>
        </div>
        </div>

        {(running || progress > 0) && (
          <div className="full-span">
            <ProgressMock value={progress} label={progressLabel || (running ? (jobSession.queuePaused ? '已暂停' : '分离进度') : '上次结果')} />
          </div>
        )}
        {errorInfo && (
          <div className="full-span">
            <FailureNotice
              message={errorInfo.message}
              code={errorInfo.code}
              detail={errorInfo.detail}
              onViewDetails={() => jobSession.openPopover(errorInfo.jobId)}
            />
          </div>
        )}
        {doneMsg && (
          <div className="full-span" style={{ marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={openOut}>
              打开输出
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
