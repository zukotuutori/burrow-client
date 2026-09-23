import { useLayoutEffect, useRef } from 'react'
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
            <button onClick={onClose}>Close</button>
            <button className="primary" onClick={() => void host.connect()}>
              Reconnect
            </button>
          </div>
        </div>
      )}
      <button className="pane-close" title="Close pane" aria-label="Close pane" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
