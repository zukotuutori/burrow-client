import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { KeyMeta, KnownHosts, LoadError, Profile, Settings, Snippet } from '../../shared/types'
import { api } from './api'

interface Data {
  profiles: Profile[]
  snippets: Snippet[]
  keys: KeyMeta[]
  knownHosts: KnownHosts
  settings: Settings
  loadErrors: LoadError[]
}

interface DataContextValue extends Data {
  reload(): Promise<void>
}

const DataContext = createContext<DataContextValue | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data | null>(null)

  const reload = useCallback(async () => {
    const [profiles, snippets, keys, knownHosts, settings, loadErrors] = await Promise.all([
      api.profiles.list(),
      api.snippets.list(),
      api.keys.list(),
      api.knownHosts.list(),
      api.settings.get(),
      api.files.errors()
    ])
    setData({ profiles, snippets, keys, knownHosts, settings, loadErrors })
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const theme = data?.settings.theme
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
  }, [theme])

  if (!data) return null
  return <DataContext.Provider value={{ ...data, reload }}>{children}</DataContext.Provider>
}

export function useData(): DataContextValue {
  const value = useContext(DataContext)
  if (!value) throw new Error('useData must be used inside DataProvider')
  return value
}
