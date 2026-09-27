import { useState, type FormEvent } from 'react'
import type { Snippet } from '../../../shared/types'
import { api } from '../api'
import { Empty } from '../components/Empty'
import { Field } from '../components/Field'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { CodeIcon, PlusIcon } from '../icons'
import { useAction, useToast } from '../toast'

export function SnippetsView() {
  const { snippets, profiles, reload } = useData()
  const run = useAction()
  const toast = useToast()
  const hostName = (id: string) => profiles.find((p) => p.id === id)?.name ?? id
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const list = snippets.filter((s) => `${s.name} ${s.command} ${(s.tags ?? []).join(' ')}`.toLowerCase().includes(q))
  const exists = editing ? snippets.some((s) => s.id === editing.id) : false

  const exportFile = () =>
    run(async () => {
      const count = await api.snippets.exportFile()
      if (count !== null) toast(`Exported ${count} snippet${count === 1 ? '' : 's'}`)
    })
  const importFile = () =>
    run(async () => {
      const result = await api.snippets.importFile()
      if (!result) return
      const skipped = result.skipped ? `, skipped ${result.skipped} already there` : ''
      toast(`Imported ${result.imported} snippet${result.imported === 1 ? '' : 's'}${skipped}`)
      await reload()
    })

  return (
    <div className="view">
      <header className="view-header">
        <h1>Snippets</h1>
        <input className="search" placeholder="Search snippets" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button title="Add snippets from a JSON file" onClick={importFile}>Import</button>
        <button title="Save all snippets to a JSON file" onClick={exportFile} disabled={snippets.length === 0}>
          Export
        </button>
        <button className="primary" title="Create a new snippet" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', command: '' })}>
          <PlusIcon /> New snippet
        </button>
      </header>
      {snippets.length === 0 ? (
        <Empty title="No snippets yet" text="Save commands you run often and send them to any terminal with one click." />
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.id} className="list-row clickable" onClick={() => setEditing(s)}>
              <div className="list-icon">
                <CodeIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{s.name}</div>
                <div className="list-sub mono">{s.command}</div>
              </div>
              {s.profileIds?.map((id) => (
                <span key={id} className="tag host-tag">
                  {hostName(id)}
                </span>
              ))}
              {s.tags?.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <SidePanel title={exists ? 'Edit snippet' : 'New snippet'} onClose={() => setEditing(null)}>
          <SnippetForm
            snippet={editing}
            exists={exists}
            onDone={() => {
              setEditing(null)
              void reload()
            }}
          />
        </SidePanel>
      )}
    </div>
  )
}

export function SnippetForm({ snippet, exists, onDone }: { snippet: Snippet; exists: boolean; onDone: () => void }) {
  const { profiles } = useData()
  const run = useAction()
  const [name, setName] = useState(snippet.name)
  const [command, setCommand] = useState(snippet.command)
  const [tags, setTags] = useState((snippet.tags ?? []).join(', '))
  const [specific, setSpecific] = useState(!!snippet.profileIds?.length)
  const [profileIds, setProfileIds] = useState<string[]>(snippet.profileIds ?? [])
  const [error, setError] = useState('')

  const toggleHost = (id: string) =>
    setProfileIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (specific && profileIds.length === 0) return setError('Pick at least one host, or choose All hosts.')
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    const hosts = specific ? profileIds : []
    if (await run(() => api.snippets.save({ id: snippet.id, name, command, tags: tagList, profileIds: hosts }))) onDone()
  }
  const remove = async () => {
    if (confirm(`Delete snippet "${snippet.name}"?`) && (await run(() => api.snippets.remove(snippet.id)))) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Command">
        <textarea className="mono" required spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)} />
      </Field>
      <Field label="Tags" hint="Comma separated, optional">
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label="Show on">
        <div className="segmented">
          <button type="button" className={specific ? '' : 'on'} title="Show this snippet in every session" onClick={() => setSpecific(false)}>
            All hosts
          </button>
          <button type="button" className={specific ? 'on' : ''} title="Show this snippet only for the hosts you pick" onClick={() => setSpecific(true)}>
            Specific hosts
          </button>
        </div>
        {specific &&
          (profiles.length === 0 ? (
            <p className="muted">No hosts yet.</p>
          ) : (
            <div className="host-checks">
              {profiles.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={profileIds.includes(p.id)} onChange={() => toggleHost(p.id)} />
                  {p.name} <span className="muted">{p.user}@{p.host}</span>
                </label>
              ))}
            </div>
          ))}
      </Field>
      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        {exists && (
          <button type="button" className="danger ghost" title="Delete this snippet" onClick={remove}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="primary" title="Save this snippet">
          Save
        </button>
      </div>
    </form>
  )
}
