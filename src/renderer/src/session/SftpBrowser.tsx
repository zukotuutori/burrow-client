import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry } from '../../../shared/types'
import { api } from '../api'
import { TextPrompt } from '../components/TextPrompt'
import { FileIcon, FolderIcon, RefreshIcon, UpIcon } from '../icons'
import { useAction, useToast } from '../toast'
import { formatSize } from '../util'

const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
const parentOf = (dir: string) => dir.replace(/\/[^/]+\/?$/, '') || '/'

type Dialog = { kind: 'mkdir' } | { kind: 'rename'; entry: RemoteEntry } | null

export function SftpBrowser({ sessionId }: { sessionId: string | null }) {
  const run = useAction()
  const toast = useToast()
  const [path, setPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragOver, setDragOver] = useState(false)

  const load = useCallback(
    (dir: string) =>
      run(async () => {
        if (!sessionId) return
        setEntries(await api.sftp.list(sessionId, dir))
        setPath(dir)
        setSelected(null)
      }),
    [run, sessionId]
  )

  useEffect(() => {
    setPath(null)
    setEntries([])
    if (sessionId) void run(async () => load(await api.sftp.home(sessionId)))
  }, [sessionId, run, load])

  if (!sessionId) {
    return (
      <aside className="sftp">
        <p className="sftp-empty muted">SFTP is available once the first pane is connected.</p>
      </aside>
    )
  }

  const sel = entries.find((e) => e.name === selected) ?? null
  // Runs a change, shows errors as a toast, then reloads the listing either way.
  const op = async (fn: () => Promise<unknown>, success?: string) => {
    await run(fn, success)
    if (path) await load(path)
  }

  const upload = () =>
    path &&
    op(async () => {
      const n = await api.sftp.uploadDialog(sessionId, path)
      if (n) toast(`Uploaded ${n} file${n === 1 ? '' : 's'}`)
    })
  const download = () =>
    path &&
    sel &&
    run(async () => {
      if (await api.sftp.download(sessionId, join(path, sel.name))) toast(`Downloaded ${sel.name}`)
    })
  const remove = () => {
    if (path && sel && confirm(`Delete ${sel.name}?`)) void op(() => api.sftp.remove(sessionId, join(path, sel.name), sel.isDir))
  }
  const drop = (files: FileList) => {
    const paths = [...files].map((f) => api.sftp.pathForFile(f)).filter(Boolean)
    if (path && paths.length) {
      void op(() => api.sftp.uploadPaths(sessionId, path, paths), `Uploaded ${paths.length} file${paths.length === 1 ? '' : 's'}`)
    }
  }
  const submitDialog = (name: string) => {
    const d = dialog
    setDialog(null)
    if (!path || !d) return
    if (d.kind === 'mkdir') void op(() => api.sftp.mkdir(sessionId, join(path, name)))
    else void op(() => api.sftp.rename(sessionId, join(path, d.entry.name), join(path, name)))
  }

  return (
    <aside
      className={`sftp ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        drop(e.dataTransfer.files)
      }}
    >
      <header className="sftp-header">
        <button className="icon-btn" title="Parent folder" disabled={!path || path === '/'} onClick={() => path && load(parentOf(path))}>
          <UpIcon />
        </button>
        <div className="sftp-path mono" title={path ?? ''}>
          {path ?? '…'}
        </div>
        <button className="icon-btn" title="Refresh" onClick={() => path && load(path)}>
          <RefreshIcon />
        </button>
      </header>
      <div className="sftp-actions">
        <button title="Upload files to this folder (you can also drop files here)" onClick={upload}>Upload</button>
        <button title="Download the selected file" disabled={!sel || sel.isDir} onClick={download}>
          Download
        </button>
        <button title="Create a folder here" onClick={() => setDialog({ kind: 'mkdir' })}>New folder</button>
        <button title="Rename the selected item" disabled={!sel} onClick={() => sel && setDialog({ kind: 'rename', entry: sel })}>
          Rename
        </button>
        <button className="danger ghost" title="Delete the selected item" disabled={!sel} onClick={remove}>
          Delete
        </button>
      </div>
      <div className="sftp-list">
        {entries.map((e) => (
          <div
            key={e.name}
            className={`sftp-row ${selected === e.name ? 'selected' : ''}`}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => e.isDir && path && load(join(path, e.name))}
          >
            <span className="sftp-icon">{e.isDir ? <FolderIcon /> : <FileIcon />}</span>
            <span className="sftp-name">{e.name}</span>
            <span className="sftp-size muted">{e.isDir ? '' : formatSize(e.size)}</span>
          </div>
        ))}
      </div>
      <div className="sftp-hint muted">Drop files here to upload</div>
      {dialog && (
        <TextPrompt
          title={dialog.kind === 'mkdir' ? 'New folder' : `Rename ${dialog.entry.name}`}
          initial={dialog.kind === 'rename' ? dialog.entry.name : ''}
          confirmLabel={dialog.kind === 'mkdir' ? 'Create' : 'Rename'}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  )
}
