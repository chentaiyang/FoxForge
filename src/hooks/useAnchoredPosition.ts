/**
 * 把传送到 document.body 的浮层钉在锚点下方。
 * 标题栏和步骤条用了 backdrop-filter，会形成新的堆叠上下文，
 * 浮层若不 portal 出去并给予 z-index 400，就会被挡住。
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** 按锚点计算 fixed 坐标；默认 z-index 400，需配合 createPortal(..., document.body)。 */
export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  gap = 8,
  zIndex = 400,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setStyle({
        position: 'fixed',
        top: Math.round(r.bottom + gap),
        right: Math.max(8, Math.round(window.innerWidth - r.right)),
        zIndex,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, gap, zIndex])

  return style
}
