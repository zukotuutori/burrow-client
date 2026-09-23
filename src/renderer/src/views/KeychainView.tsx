import { useState, type FormEvent } from 'react'
import type { KeyType } from '../../../shared/types'
import { api } from '../api'
import { Empty } from '../components/Empty'
import { Field } from '../components/Field'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { KeyIcon, PlusIcon } from '../icons'
import { useAction } from '../toast'

export function KeychainView() {
  const { keys, reload } = useData()
  const run = useAction()
  const [mode, setMode] = useState<'generate' | 'import' | null>(null)
  const done = () => {
    setMode(null)
    void reload()
  }
  const remove = async (id: string, name: string) => {
    if (confirm(`Delete key "${name}"? This cannot be undone.`) && (await run(() => api.keys.remove(id)))) void reload()
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Keychain</h1>
        <span className="spacer" />
        <button onClick={() => setMode('import')}>Import</button>
        <button className="primary" onClick={() => setMode('generate')}>
          <PlusIcon /> Generate key
        </button>
      </header>
      {keys.length === 0 ? (
        <Empty title="No keys yet" text="Generate a new key or import an existing private key." />
      ) : (
        <div className="list">
          {keys.map((k) => (
            <div key={k.id} className="list-row">
              <div className="list-icon">
                <KeyIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{k.name}</div>
                <div className="list-sub mono">
                  {k.type} · {k.fingerprint}
                </div>
              </div>
              <button onClick={() => run(() => navigator.clipboard.writeText(k.publicKey), 'Public key copied')}>
                Copy public key
              </button>
              <button className="danger ghost" onClick={() => remove(k.id, k.name)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {mode && (
        <SidePanel title={mode === 'generate' ? 'Generate key' : 'Import key'} onClose={() => setMode(null)}>
          {mode === 'generate' ? <GenerateKeyForm onDone={done} /> : <ImportKeyForm onDone={done} />}
        </SidePanel>
      )}
    </div>
  )
}

function GenerateKeyForm({ onDone }: { onDone: () => void }) {
  const run = useAction()
  const [name, setName] = useState('')
  const [type, setType] = useState<KeyType>('ed25519')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const ok = await run(() => api.keys.generate(name, type), 'Key created')
    setBusy(false)
    if (ok) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" />
      </Field>
      <Field label="Type" hint="Ed25519 is the modern default. Pick RSA only for old servers without Ed25519 support.">
        <div className="segmented">
          <button type="button" className={type === 'ed25519' ? 'on' : ''} onClick={() => setType('ed25519')}>
            Ed25519
          </button>
          <button type="button" className={type === 'rsa' ? 'on' : ''} onClick={() => setType('rsa')}>
            RSA 4096
          </button>
        </div>
      </Field>
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </form>
  )
}

function ImportKeyForm({ onDone }: { onDone: () => void }) {
  const run = useAction()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const load = () =>
    run(async () => {
      const text = await api.keys.readFile()
      if (text !== null) setKey(text)
    })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => api.keys.importKey(name, key, passphrase || undefined), 'Key imported')) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Private key"
        hint={
          <button type="button" className="link" onClick={load}>
            Load from file…
          </button>
        }
      >
        <textarea
          className="mono"
          required
          rows={8}
          spellCheck={false}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Field label="Passphrase" hint="Only needed if the key is encrypted. It is stored in the vault.">
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </Field>
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary">
          Import
        </button>
      </div>
    </form>
  )
}
