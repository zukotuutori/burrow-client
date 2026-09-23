import { useState } from 'react'
import type { Profile } from '../../../shared/types'
import { Empty } from '../components/Empty'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { EditIcon, PlayIcon, PlusIcon, ServerIcon } from '../icons'
import { HostForm, newProfile } from './HostForm'

export function HostsView({ onConnect }: { onConnect: (profileId: string) => void }) {
  const { profiles, reload } = useData()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Profile | null>(null)

  const q = query.toLowerCase()
  const filtered = profiles
    .filter((p) => `${p.name} ${p.host} ${p.user} ${p.group}`.toLowerCase().includes(q))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  const groups = new Map<string, Profile[]>()
  for (const p of filtered) {
    const g = p.group || 'Ungrouped'
    groups.set(g, [...(groups.get(g) ?? []), p])
  }
  const exists = editing ? profiles.some((p) => p.id === editing.id) : false

  return (
    <div className="view">
      <header className="view-header">
        <h1>Hosts</h1>
        <input className="search" placeholder="Search hosts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing(newProfile())}>
          <PlusIcon /> New host
        </button>
      </header>
      {profiles.length === 0 ? (
        <Empty title="No hosts yet" text="Add your first server to get started." />
      ) : (
        [...groups].map(([group, items]) => (
          <section key={group}>
            <h3 className="group-title">{group}</h3>
            <div className="card-grid">
              {items.map((p) => (
                <div
                  key={p.id}
                  className="host-card"
                  tabIndex={0}
                  onDoubleClick={() => onConnect(p.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onConnect(p.id)}
                >
                  <div className="host-icon">
                    <ServerIcon />
                  </div>
                  <div className="host-info">
                    <div className="host-name">{p.name}</div>
                    <div className="host-sub">
                      {p.user}@{p.host}
                      {p.port !== 22 ? `:${p.port}` : ''}
                    </div>
                  </div>
                  <div className="host-actions">
                    <button className="icon-btn" title="Edit" onClick={() => setEditing(p)}>
                      <EditIcon />
                    </button>
                    <button className="icon-btn" title="Connect" onClick={() => onConnect(p.id)}>
                      <PlayIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      {editing && (
        <SidePanel title={exists ? 'Edit host' : 'New host'} onClose={() => setEditing(null)}>
          <HostForm
            profile={editing}
            onDone={() => {
              setEditing(null)
              void reload()
            }}
          />
        </SidePanel>
      )}
    </div>
  )
}
