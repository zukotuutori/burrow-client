import type { KeyMeta, KnownHosts, Profile, Settings, Snippet } from '../../shared/types'

/** A host together with its saved password, so both travel and win together. */
export type SyncProfile = Profile & { password?: string }
/** Key metadata together with the private key from the vault. */
export type SyncKey = KeyMeta & { privateKey?: string; passphrase?: string }

/** Everything that is synced. It is encrypted as a whole before it leaves the device. */
export interface SyncState {
  v: 1
  profiles: SyncProfile[]
  keys: SyncKey[]
  snippets: Snippet[]
  knownHosts: KnownHosts
  settings: Settings
}

/** Stored in sync.json. Only lives on this device. */
export interface SyncConfig {
  serverUrl?: string
  username?: string
  /** Server version this device last uploaded or downloaded. */
  version?: number
  lastSyncAt?: string
  lastError?: string
}
