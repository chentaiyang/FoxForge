/**
 * 简易进度条，供转换页和工作台展示当前任务百分比。
 */
interface Props {
  value: number
  label?: string
}

export default function ProgressMock({ value, label }: Props) {
  return (
    <div className="progress-block">
      {label && <div className="progress-label">{label}</div>}
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <div className="progress-pct">{Math.round(value)}%</div>
    </div>
  )
}
