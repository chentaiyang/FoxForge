/**
 * 设置页：主题、语言、性能和引擎健康，以及关于「灵狐工坊 / 灵灵」的说明。
 *
 * 「高级渲染」标签不要写成「关闭高级渲染」；右侧下拉是开启/关闭。
 * 改动经 update 写入 mediaforge-settings 并应用到 DOM 后，再弹出 toast，不要提前报成功。
 *
 * 引擎计数就绪数 / 总数里，「特殊音乐模块」永远是 optional、从不 ready，但仍计入分母。
 */
import { useSettingsContext } from '../hooks/SettingsContext'
import type { AppSettings, ThemeMode } from '../hooks/useSettings'
import { defaultConcurrency } from '../hooks/useSettings'
import { useEngineHealth } from '../hooks/useEngineHealth'
import { useToast } from '../hooks/ToastContext'

const themes: { id: ThemeMode; label: string; desc: string }[] = [
  { id: 'system', label: '跟随系统', desc: '自动匹配系统浅色或深色' },
  { id: 'light', label: '浅色', desc: '明亮清爽的工作界面' },
  { id: 'dark', label: '深色', desc: '低眩光，适合夜间使用' },
]

const statusLabel = {
  ready: '就绪',
  missing: '未接入',
  optional: '可选',
} as const

function effectsApplied(reduceEffects: boolean) {
  return document.documentElement.dataset.effects === (reduceEffects ? 'off' : 'on')
}

function themeApplied(theme: ThemeMode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const expectDark = theme === 'dark' || (theme === 'system' && prefersDark)
  return document.documentElement.dataset.theme === (expectDark ? 'dark' : 'light')
}

/** 设置页。 */
export default function SettingsPage() {
  const { settings, update, reset } = useSettingsContext()
  const { engines, loading, error: probeError, refresh, readyCount } = useEngineHealth()
  const toast = useToast()

  // 先 update 落盘并应用到 DOM，再在下一帧检查后 toast，避免还没写完就报成功
  const applyUpdate = (patch: Partial<AppSettings>) => {
    const changed = (Object.keys(patch) as (keyof AppSettings)[]).some(
      (key) => settings[key] !== patch[key],
    )
    if (!changed) return
    const next = update(patch)
    requestAnimationFrame(() => {
      let ok = true
      if (patch.reduceEffects !== undefined) ok = effectsApplied(next.reduceEffects)
      if (patch.theme !== undefined) ok = ok && themeApplied(next.theme)
      if (ok) toast.success('设置成功')
      else toast.error('设置未生效')
    })
  }

  const applyReset = () => {
    const next = reset()
    requestAnimationFrame(() => {
      if (effectsApplied(next.reduceEffects) && themeApplied(next.theme)) {
        toast.success('已恢复默认设置')
      } else {
        toast.error('设置未生效')
      }
    })
  }

  const onRefreshEngines = async () => {
    const result = await refresh()
    if (result.ok) toast.success(`探测完成，就绪 ${result.readyCount}/${result.total}`)
    else toast.error(result.error || '探测失败')
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>外观、语言、性能与引擎状态，保存在本机。</p>
        </div>
      </header>

      <section className="panel settings-stack">
        <div className="settings-group">
          <h3>外观主题</h3>
          <div className="theme-grid">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-card${settings.theme === t.id ? ' active' : ''}`}
                onClick={() => applyUpdate({ theme: t.id })}
              >
                <div className={`theme-preview theme-${t.id}`} aria-hidden>
                  <span className="theme-preview-side" />
                  <span className="theme-preview-main">
                    <span className="theme-preview-bar" />
                    <span className="theme-preview-bar short" />
                  </span>
                </div>
                <strong>{t.label}</strong>
                <span>{t.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <h3>语言</h3>
          <label className="field field-narrow">
            <span>界面语言</span>
            <select
              value={settings.language}
              onChange={(e) => applyUpdate({ language: e.target.value })}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>
        </div>

        <div className="settings-group">
          <h3>性能</h3>
          {/* 标签保持「高级渲染」，不要写成「关闭高级渲染」；开关键在右侧下拉 */}
          <label className="switch-row">
            <div>
              <strong>高级渲染</strong>
              <p>毛玻璃和动画效果。低性能电脑可选择关闭。</p>
            </div>
            <select
              className="switch-select"
              value={settings.reduceEffects ? 'off' : 'on'}
              onChange={(e) => applyUpdate({ reduceEffects: e.target.value === 'off' })}
              aria-label="高级渲染"
            >
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          </label>
          <label className="switch-row" style={{ marginTop: 16 }}>
            <div>
              <strong>同时转换数</strong>
              <p>多个文件时并行转换。Office 文档和图片会自动排队，避免引擎冲突。</p>
            </div>
            <select
              className="switch-select"
              style={{ width: 148 }}
              value={String(settings.concurrency)}
              onChange={(e) => applyUpdate({ concurrency: Number(e.target.value) })}
              aria-label="同时转换数"
            >
              <option value="0">自动（{defaultConcurrency()}）</option>
              <option value="1">1（逐个）</option>
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </label>
        </div>

        <div className="settings-group">
          <div className="settings-group-head">
            <h3>引擎健康</h3>
            <span className="muted">{loading ? '正在探测…' : `就绪 ${readyCount}/${engines.length}`}</span>
            <button type="button" className="btn ghost" onClick={() => void onRefreshEngines()} disabled={loading}>
              重新探测
            </button>
          </div>
          {probeError && (
            <div className="banner error" style={{ marginBottom: 12 }}>
              {probeError}
            </div>
          )}
          <div className="engine-health-grid">
            {engines.map((eng) => (
              <div key={eng.id} className={`engine-pill status-${eng.status}`}>
                <div className="engine-pill-top">
                  <strong>{eng.name}</strong>
                  <span className="engine-status">{statusLabel[eng.status]}</span>
                </div>
                <span className="muted">{eng.covers}</span>
                {eng.version && <span className="muted">版本 {eng.version}</span>}
                {eng.detail && <span className="engine-detail">{eng.detail}</span>}
                {eng.path && (
                  <span className="path-text" title={eng.path}>
                    {eng.path}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="settings-group">
          <h3>关于</h3>
          <div className="about-card">
            <img className="about-mascot" src="./mascot-bust.png" alt="灵灵" />
            <div className="about-card-copy">
              <strong>灵狐工坊 FoxForge</strong>
              <p>版本 0.1.1 · Electron + React + TypeScript</p>
              <p className="muted">吉祥物灵灵。完整转换在本地完成；网页版以后只保留轻功能。</p>
            </div>
            <button type="button" className="btn ghost" onClick={applyReset}>
              恢复默认设置
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
