import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { BurrowApi, FileDrop } from '../../shared/api'

/** Commands reject with a plain message string; turn it into an Error like the rest of the UI expects. */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args)
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e))
  }
}

// One Tauri listener per event, registered right away so no early event is missed, fanned out to subscribers.
const subscribers = new Map<string, Set<(payload: unknown) => void>>()
for (const event of ['vault:locked', 'sync:changed', 'session:data', 'session:closed', 'prompt:request']) {
  const set = new Set<(payload: unknown) => void>()
  subscribers.set(event, set)
  void tauriListen(event, (e) => set.forEach((fn) => fn(e.payload)))
}
function listen(event: string, cb: (payload: unknown) => void): () => void {
  const set = subscribers.get(event)!
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}

// Keystrokes must reach the shell in order. Separate invokes are not guaranteed to arrive in order, so each
// session sends one write at a time and collects what is typed meanwhile.
const pendingWrites = new Map<string, string>()
const writing = new Set<string>()
function write(id: string, data: string): void {
  pendingWrites.set(id, (pendingWrites.get(id) ?? '') + data)
  if (writing.has(id)) return
  writing.add(id)
  void (async () => {
    try {
      for (let chunk = pendingWrites.get(id); chunk; chunk = pendingWrites.get(id)) {
        pendingWrites.delete(id)
        await invoke('session_write', { id, data: chunk }).catch(() => undefined)
      }
    } finally {
      writing.delete(id)
    }
  })()
}

declare global {
  interface Window {
    /** Set by the backend before the page loads. */
    __BURROW_PLATFORM__?: string
  }
}

export const api: BurrowApi = {
  platform: window.__BURROW_PLATFORM__ ?? (navigator.userAgent.includes('Mac') ? 'darwin' : 'linux'),
  vault: {
    status: () => invoke('vault_status'),
    create: (password) => invoke('vault_create', { password }),
    unlock: (password) => invoke('vault_unlock', { password }),
    lock: () => invoke('vault_lock'),
    reset: () => invoke('vault_reset'),
    changePassword: (current, next) => invoke('vault_change_password', { current, next }),
    onLocked: (cb) => listen('vault:locked', () => cb())
  },
  files: {
    errors: () => invoke('files_errors'),
    reset: (file) => invoke('files_reset', { file })
  },
  profiles: {
    list: () => invoke('profiles_list'),
    save: (profile, password) => invoke('profiles_save', { profile, password: password ?? null }),
    remove: (id) => invoke('profiles_remove', { id }),
    hasPassword: (id) => invoke('profiles_has_password', { id }),
    forgetPassword: (id) => invoke('profiles_forget_password', { id }),
    reachable: (id) => invoke('profiles_reachable', { id })
  },
  snippets: {
    list: () => invoke('snippets_list'),
    save: (snippet) => invoke('snippets_save', { snippet }),
    remove: (id) => invoke('snippets_remove', { id }),
    exportFile: () => invoke('snippets_export'),
    importFile: () => invoke('snippets_import')
  },
  keys: {
    list: () => invoke('keys_list'),
    generate: (name, keyType) => invoke('keys_generate', { name, keyType }),
    importKey: (name, privateKey, passphrase) => invoke('keys_import', { name, privateKey, passphrase: passphrase ?? null }),
    remove: (id) => invoke('keys_remove', { id }),
    readFile: () => invoke('keys_read_file')
  },
  knownHosts: {
    list: () => invoke('known_hosts_list'),
    remove: (id) => invoke('known_hosts_remove', { id })
  },
  settings: {
    get: () => invoke('settings_get'),
    save: (settings) => invoke('settings_save', { settings })
  },
  sync: {
    status: () => invoke('sync_status'),
    register: (serverUrl, username, password, code) => invoke('sync_register', { serverUrl, username, password, code }),
    login: (serverUrl, username, password) => invoke('sync_login', { serverUrl, username, password }),
    logout: () => invoke('sync_logout'),
    syncNow: () => invoke('sync_now'),
    changePassword: (current, next) => invoke('sync_change_password', { current, next }),
    deleteAccount: (password) => invoke('sync_delete_account', { password }),
    onChanged: (cb) => listen('sync:changed', () => cb())
  },
  session: {
    connect: (id, profileId, cols, rows) => invoke('session_connect', { id, profileId, cols, rows }),
    openLocal: (id, cols, rows) => invoke('session_open_local', { id, cols, rows }),
    write,
    resize: (id, cols, rows) => void invoke('session_resize', { id, cols, rows }).catch(() => undefined),
    close: (id) => invoke('session_close', { id }),
    onData: (cb) => listen('session:data', (p) => cb(...(p as [string, string]))),
    onClosed: (cb) => listen('session:closed', (p) => cb(...(p as [string, string])))
  },
  prompts: {
    onRequest: (cb) => listen('prompt:request', (p) => cb(...(p as [string, Parameters<typeof cb>[1]]))),
    answer: (promptId, answer) => void invoke('prompt_answer', { promptId, answer }).catch(() => undefined)
  },
  sftp: {
    home: (id) => invoke('sftp_home', { id }),
    list: (id, path) => invoke('sftp_list', { id, path }),
    uploadDialog: (id, dir) => invoke('sftp_upload_dialog', { id, dir }),
    uploadPaths: (id, dir, localPaths) => invoke('sftp_upload_paths', { id, dir, localPaths }),
    download: (id, remotePath) => invoke('sftp_download', { id, remotePath }),
    rename: (id, from, to) => invoke('sftp_rename', { id, from, to }),
    remove: (id, path, isDir) => invoke('sftp_remove', { id, path, isDir }),
    mkdir: (id, path) => invoke('sftp_mkdir', { id, path }),
    onFileDrop: (cb) => {
      // The webview hands over real file paths only through its own drag and drop events.
      let stop: (() => void) | undefined
      let cancelled = false
      void getCurrentWebview()
        .onDragDropEvent((e) => {
          const p = e.payload
          const scale = window.devicePixelRatio || 1
          const at = 'position' in p ? { x: p.position.x / scale, y: p.position.y / scale } : undefined
          const drop: FileDrop =
            p.type === 'leave' ? { type: 'leave' } : { type: p.type, x: at!.x, y: at!.y, paths: 'paths' in p ? p.paths : [] }
          cb(drop)
        })
        .then((unlisten) => (cancelled ? unlisten() : (stop = unlisten)))
      return () => {
        cancelled = true
        stop?.()
      }
    }
  },
  updates: {
    check: () => invoke('updates_check'),
    download: () => invoke('updates_download'),
    restart: () => invoke('updates_restart')
  },
  openExternal: (url) => invoke('app_open_external', { url })
}
