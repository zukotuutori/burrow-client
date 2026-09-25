import { useEffect, useState, type FormEvent } from 'react'
import { masterPasswordProblems } from '../../../shared/passwordPolicy'
import type { Settings } from '../../../shared/types'
import { api } from '../api'
import { Field } from '../components/Field'
import { PasswordRules } from '../components/PasswordRules'
import { useData } from '../data'
import { useAction, useToast } from '../toast'
import { SyncSection } from './SyncSection'
import { errMsg } from '../util'

const AUTO_LOCK_CHOICES = [0, 5, 10, 15, 30, 60]

export function SettingsView() {
  const { settings, reload } = useData()
  const run = useAction()
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [settings])

  const save = async (next: Settings) => {
    setDraft(next)
    if (await run(() => api.settings.save(next))) void reload()
  }

  return (
    <div className="view narrow">
      <header className="view-header">
        <h1>Settings</h1>
      </header>
      <div className="form">
        <Field label="Theme">
          <div className="segmented">
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} type="button" className={draft.theme === t ? 'on' : ''} onClick={() => save({ ...draft, theme: t })}>
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Terminal font">
          <input
            value={draft.fontFamily}
            onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}
            onBlur={() => draft.fontFamily !== settings.fontFamily && save(draft)}
          />
        </Field>
        <Field label="Font size">
          <input
            type="number"
            min={8}
            max={32}
            value={draft.fontSize}
            onChange={(e) => setDraft({ ...draft, fontSize: Number(e.target.value) })}
            onBlur={() => draft.fontSize !== settings.fontSize && save(draft)}
          />
        </Field>
        <Field
          label="Auto-lock"
          hint="Locks the vault and closes sessions after this long without keyboard or mouse input. It also locks when the computer sleeps or the screen locks."
        >
          <select value={draft.autoLockMinutes} onChange={(e) => save({ ...draft, autoLockMinutes: Number(e.target.value) })}>
            {AUTO_LOCK_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Off' : m === 60 ? 'After 1 hour' : `After ${m} minutes`}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Host status"
          hint="Shows a green or red dot on each host. Burrow opens a short connection to every saved host every 30 seconds while the host list is open."
        >
          <div className="segmented">
            {([true, false] as const).map((on) => (
              <button
                key={String(on)}
                type="button"
                className={draft.showHostStatus === on ? 'on' : ''}
                onClick={() => save({ ...draft, showHostStatus: on })}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <SyncSection />
      <ChangePasswordForm />
    </div>
  )
}

function ChangePasswordForm() {
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
      await api.vault.changePassword(current, next)
      setCurrent('')
      setNext('')
      setRepeat('')
      toast('Master password changed')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <h2 className="section-title">Master password</h2>
      <Field label="Current password">
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password">
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <PasswordRules password={next} />
      <Field label="Repeat new password">
        <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy || !current || weak || !repeat}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  )
}
