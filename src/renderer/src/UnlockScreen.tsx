import { useState, type FormEvent } from 'react'
import { masterPasswordProblems } from '../../shared/passwordPolicy'
import { PasswordRules } from './components/PasswordRules'
import type { VaultStatus } from '../../shared/types'
import { api } from './api'
import { BurrowMark } from './icons'
import { errMsg } from './util'

export function UnlockScreen({ status, onDone }: { status: Exclude<VaultStatus, 'unlocked'>; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setPassword('')
      setRepeat('')
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <div className="auth-logo">
      <BurrowMark />
      <h1>Burrow Client</h1>
    </div>
  )

  if (status === 'broken') {
    return (
      <div className="center-screen">
        <div className="auth-card">
          {header}
          <h2>The vault can't be read</h2>
          <p className="muted">
            vault.enc is damaged or not a Burrow vault. Resetting copies it to a backup file next to it and starts a new,
            empty vault. Saved passwords and keys will not be available.
          </p>
          {error && <p className="error">{error}</p>}
          <button className="danger" disabled={busy} onClick={() => run(() => api.vault.reset())}>
            Back up and reset vault
          </button>
        </div>
      </div>
    )
  }

  const creating = status === 'missing'
  const problems = masterPasswordProblems(password)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (creating) {
      if (problems.length) return setError('The master password does not meet all rules yet')
      if (password !== repeat) return setError('The passwords do not match')
      void run(() => api.vault.create(password))
    } else {
      void run(() => api.vault.unlock(password))
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit}>
        {header}
        <p className="muted">
          {creating
            ? 'Set a master password. It encrypts your saved passwords and keys on this computer.'
            : 'Enter your master password to unlock the vault.'}
        </p>
        <input type="password" placeholder="Master password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {creating && <PasswordRules password={password} />}
        {creating && (
          <input type="password" placeholder="Repeat password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        )}
        {creating && <p className="muted small">There is no way to recover a forgotten master password.</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy || (creating && problems.length > 0)}>
          {busy ? 'Working…' : creating ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
