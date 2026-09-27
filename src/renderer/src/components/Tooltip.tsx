import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const DELAY_MS = 400
const GAP = 6
const MARGIN = 8

/**
 * Shows `title` attributes as styled tooltips. Native title tooltips are unreliable in Electron on macOS,
 * so the attribute is lifted off while hovering (to avoid a double tooltip) and put back afterwards.
 */
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let target: Element | null = null
    let text = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    const release = () => {
      clearTimeout(timer)
      // Put the title back unless React set a new one meanwhile.
      if (target && !target.hasAttribute('title')) target.setAttribute('title', text)
      target = null
      setTip(null)
    }
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.('[title]')
      if (!el || el === target) return
      release()
      text = el.getAttribute('title') ?? ''
      if (!text) return
      target = el
      el.removeAttribute('title')
      timer = setTimeout(() => {
        if (target === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() })
      }, DELAY_MS)
    }
    const out = (e: MouseEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) release()
    }

    document.addEventListener('mouseover', over)
    document.addEventListener('mouseout', out)
    document.addEventListener('mousedown', release, true)
    document.addEventListener('keydown', release, true)
    document.addEventListener('scroll', release, true)
    return () => {
      release()
      document.removeEventListener('mouseover', over)
      document.removeEventListener('mouseout', out)
      document.removeEventListener('mousedown', release, true)
      document.removeEventListener('keydown', release, true)
      document.removeEventListener('scroll', release, true)
    }
  }, [])

  // Measure the tooltip, then place it below the element (above if there is no room), inside the window.
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null)
    const { width, height } = ref.current.getBoundingClientRect()
    const r = tip.rect
    let top = r.bottom + GAP
    if (top + height > window.innerHeight - MARGIN) top = r.top - GAP - height
    const left = Math.min(Math.max(r.left + r.width / 2 - width / 2, MARGIN), window.innerWidth - width - MARGIN)
    setPos({ left, top })
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.text}
    </div>
  )
}
