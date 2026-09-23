import { useCallback, useEffect, useState } from 'react'
import type { VaultStatus } from '../../shared/types'
import { api } from './api'
import { DataProvider } from './data'
import { Main } from './MainView'
import { PromptDialog } from './PromptDialog'
import { ToastProvider } from './toast'
import { UnlockScreen } from './UnlockScreen'

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const refresh = useCallback(() => {
    void api.vault.status().then(setStatus)
  }, [])
  useEffect(refresh, [refresh])
  useEffect(() => api.vault.onLocked(refresh), [refresh])

  if (status === null) return null
  if (status !== 'unlocked') return <UnlockScreen status={status} onDone={refresh} />

  const lock = async () => {
    await api.vault.lock()
    refresh()
  }
  return (
    <ToastProvider>
      <DataProvider>
        <Main onLock={lock} />
        <PromptDialog />
      </DataProvider>
    </ToastProvider>
  )
}
