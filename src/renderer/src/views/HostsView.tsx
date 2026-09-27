import { useCallback, useEffect, useRef, useState } from 'react'
import type { Profile } from '../../../shared/types'
import { api } from '../api'
import { Empty } from '../components/Empty'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { EditIcon, PlayIcon, PlusIcon, RefreshIcon, ServerIcon } from '../icons'
import { HostForm, newProfile } from './HostForm'

/**
 * Checks every host when the view opens, when it becomes visible again and when refresh is called,
 * plus any host that was added or got a new address. A missing entry means the check has not finished yet.
 */
function useHostStatus(profiles: Profile[], enabled: boolean, visible: boolean) {
  const [status, setStatus] = useState<Record<string, boolean>>({})
  const [round, setRound] = useState(0)
  const profilesRef = useRef(profiles)
  profilesRef.current = profiles
  // Address each host was last checked with, and a counter so results of an older round are dropped.
  const checked = useRef(new Map<string, string>())
  const generation = useRef(0)

  const check = useCallback((list: Profile[]) => {
    const gen = generation.current
    for (const p of list) {
      checked.current.set(p.id, `${p.host}:${p.port}`)
      api.profiles.reachable(p.id).then(
        (ok) => gen === generation.current && setStatus((s) => ({ ...s, [p.id]: ok })),
        () => {}
      )
    }
  }, [])

  useEffect(() => {
    generation.current++
    checked.current.clear()
    if (!enabled) return setStatus({})
    if (visible) check(profilesRef.current)
  }, [enabled, visible, round, check])

  useEffect(() => {
    if (enabled) check(profiles.filter((p) => checked.current.get(p.id) !== `${p.host}:${p.port}`))
  }, [profiles, enabled, check])

  const refresh = useCallback(() => {
    setStatus({})
    setRound((r) => r + 1)
  }, [])
  return { status, refresh }
}

export function HostsView({ onConnect, visible }: { onConnect: (profileId: string) => void; visible: boolean }) {
  const { profiles, settings, reload } = useData()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Profile | null>(null)
  const { status, refresh } = useHostStatus(profiles, settings.showHostStatus, visible)

  const q = query.toLowerCase()
  const filtered = profiles
    .filter((p) => `${p.name} ${p.host} ${p.user} ${p.group} ${p.note ?? ''}`.toLowerCase().includes(q))
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
        {settings.showHostStatus && (
          <button className="icon-btn" title="Check host status" onClick={refresh}>
            <RefreshIcon />
          </button>
        )}
        <button className="primary" title="Add a new host" onClick={() => setEditing(newProfile())}>
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
                  {settings.showHostStatus && (
                    <span
                      className={`dot ${p.id in status ? (status[p.id] ? 'connected' : 'closed') : ''}`}
                      title={p.id in status ? (status[p.id] ? 'Reachable' : 'Not reachable') : 'Checking…'}
                    />
                  )}
                  <div className="host-icon">
                    <ServerIcon />
                  </div>
                  <div className="host-info">
                    <div className="host-name">{p.name}</div>
                    <div className="host-sub">
                      {p.user}@{p.host}
                      {p.port !== 22 ? `:${p.port}` : ''}
                    </div>
                    {p.note && (
                      <div className="host-sub" title={p.note}>
                        {p.note}
                      </div>
                    )}
                  </div>
                  <div className="host-actions">
                    <button className="icon-btn" title="Edit host" onClick={() => setEditing(p)}>
                      <EditIcon />
                    </button>
                    <button className="icon-btn" title="Connect in a new tab" onClick={() => onConnect(p.id)}>
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
