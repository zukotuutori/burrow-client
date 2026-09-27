import { useEffect, useState, type FormEvent } from 'react'
import type { Prompt } from '../../shared/types'
import { api } from './api'
import { Modal } from './components/Modal'

/** Shows host key, password and passphrase prompts that the main process requests while connecting. */
export function PromptDialog() {
  const [queue, setQueue] = useState<{ id: string; prompt: Prompt }[]>([])
  const [value, setValue] = useState('')
  const [save, setSave] = useState(false)

  useEffect(
    () =>
      api.prompts.onRequest((id, prompt) => {
        // Core never asks about matching keys, but answer defensively instead of showing an empty dialog.
        if (prompt.kind === 'hostkey' && prompt.check.state === 'match') return api.prompts.answer(id, { ok: true })
        setQueue((q) => [...q, { id, prompt }])
      }),
    []
  )

  const current = queue[0]
  if (!current) return null

  const answer = (ok: boolean) => {
    api.prompts.answer(current.id, { ok, value: ok ? value : undefined, save: ok && save })
    setValue('')
    setSave(false)
    setQueue((q) => q.slice(1))
  }

  const p = current.prompt
  if (p.kind === 'hostkey') {
    const target = `${p.host}:${p.port}`
    if (p.check.state === 'changed') {
      return (
        <Modal key={current.id} warning>
          <h3>Host key changed for {target}</h3>
          <p>
            The server presents a different key than the one you trusted before. This can mean the server was reinstalled,
            or that someone is intercepting the connection. Only continue if you know why the key changed.
          </p>
          <div className="field">
            <span className="field-label">Trusted key</span>
            <div className="fp mono">{p.check.oldFingerprint}</div>
          </div>
          <div className="field">
            <span className="field-label">New key ({p.check.algo})</span>
            <div className="fp mono">{p.check.fingerprint}</div>
          </div>
          <div className="actions">
            <button className="danger ghost" title="Save the new host key and connect anyway" onClick={() => answer(true)}>
              Replace & connect
            </button>
            <button className="primary" title="Do not connect" autoFocus onClick={() => answer(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )
    }
    if (p.check.state === 'unknown') {
      return (
        <Modal key={current.id}>
          <h3>Trust {target}?</h3>
          <p className="muted">This is the first connection to this host. Check that the fingerprint matches the server.</p>
          <div className="field">
            <span className="field-label">{p.check.algo}</span>
            <div className="fp mono">{p.check.fingerprint}</div>
          </div>
          <div className="actions">
            {/* Cancel has focus so a stray Enter never trusts a host; trusting takes a deliberate click. */}
            <button title="Do not connect" autoFocus onClick={() => answer(false)}>
              Cancel
            </button>
            <button className="primary" title="Save this host key and connect" onClick={() => answer(true)}>
              Trust & connect
            </button>
          </div>
        </Modal>
      )
    }
    return null
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    answer(true)
  }
  return (
    <Modal key={current.id}>
      <form className="form" onSubmit={submit}>
        <h3>{p.kind === 'password' ? 'Password' : 'Key passphrase'}</h3>
        <p className="muted">{p.label}</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save to vault
        </label>
        <div className="actions">
          <button type="button" title="Cancel the connection" onClick={() => answer(false)}>
            Cancel
          </button>
          <button className="primary" type="submit" title="Connect with this secret">
            Connect
          </button>
        </div>
      </form>
    </Modal>
  )
}
