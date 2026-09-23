import { useRef } from 'react'
import { BurrowMark } from './icons'
import type { TabStatus } from './session/SessionTab'

export interface SessionTabInfo {
  id: string
  profileId: string
  title: string
}

interface Props {
  tabs: SessionTabInfo[]
  active: string
  statuses: Record<string, TabStatus>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (tabs: SessionTabInfo[]) => void
}

export function TabBar({ tabs, active, statuses, onSelect, onClose, onReorder }: Props) {
  const dragId = useRef<string | null>(null)

  const drop = (targetId: string) => {
    const from = tabs.findIndex((t) => t.id === dragId.current)
    const to = tabs.findIndex((t) => t.id === targetId)
    dragId.current = null
    if (from < 0 || to < 0 || from === to) return
    const next = [...tabs]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  return (
    <div className="tabbar">
      <button className={`tab ${active === 'home' ? 'active' : ''}`} onClick={() => onSelect('home')}>
        <BurrowMark /> Vault
      </button>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${active === t.id ? 'active' : ''}`}
          draggable
          onDragStart={() => (dragId.current = t.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(t.id)}
          onClick={() => onSelect(t.id)}
          onAuxClick={(e) => e.button === 1 && onClose(t.id)}
        >
          <span className={`dot ${statuses[t.id] ?? 'connecting'}`} />
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
