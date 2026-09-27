import { useState } from 'react'
import type { Snippet } from '../../../shared/types'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { PlusIcon } from '../icons'
import { SnippetForm } from '../views/SnippetsView'

/** `profileId` is null in a local terminal, where only snippets for all hosts are listed. */
export function SnippetsDrawer({ profileId, onSend }: { profileId: string | null; onSend: (command: string) => void }) {
  const { snippets, reload } = useData()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<Snippet | null>(null)
  const q = query.toLowerCase()
  const forHost = (s: Snippet) => !!profileId && !!s.profileIds?.includes(profileId)
  const list = snippets
    .filter((s) => !s.profileIds || forHost(s))
    .filter((s) => `${s.name} ${s.command}`.toLowerCase().includes(q))
    .sort((a, b) => Number(forHost(b)) - Number(forHost(a)))

  return (
    <aside className="drawer">
      <header className="drawer-header">
        <span className="spacer">Snippets</span>
        {profileId && (
          <button
            className="icon-btn"
            title="New snippet for this host"
            onClick={() => setCreating({ id: crypto.randomUUID(), name: '', command: '', profileIds: [profileId] })}
          >
            <PlusIcon />
          </button>
        )}
      </header>
      <input className="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="drawer-list">
        {list.map((s) => (
          <button key={s.id} className="snippet-item" title={s.command} onClick={() => onSend(s.command)}>
            <div className="list-title">
              {s.name}
              {forHost(s) && <span className="tag host-tag">this host</span>}
            </div>
            <div className="list-sub mono">{s.command}</div>
          </button>
        ))}
        {list.length === 0 && (
          <p className="muted pad">
            {profileId ? 'No snippets for this host yet. Use + to add one.' : 'No snippets for all hosts yet.'}
          </p>
        )}
      </div>
      {creating && (
        <SidePanel title="New snippet for this host" onClose={() => setCreating(null)}>
          <SnippetForm
            snippet={creating}
            exists={false}
            onDone={() => {
              setCreating(null)
              void reload()
            }}
          />
        </SidePanel>
      )}
    </aside>
  )
}
