/**
 * 自定义标题栏：左侧是灵灵胸像和「灵狐工坊 / FoxForge」，右侧是引擎状态与任务进度圆。
 * 标题栏使用了 backdrop-filter，浮层必须传送到 document.body，否则会被堆叠上下文挡住。
 */
import EngineStatus from './EngineStatus'
import TransferOrb from './TransferOrb'

export default function TitleBar() {
  return (
    <header className="title-bar" data-tauri-drag-region>
      <div className="title-bar-brand">
        <img className="brand-mark" src="/mascot-bust.png" alt="灵灵" />
        <div>
          <div className="brand-name">灵狐工坊</div>
          <div className="brand-sub">FoxForge · v0.1.1</div>
        </div>
      </div>
      <div className="title-bar-actions">
        <EngineStatus />
        <TransferOrb />
      </div>
    </header>
  )
}
