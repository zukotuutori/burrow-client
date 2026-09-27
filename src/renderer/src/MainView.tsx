import { useCallback, useState } from 'react'
import { useData } from './data'
import { HomeView } from './HomeView'
import { SessionTab, type TabStatus } from './session/SessionTab'
import { TabBar, type SessionTabInfo } from './TabBar'

export function Main({ onLock }: { onLock: () => void }) {
  const { profiles } = useData()
  const [tabs, setTabs] = useState<SessionTabInfo[]>([])
  const [active, setActive] = useState('home')
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({})

  const open = (profileId: string | null) => {
    const id = crypto.randomUUID()
    const title = profileId ? (profiles.find((p) => p.id === profileId)?.name ?? 'Session') : 'Local'
    setTabs((t) => [...t, { id, profileId, title }])
    setActive(id)
  }

  const close = useCallback((id: string) => {
    setTabs((t) => t.filter((x) => x.id !== id))
    setStatuses(({ [id]: _removed, ...rest }) => rest)
    setActive((a) => (a === id ? 'home' : a))
  }, [])

  return (
    <div className="app">
      {tabs.length > 0 && (
        <TabBar tabs={tabs} active={active} statuses={statuses} onSelect={setActive} onClose={close} onReorder={setTabs} />
      )}
      <div className="app-body">
        <div className="tab-content" hidden={active !== 'home'}>
          <HomeView onConnect={open} onOpenLocal={() => open(null)} onLock={onLock} />
        </div>
        {tabs.map((t) => (
          <div key={t.id} className="tab-content" hidden={active !== t.id}>
            <SessionTab
              profileId={t.profileId}
              active={active === t.id}
              onStatus={(s) => setStatuses((x) => (x[t.id] === s ? x : { ...x, [t.id]: s }))}
              onEmpty={() => close(t.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
