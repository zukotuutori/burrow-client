import { useLayoutEffect, useRef } from 'react'
import { SHORTCUT_LABELS } from './shortcuts'
import { useHostStatus, type TerminalHost } from './terminalHost'

export function PaneSlot({ host, focused, onClose }: { host: TerminalHost; focused: boolean; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null)
  const status = useHostStatus(host)

  useLayoutEffect(() => {
    host.attach(slot.current!)
    return () => host.detach()
  }, [host])

  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={() => host.onFocus?.()}>
      <div ref={slot} className="pane-term" />
      {status.state === 'connecting' && (
        <div className="pane-overlay">
          <div className="spinner" />
          Connecting…
        </div>
      )}
      {status.state === 'closed' && (
        <div className="pane-overlay">
          <p>{status.reason}</p>
          <div className="actions">
            <button title="Close this pane" onClick={onClose}>Close</button>
            <button className="primary" title={host.profileId ? 'Connect to the host again' : 'Start a new local shell'} onClick={() => void host.connect()}>
              {host.profileId ? 'Reconnect' : 'Restart'}
            </button>
          </div>
        </div>
      )}
      <button className="pane-close" title={`Close pane (${SHORTCUT_LABELS.closePane})`} aria-label="Close pane" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
