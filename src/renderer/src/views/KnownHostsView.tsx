import { api } from '../api'
import { Empty } from '../components/Empty'
import { useData } from '../data'
import { ShieldIcon } from '../icons'
import { useAction } from '../toast'

export function KnownHostsView() {
  const { knownHosts, reload } = useData()
  const run = useAction()
  const entries = Object.entries(knownHosts).sort(([a], [b]) => a.localeCompare(b))

  const remove = async (id: string) => {
    if (!confirm(`Forget ${id}? You will be asked to trust it again on the next connection.`)) return
    if (await run(() => api.knownHosts.remove(id))) void reload()
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Known hosts</h1>
      </header>
      <p className="muted">Servers you trusted. Burrow warns you when one of them presents a different key.</p>
      {entries.length === 0 ? (
        <Empty title="No known hosts" text="Hosts show up here after you trust them on the first connection." />
      ) : (
        <div className="list">
          {entries.map(([id, h]) => (
            <div key={id} className="list-row">
              <div className="list-icon">
                <ShieldIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{id}</div>
                <div className="list-sub mono">
                  {h.algo} · {h.fingerprint}
                </div>
              </div>
              <span className="muted">{new Date(h.addedAt).toLocaleDateString()}</span>
              <button className="danger ghost" title="Forget this host key. You will be asked to trust it again on the next connection." onClick={() => remove(id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
