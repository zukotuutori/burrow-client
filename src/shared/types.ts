export type AuthType = 'password' | 'key'
export type KeyType = 'ed25519' | 'rsa'

export interface Profile {
  id: string
  name: string
  group: string
  host: string
  port: number
  user: string
  authType: AuthType
  keyId?: string
  note?: string
}

export interface Snippet {
  id: string
  name: string
  command: string
  tags?: string[]
  /** Hosts this snippet is shown for. Missing means all hosts. */
  profileIds?: string[]
}

/** One snippet in an export file. Hosts are referenced by label, since ids differ between machines. */
export interface SnippetExportEntry {
  name: string
  command: string
  tags?: string[]
  hosts?: string[]
}

export interface SnippetExport {
  format: 'burrow-snippets'
  version: 1
  snippets: SnippetExportEntry[]
}

export interface SnippetImportResult {
  imported: number
  skipped: number
}

export interface Settings {
  fontFamily: string
  fontSize: number
  theme: 'dark' | 'light'
  /** Lock the vault after this many minutes without keyboard or mouse input. 0 turns it off. */
  autoLockMinutes: number
  /** Regularly check whether each host accepts connections and show it on the host cards. */
  showHostStatus: boolean
}

export interface KeyMeta {
  id: string
  name: string
  type: string
  publicKey: string
  fingerprint: string
  createdAt: string
}

export interface KnownHost {
  algo: string
  fingerprint: string
  addedAt: string
}

/** Keyed by `host:port`. */
export type KnownHosts = Record<string, KnownHost>

export type VaultStatus = 'missing' | 'locked' | 'unlocked' | 'broken'

export interface LoadError {
  file: string
  message: string
}

export interface RemoteEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

export type HostKeyCheck =
  | { state: 'match' }
  | { state: 'unknown'; algo: string; fingerprint: string }
  | { state: 'changed'; algo: string; fingerprint: string; oldFingerprint: string }

export type Prompt =
  | { kind: 'hostkey'; host: string; port: number; check: HostKeyCheck }
  | { kind: 'password'; label: string }
  | { kind: 'passphrase'; label: string }

export interface PromptAnswer {
  ok: boolean
  value?: string
  save?: boolean
}
