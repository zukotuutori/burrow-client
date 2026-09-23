import { useEffect, useState, type FormEvent } from 'react'
import type { Profile } from '../../../shared/types'
import { api } from '../api'
import { Field } from '../components/Field'
import { useData } from '../data'
import { useAction } from '../toast'

export const newProfile = (): Profile => ({
  id: crypto.randomUUID(),
  name: '',
  group: '',
  host: '',
  port: 22,
  user: '',
  authType: 'password'
})

export function HostForm({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { keys, profiles } = useData()
  const run = useAction()
  const [p, setP] = useState(profile)
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const exists = profiles.some((x) => x.id === profile.id)
  const groups = [...new Set(profiles.map((x) => x.group).filter(Boolean))]

  useEffect(() => {
    if (exists) void api.profiles.hasPassword(profile.id).then(setHasPassword)
  }, [exists, profile.id])

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setP((x) => ({ ...x, [key]: value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pw = p.authType === 'password' && password ? password : undefined
    if (await run(() => api.profiles.save(p, pw))) onDone()
  }
  const remove = async () => {
    if (confirm(`Delete ${profile.name}?`) && (await run(() => api.profiles.remove(profile.id)))) onDone()
  }
  const forget = () =>
    run(async () => {
      await api.profiles.forgetPassword(profile.id)
      setHasPassword(false)
    }, 'Saved password removed')

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Label">
        <input autoFocus required value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Web server" />
      </Field>
      <Field label="Group">
        <input list="host-groups" value={p.group} onChange={(e) => set('group', e.target.value)} placeholder="Optional" />
        <datalist id="host-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
      <div className="row">
        <Field label="Host">
          <input required value={p.host} onChange={(e) => set('host', e.target.value)} placeholder="example.com or 10.0.0.5" />
        </Field>
        <Field label="Port" width={90}>
          <input type="number" min={1} max={65535} required value={p.port} onChange={(e) => set('port', Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Username">
        <input required value={p.user} onChange={(e) => set('user', e.target.value)} />
      </Field>
      <Field label="Authentication">
        <div className="segmented">
          <button type="button" className={p.authType === 'password' ? 'on' : ''} onClick={() => set('authType', 'password')}>
            Password
          </button>
          <button type="button" className={p.authType === 'key' ? 'on' : ''} onClick={() => set('authType', 'key')}>
            Key
          </button>
        </div>
      </Field>
      {p.authType === 'password' ? (
        <Field
          label="Password"
          hint={
            hasPassword ? (
              <>
                A password is saved in the vault. Type a new one to replace it, or{' '}
                <button type="button" className="link" onClick={forget}>
                  forget it
                </button>
                .
              </>
            ) : (
              'Leave empty to be asked when connecting.'
            )
          }
        >
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      ) : (
        <Field label="Key">
          {keys.length === 0 ? (
            <p className="muted">No keys yet. Create or import one in Keychain first.</p>
          ) : (
            <select required value={p.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || undefined)}>
              <option value="">Choose a key</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.type})
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="form-actions">
        {exists && (
          <button type="button" className="danger ghost" onClick={remove}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="primary">
          Save
        </button>
      </div>
    </form>
  )
}
