/**
 * 转换失败说明：用 errorCatalog 把错误码翻译成「可能原因」，详情默认折叠。
 */
import { useState } from 'react'
import { classifyError } from '../data/errorCatalog'

interface Props {
  message?: string | null
  code?: string | null
  detail?: string | null
  compact?: boolean
  onViewDetails?: () => void
}

export default function FailureNotice({ message, code, detail, compact, onViewDetails }: Props) {
  const [open, setOpen] = useState(false)
  const entry = classifyError(message, code)
  const raw = (detail || message || '').trim()
  const showRaw = raw && raw !== entry.reason && !raw.startsWith(`可能原因：${entry.reason}`)

  return (
    <div className={`fail-notice${compact ? ' is-compact' : ''}`}>
      <p className="fail-reason">可能原因：{entry.reason}</p>
      <button
        type="button"
        className="fail-detail-btn"
        onClick={() => {
          setOpen((v) => !v)
          onViewDetails?.()
        }}
      >
        {open ? '收起详情' : '查看详情'}
      </button>
      {open && (
        <div className="fail-detail">
          <div className="fail-code">{entry.code}</div>
          {entry.hint && <p className="fail-hint">{entry.hint}</p>}
          {showRaw && <pre>{raw}</pre>}
        </div>
      )}
    </div>
  )
}
