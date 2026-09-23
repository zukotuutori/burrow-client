import { Fragment, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { PaneNode } from './layout'

interface Props {
  node: PaneNode
  renderPane: (paneId: string) => ReactNode
  onResize: (splitId: string, sizes: number[]) => void
}

export function SplitView({ node, renderPane, onResize }: Props) {
  if (node.type === 'pane') return <>{renderPane(node.id)}</>
  return <SplitContainer node={node} renderPane={renderPane} onResize={onResize} />
}

const MIN = 0.1

function SplitContainer({ node, renderPane, onResize }: Props & { node: Extract<PaneNode, { type: 'split' }> }) {
  const ref = useRef<HTMLDivElement>(null)
  const horizontal = node.dir === 'row'

  const startDrag = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault()
    const rect = ref.current!.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const start = horizontal ? e.clientX : e.clientY
    const initial = [...node.sizes]
    const pair = initial[i] + initial[i + 1]
    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total
      const a = Math.max(MIN, Math.min(pair - MIN, initial[i] + delta))
      const next = [...initial]
      next[i] = a
      next[i + 1] = pair - a
      onResize(node.id, next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={ref} className={`split split-${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <div className={`divider divider-${node.dir}`} onPointerDown={startDrag(i - 1)} />}
          <div className="split-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <SplitView node={child} renderPane={renderPane} onResize={onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}
