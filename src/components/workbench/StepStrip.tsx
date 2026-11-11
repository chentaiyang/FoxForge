/**
 * 转换流程步骤条（选择 → 识别 → 转换 → 保存）。带 backdrop-filter，
 * 因此标题栏上的任务/引擎浮层不能挂在步骤条内部，必须传送到 document.body。
 */
export type WorkbenchStep = 'select' | 'detect' | 'convert' | 'save'

const STEPS: { id: WorkbenchStep; label: string }[] = [
  { id: 'select', label: '选择文件' },
  { id: 'detect', label: '识别格式' },
  { id: 'convert', label: '开始转换' },
  { id: 'save', label: '保存结果' },
]

interface Props {
  active: WorkbenchStep
}

export default function StepStrip({ active }: Props) {
  const activeIdx = STEPS.findIndex((s) => s.id === active)

  return (
    <ol className="step-strip" aria-label="转换流程">
      {STEPS.map((step, idx) => {
        const state = idx < activeIdx ? 'done' : idx === activeIdx ? 'active' : 'todo'
        return (
          <li key={step.id} className={`step-item ${state}`}>
            <span className="step-index">{idx + 1}</span>
            <span className="step-label">{step.label}</span>
          </li>
        )
      })}
    </ol>
  )
}
