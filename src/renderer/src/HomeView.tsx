import { useState, type ReactNode } from 'react'
import { api } from './api'
import { useData } from './data'
import { BookIcon, BurrowMark, CodeIcon, CoffeeIcon, KeyIcon, LockIcon, ServerIcon, SettingsIcon, ShieldIcon, TerminalIcon } from './icons'
import { useAction } from './toast'
import { HostsView } from './views/HostsView'
import { KeychainView } from './views/KeychainView'
import { KnownHostsView } from './views/KnownHostsView'
import { SettingsView } from './views/SettingsView'
import { SnippetsView } from './views/SnippetsView'

type Section = 'hosts' | 'keychain' | 'snippets' | 'knownHosts' | 'settings'

const NAV: { id: Section; label: string; hint: string; icon: ReactNode }[] = [
  { id: 'hosts', label: 'Hosts', hint: 'Saved servers', icon: <ServerIcon /> },
  { id: 'keychain', label: 'Keychain', hint: 'SSH keys', icon: <KeyIcon /> },
  { id: 'snippets', label: 'Snippets', hint: 'Saved commands', icon: <CodeIcon /> },
  { id: 'knownHosts', label: 'Known hosts', hint: 'Trusted server fingerprints', icon: <ShieldIcon /> },
  { id: 'settings', label: 'Settings', hint: 'Appearance, security and sync', icon: <SettingsIcon /> }
]

interface Props {
  onConnect: (profileId: string) => void
  onOpenLocal: () => void
  onLock: () => void
  visible: boolean
}

export function HomeView({ onConnect, onOpenLocal, onLock, visible }: Props) {
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
          <button key={n.id} className={`nav-item ${section === n.id ? 'active' : ''}`} title={n.hint} onClick={() => setSection(n.id)}>
            {n.icon}
            {n.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="nav-item" title="Open a shell on this computer in a new tab" onClick={onOpenLocal}>
          <TerminalIcon /> Open terminal
        </button>
        <button className="nav-item" title="Lock the vault and close all sessions" onClick={onLock}>
          <LockIcon /> Lock vault
        </button>
        <button
          className="nav-item"
          title="Open the documentation in your browser"
          onClick={() => void api.openExternal('https://zukotuutori.dev/burrowclient/documentation')}
        >
          <BookIcon /> Documentation
        </button>
        <span className="app-version">v{__APP_VERSION__}</span>
      </nav>
      <main className="home-main">
        {loadErrors.map((e) => (
          <div key={e.file} className="banner">
            <span className="spacer">{e.file} could not be read. Changes to it are blocked until you reset it.</span>
            <button title="Back up the unreadable file and start it fresh" onClick={() => reset(e.file)}>Reset</button>
          </div>
        ))}
        {section === 'hosts' && <HostsView onConnect={onConnect} visible={visible} />}
        {section === 'keychain' && <KeychainView />}
        {section === 'snippets' && <SnippetsView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'settings' && <SettingsView />}
      </main>
      {section === 'hosts' && (
        <button
          className="kofi-btn"
          title="Open Ko-fi in your browser"
          onClick={() => void api.openExternal('https://ko-fi.com/zukotuutori')}
        >
          <CoffeeIcon /> Support me on Ko-fi
        </button>
      )}
    </div>
  )
}
