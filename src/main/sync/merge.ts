import type { Settings } from '../../shared/types'
import type { SyncState } from './types'

type Stamped = { updatedAt?: number }

/** The newer version wins. On a tie the first argument (local) wins. */
export function newer<T extends Stamped>(a: T, b: T): T {
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
}

/** Merges two lists by id. Tombstones are kept, so deletes reach every device. */
export function mergeById<T extends Stamped & { id: string }>(local: T[], remote: T[]): T[] {
  const out = new Map<string, T>()
  for (const item of [...local, ...remote]) {
    const cur = out.get(item.id)
    out.set(item.id, cur ? newer(cur, item) : item)
  }
  return [...out.values()]
}

/** Same as mergeById for objects keyed by string, like known hosts. */
export function mergeRecord<T extends Stamped>(local: Record<string, T>, remote: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = { ...local }
  for (const [key, item] of Object.entries(remote)) {
    out[key] = Object.hasOwn(out, key) ? newer(out[key], item) : item
  }
  return out
}

/** Merging is idempotent, so merging the same data twice is harmless. */
export function mergeState(local: SyncState, remote: SyncState): SyncState {
  return {
    v: 1,
    profiles: mergeById(local.profiles, remote.profiles),
    keys: mergeById(local.keys, remote.keys),
    snippets: mergeById(local.snippets, remote.snippets),
    knownHosts: mergeRecord(local.knownHosts, remote.knownHosts),
    settings: newer(local.settings, remote.settings)
  }
}

/** What an empty server means: nothing, and settings that lose against any local settings. */
export function emptyState(settings: Settings): SyncState {
  return { v: 1, profiles: [], keys: [], snippets: [], knownHosts: {}, settings: { ...settings, updatedAt: 0 } }
}

export function isSyncState(v: unknown): v is SyncState {
  const s = v as SyncState
  return (
    !!s &&
    s.v === 1 &&
    [s.profiles, s.keys, s.snippets].every(Array.isArray) &&
    !!s.knownHosts &&
    typeof s.knownHosts === 'object' &&
    !!s.settings &&
    typeof s.settings === 'object'
  )
}
