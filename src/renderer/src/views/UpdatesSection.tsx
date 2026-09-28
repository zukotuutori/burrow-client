import { useEffect, useState } from 'react'
import type { UpdateInfo } from '../../../shared/types'
import { api } from '../api'
import { useAction } from '../toast'

/** Checks GitHub for a newer version. The AppImage installs it itself, every other build links to the download. */
export function UpdateCheck() {
  const run = useAction()
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [stage, setStage] = useState<'idle' | 'checking' | 'downloading' | 'ready'>('idle')

  const check = async () => {
    setStage('checking')
    await run(async () => setInfo(await api.updates.check()))
    setStage('idle')
  }

  const download = async () => {
    setStage('downloading')
    setStage((await run(() => api.updates.download())) ? 'ready' : 'idle')
  }

  const status = !info
    ? `You have version ${__APP_VERSION__}.`
    : info.available
      ? `Version ${info.latest} is available. You have ${info.current}.`
      : `Burrow is up to date (version ${info.current}).`

  return (
    <>
      <p className="muted">{status}</p>
      <div className="form-actions">
        {info?.available &&
          (stage === 'ready' ? (
            <button className="primary" title="Close all sessions and restart with the new version" onClick={() => void run(() => api.updates.restart())}>
              Restart to update
            </button>
          ) : info.canInstall ? (
            <button className="primary" title="Download the new version and check it" disabled={stage === 'downloading'} onClick={download}>
              {stage === 'downloading' ? 'Downloading…' : 'Download and install'}
            </button>
          ) : (
            <button className="primary" title="Open the download in your browser" onClick={() => void api.openExternal(info.downloadUrl)}>
              Download
            </button>
          ))}
        <button title="Ask GitHub for the latest version" disabled={stage !== 'idle'} onClick={check}>
          {stage === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {stage === 'ready' && <p className="muted">If you don't restart now, the update is installed the next time you quit Burrow.</p>}
    </>
  )
}

let startupCheck: Promise<UpdateInfo | null> | undefined

/** Checks once per app start when the setting is on, and returns the update if there is one. Errors stay silent. */
export function useStartupUpdateCheck(enabled: boolean): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    if (!enabled) return
    startupCheck ??= api.updates.check().then(
      (u) => (u.available ? u : null),
      () => null
    )
    let live = true
    void startupCheck.then((u) => live && setUpdate(u))
    return () => {
      live = false
    }
  }, [enabled])
  return update
}
