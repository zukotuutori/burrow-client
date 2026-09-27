import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { masterPasswordProblems } from '../../../shared/passwordPolicy'
import type { SyncStatus } from '../../../shared/types'
import { api } from '../api'
import { Field } from '../components/Field'
import { PasswordRules } from '../components/PasswordRules'
import { useAction, useToast } from '../toast'
import { errMsg } from '../util'

/** Settings section to log in to a sync server and manage the account. */
export function SyncSection() {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await api.sync.status()), [])

  useEffect(() => {
    void refresh()
    return api.sync.onChanged(() => void refresh())
  }, [refresh])

  if (!status) return null
  return (
    <div className="form">
      <h2 className="section-title">Sync</h2>
      {status.loggedIn ? <LoggedIn status={status} /> : <LoggedOut lastError={status.lastError} onDone={refresh} />}
    </div>
  )
}

function LoggedOut({ lastError, onDone }: { lastError?: string; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [server, setServer] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const register = mode === 'register'
  const weak = register && masterPasswordProblems(password).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (register && password !== repeat) return setError('The passwords do not match')
    setBusy(true)
    setError('')
    try {
      if (register) await api.sync.register(server, user, password, code)
      else await api.sync.login(server, user, password)
      await onDone()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">
        Keeps hosts, keys, snippets, known hosts and settings the same on all your devices. Everything is encrypted on
        this device before it is uploaded, so the server cannot read it. A forgotten account password cannot be
        recovered.
      </p>
      {lastError && <p className="error">{lastError}</p>}
      <div className="segmented">
        <button type="button" className={register ? '' : 'on'} title="Use an existing sync account" onClick={() => setMode('login')}>
          Log in
        </button>
        <button type="button" className={register ? 'on' : ''} title="Register a new sync account" onClick={() => setMode('register')}>
          Create account
        </button>
      </div>
      <Field label="Server">
        <input placeholder="https://sync.example.com" value={server} onChange={(e) => setServer(e.target.value)} />
      </Field>
      <Field label="User name">
        <input autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
      </Field>
      <Field label="Account password">
        <input
          type="password"
          autoComplete={register ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {register && (
        <>
          <PasswordRules password={password} />
          <Field label="Repeat account password">
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
          <Field label="Invite code" hint="Set on the server as REGISTRATION_CODE.">
            <input value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <span className="spacer" />
        <button
          type="submit"
          className="primary"
          title={register ? 'Create the account and start syncing' : 'Log in and start syncing'}
          disabled={busy || !server || !user || !password || weak || (register && (!repeat || !code))}
        >
          {busy ? 'Working…' : register ? 'Create account' : 'Log in'}
        </button>
      </div>
    </form>
  )
}

function LoggedIn({ status }: { status: SyncStatus }) {
  const run = useAction()
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<'none' | 'password' | 'delete'>('none')

  const syncNow = async () => {
    setBusy(true)
    await run(() => api.sync.syncNow(), 'Synced')
    setBusy(false)
  }

  return (
    <>
      <p>
        Logged in as <strong>{status.username}</strong> on <span className="muted">{status.serverUrl}</span>
      </p>
      {status.lastError ? (
        <p className="error">Last sync failed: {status.lastError}</p>
      ) : (
        <p className="muted">{status.lastSyncAt ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}` : 'Not synced yet'}</p>
      )}
      <div className="form-actions">
        <button type="button" className="primary" title="Upload and download changes now" disabled={busy} onClick={syncNow}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <button type="button" title="Change the password of your sync account" onClick={() => setPanel(panel === 'password' ? 'none' : 'password')}>
          Change account password
        </button>
        <span className="spacer" />
        <button type="button" title="Stop syncing on this device. Local data stays." onClick={() => run(() => api.sync.logout())}>
          Log out
        </button>
        <button type="button" className="danger ghost" title="Delete your sync account and its data on the server" onClick={() => setPanel(panel === 'delete' ? 'none' : 'delete')}>
          Delete account
        </button>
      </div>
      {panel === 'password' && <ChangeAccountPassword onDone={() => setPanel('none')} />}
      {panel === 'delete' && <DeleteAccount />}
    </>
  )
}

function ChangeAccountPassword({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const weak = masterPasswordProblems(next).length > 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (next !== repeat) return setError('The new passwords do not match')
    setBusy(true)
    setError('')
    try {
      await api.sync.changePassword(current, next)
      toast('Account password changed. Log in again on your other devices.')
      onDone()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Current account password">
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New account password">
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <PasswordRules password={next} />
      <Field label="Repeat new account password">
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary" title="Set the new account password" disabled={busy || !current || weak || !repeat}>
          {busy ? 'Changing…' : 'Change account password'}
        </button>
      </div>
    </form>
  )
}

function DeleteAccount() {
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.sync.deleteAccount(password)
      toast('Account deleted. The data on this device is still here.')
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <p className="error">
        This deletes your account and all synced data on the server. The data on your devices stays, but they stop
        syncing.
      </p>
      <Field label="Account password">
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="danger" title="Permanently delete the account and all synced data on the server" disabled={busy || !password}>
          {busy ? 'Deleting…' : 'Delete account and server data'}
        </button>
      </div>
    </form>
  )
}
