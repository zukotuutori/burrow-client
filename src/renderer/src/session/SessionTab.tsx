import { useCallback, useEffect, useRef, useState } from 'react'
import { useData } from '../data'
import { CodeIcon, FolderIcon, SplitDownIcon, SplitRightIcon } from '../icons'
import { pane, paneIds, removePane, resizeSplit, splitPane, type PaneNode } from './layout'
import { PaneSlot } from './PaneSlot'
import { SftpBrowser } from './SftpBrowser'
import { matchShortcut, SHORTCUT_LABELS, type ShortcutAction } from './shortcuts'
import { SnippetsDrawer } from './SnippetsDrawer'
import { SplitView } from './SplitView'
import { TerminalHost, useHostStatus } from './terminalHost'

export type TabStatus = 'connecting' | 'connected' | 'closed'

interface Props {
  /** Null for a local terminal. */
  profileId: string | null
  active: boolean
  onStatus: (status: TabStatus) => void
  onEmpty: () => void
}

export function SessionTab({ profileId, active, onStatus, onEmpty }: Props) {
  const { settings, profiles } = useData()
  const profile = profiles.find((p) => p.id === profileId)
  const hosts = useRef(new Map<string, TerminalHost>())
  const [initialId] = useState(() => crypto.randomUUID())
  const [layout, setLayout] = useState<PaneNode>(() => pane(initialId))
  const [focused, setFocused] = useState<string>(initialId)
  const [showSnippets, setShowSnippets] = useState(false)
  const [showSftp, setShowSftp] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const getHost = useCallback(
    (paneId: string) => {
      let host = hosts.current.get(paneId)
      if (!host) {
        host = new TerminalHost(profileId, settingsRef.current)
        host.onFocus = () => setFocused(paneId)
        hosts.current.set(paneId, host)
      }
      return host
    },
    [profileId]
  )

  const closePane = useCallback(
    (paneId: string) => {
      hosts.current.get(paneId)?.dispose()
      hosts.current.delete(paneId)
      const next = removePane(layout, paneId)
      if (!next) return onEmpty()
      setLayout(next)
      setFocused((f) => (f === paneId ? paneIds(next)[0] : f))
    },
    [layout, onEmpty]
  )

  const act = useCallback(
    (action: ShortcutAction) => {
      if (action === 'closePane') return closePane(focused)
      const id = crypto.randomUUID()
      setLayout((l) => splitPane(l, focused, action === 'splitRight' ? 'row' : 'col', id))
      setFocused(id)
    },
    [closePane, focused]
  )

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      // A prompt or side panel is open, e.g. the host key dialog or the new-snippet form.
      if (document.querySelector('.modal-backdrop, .panel-backdrop')) return
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      act(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, act])

  useEffect(() => {
    if (active) hosts.current.get(focused)?.focus()
  }, [active, focused])

  useEffect(() => {
    hosts.current.forEach((h) => h.applySettings(settings))
  }, [settings])

  useEffect(() => {
    const map = hosts.current
    return () => {
      map.forEach((h) => h.dispose())
      map.clear()
    }
  }, [])

  useEffect(() => {
    const list = paneIds(layout).map(getHost)
    const update = () => {
      const states = list.map((h) => h.status.state)
      onStatusRef.current(states.includes('connected') ? 'connected' : states.includes('connecting') ? 'connecting' : 'closed')
    }
    update()
    const subs = list.map((h) => h.subscribe(update))
    return () => subs.forEach((u) => u())
  }, [layout, getHost])

  // SFTP runs over the connection of the first pane in the layout.
  const firstHost = getHost(paneIds(layout)[0])
  const firstStatus = useHostStatus(firstHost)
  const sftpSession = firstStatus.state === 'connected' ? firstHost.sessionId : null

  const sendSnippet = (command: string) => {
    const host = hosts.current.get(focused)
    host?.send(command.replace(/\r?\n/g, '\r') + '\r')
    host?.focus()
  }

  return (
    <div className="session">
      <div className="session-toolbar">
        <span className="session-title">{profileId ? (profile?.name ?? 'Deleted host') : 'Local terminal'}</span>
        {profile && (
          <span className="muted">
            {profile.user}@{profile.host}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn" title={`Split right (${SHORTCUT_LABELS.splitRight})`} onClick={() => act('splitRight')}>
          <SplitRightIcon />
        </button>
        <button className="icon-btn" title={`Split down (${SHORTCUT_LABELS.splitDown})`} onClick={() => act('splitDown')}>
          <SplitDownIcon />
        </button>
        <button className={`toggle ${showSnippets ? 'on' : ''}`} onClick={() => setShowSnippets((s) => !s)}>
          <CodeIcon /> Snippets
        </button>
        {profileId && (
          <button className={`toggle ${showSftp ? 'on' : ''}`} onClick={() => setShowSftp((s) => !s)}>
            <FolderIcon /> SFTP
          </button>
        )}
      </div>
      <div className="session-body">
        <div className="session-terminals">
          <SplitView
            node={layout}
            onResize={(id, sizes) => setLayout((l) => resizeSplit(l, id, sizes))}
            renderPane={(id) => <PaneSlot key={id} host={getHost(id)} focused={id === focused} onClose={() => closePane(id)} />}
          />
        </div>
        {showSftp && profileId && <SftpBrowser sessionId={sftpSession} />}
        {showSnippets && <SnippetsDrawer profileId={profileId} onSend={sendSnippet} />}
      </div>
    </div>
  )
}
