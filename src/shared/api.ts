import type {
  KeyMeta,
  KeyType,
  KnownHosts,
  LoadError,
  Profile,
  Prompt,
  PromptAnswer,
  RemoteEntry,
  Settings,
  Snippet,
  SnippetImportResult,
  SyncStatus,
  VaultStatus
} from './types'

export type Unsubscribe = () => void

export interface BurrowApi {
  platform: string
  vault: {
    status(): Promise<VaultStatus>
    create(password: string): Promise<void>
    unlock(password: string): Promise<void>
    lock(): Promise<void>
    reset(): Promise<void>
    changePassword(current: string, next: string): Promise<void>
    /** Fires when the main process locks the vault on its own, e.g. on sleep or screen lock. */
    onLocked(cb: () => void): Unsubscribe
  }
  files: {
    errors(): Promise<LoadError[]>
    reset(file: string): Promise<void>
  }
  profiles: {
    list(): Promise<Profile[]>
    save(profile: Profile, password?: string): Promise<void>
    remove(id: string): Promise<void>
    hasPassword(id: string): Promise<boolean>
    forgetPassword(id: string): Promise<void>
    /** Whether the host currently accepts TCP connections on its SSH port. */
    reachable(id: string): Promise<boolean>
  }
  snippets: {
    list(): Promise<Snippet[]>
    save(snippet: Snippet): Promise<void>
    remove(id: string): Promise<void>
    /** Opens a save dialog and writes all snippets. Returns how many were exported, or null when cancelled. */
    exportFile(): Promise<number | null>
    /** Opens a file dialog and imports a snippets file. Returns null when cancelled. */
    importFile(): Promise<SnippetImportResult | null>
  }
  keys: {
    list(): Promise<KeyMeta[]>
    generate(name: string, type: KeyType): Promise<KeyMeta>
    importKey(name: string, privateKey: string, passphrase?: string): Promise<KeyMeta>
    remove(id: string): Promise<void>
    /** Opens a file dialog and returns the file contents, or null when cancelled. */
    readFile(): Promise<string | null>
  }
  knownHosts: {
    list(): Promise<KnownHosts>
    remove(id: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    save(settings: Settings): Promise<void>
  }
  sync: {
    status(): Promise<SyncStatus>
    register(serverUrl: string, username: string, password: string, code: string): Promise<void>
    login(serverUrl: string, username: string, password: string): Promise<void>
    logout(): Promise<void>
    syncNow(): Promise<void>
    changePassword(current: string, next: string): Promise<void>
    deleteAccount(password: string): Promise<void>
    /** Fires after a sync changed local data or the sync status. */
    onChanged(cb: () => void): Unsubscribe
  }
  session: {
    connect(id: string, profileId: string, cols: number, rows: number): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    close(id: string): Promise<void>
    onData(cb: (id: string, data: string) => void): Unsubscribe
    onClosed(cb: (id: string, reason: string) => void): Unsubscribe
  }
  prompts: {
    onRequest(cb: (promptId: string, prompt: Prompt) => void): Unsubscribe
    answer(promptId: string, answer: PromptAnswer): void
  }
  sftp: {
    home(id: string): Promise<string>
    list(id: string, path: string): Promise<RemoteEntry[]>
    /** Opens a file dialog and uploads the chosen files into `dir`. Returns the number uploaded. */
    uploadDialog(id: string, dir: string): Promise<number>
    uploadPaths(id: string, dir: string, localPaths: string[]): Promise<void>
    /** Opens a save dialog and downloads the file. Returns false when cancelled. */
    download(id: string, remotePath: string): Promise<boolean>
    rename(id: string, from: string, to: string): Promise<void>
    remove(id: string, path: string, isDir: boolean): Promise<void>
    mkdir(id: string, path: string): Promise<void>
    pathForFile(file: File): string
  }
  openExternal(url: string): Promise<void>
}
