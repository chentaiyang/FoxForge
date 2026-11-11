/**
 * 左侧导航。说明浮层必须 createPortal(..., document.body)，
 * 否则会被标题栏/步骤条的 backdrop-filter 堆叠上下文挡住。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'

const items = [
  { to: '/convert', label: '格式转换', desc: '工作台 · 批量转换', icon: '⇄' },
  { to: '/vocal', label: '人声分离', desc: 'Demucs 本机分离', icon: '♫' },
  { to: '/more', label: '更多', desc: '队列 · 插件 · 诊断', icon: '✦' },
  { to: '/settings', label: '设置', desc: '主题 · 渲染 · 引擎', icon: '⚙' },
]

type Flyout = { title: string; desc: string; top: number; left: number }

export default function Sidebar() {
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const hideTimer = useRef<number | null>(null)

  const cancelHide = () => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }

  const showAt = (el: HTMLElement, title: string, desc: string) => {
    cancelHide()
    const r = el.getBoundingClientRect()
    setFlyout({
      title,
      desc,
      top: Math.round(r.top + r.height / 2),
      left: Math.round(r.right + 10),
    })
  }

  const hideSoon = () => {
    cancelHide()
    hideTimer.current = window.setTimeout(() => setFlyout(null), 80)
  }

  useEffect(() => () => cancelHide(), [])

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            aria-label={`${item.label}，${item.desc}`}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            onMouseEnter={(e) => showAt(e.currentTarget, item.label, item.desc)}
            onMouseLeave={hideSoon}
            onFocus={(e) => showAt(e.currentTarget, item.label, item.desc)}
            onBlur={hideSoon}
          >
            <span className="nav-icon" aria-hidden>
              {item.icon}
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-info"
          aria-label="全部转换在本机完成，不上传文件"
          onMouseEnter={(e) => showAt(e.currentTarget, '本机转换', '全部转换在本机完成，不上传文件。')}
          onMouseLeave={hideSoon}
          onFocus={(e) => showAt(e.currentTarget, '本机转换', '全部转换在本机完成，不上传文件。')}
          onBlur={hideSoon}
        >
          本
        </button>
      </div>
      {flyout &&
        createPortal(
          <div
            className="nav-flyout"
            style={{ top: flyout.top, left: flyout.left }}
            role="tooltip"
          >
            <strong>{flyout.title}</strong>
            <span>{flyout.desc}</span>
          </div>,
          document.body,
        )}
    </aside>
  )
}
