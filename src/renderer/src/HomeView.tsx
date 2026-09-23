import { useState, type ReactNode } from 'react'
import { api } from './api'
import { useData } from './data'
import { BurrowMark, CodeIcon, KeyIcon, LockIcon, ServerIcon, SettingsIcon, ShieldIcon } from './icons'
import { useAction } from './toast'
import { HostsView } from './views/HostsView'
import { KeychainView } from './views/KeychainView'
import { KnownHostsView } from './views/KnownHostsView'
import { SettingsView } from './views/SettingsView'
import { SnippetsView } from './views/SnippetsView'

type Section = 'hosts' | 'keychain' | 'snippets' | 'knownHosts' | 'settings'

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'hosts', label: 'Hosts', icon: <ServerIcon /> },
  { id: 'keychain', label: 'Keychain', icon: <KeyIcon /> },
  { id: 'snippets', label: 'Snippets', icon: <CodeIcon /> },
  { id: 'knownHosts', label: 'Known hosts', icon: <ShieldIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> }
]

export function HomeView({ onConnect, onLock }: { onConnect: (profileId: string) => void; onLock: () => void }) {
  const [section, setSection] = useState<Section>('hosts')
  const { loadErrors, reload } = useData()
  const run = useAction()

  const reset = async (file: string) => {
    if (!confirm(`Reset ${file}? A backup copy is kept next to it.`)) return
    if (await run(() => api.files.reset(file), `${file} was reset`)) void reload()
  }

  return (
    <div className="home">
      <nav className="sidebar">
        <div className="brand">
          <BurrowMark /> Burrow
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => setSection(n.id)}>
            {n.icon}
            {n.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="nav-item" onClick={onLock}>
          <LockIcon /> Lock vault
        </button>
      </nav>
      <main className="home-main">
        {loadErrors.map((e) => (
          <div key={e.file} className="banner">
            <span className="spacer">{e.file} could not be read. Changes to it are blocked until you reset it.</span>
            <button onClick={() => reset(e.file)}>Reset</button>
          </div>
        ))}
        {section === 'hosts' && <HostsView onConnect={onConnect} />}
        {section === 'keychain' && <KeychainView />}
        {section === 'snippets' && <SnippetsView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
