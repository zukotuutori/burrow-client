import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BurrowApi } from '../shared/api'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))
  }
}

// One ipcRenderer listener per channel, fanned out to subscribers.
const subscribers = new Map<string, Set<(...args: never[]) => void>>()
function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  let set = subscribers.get(channel)
  if (!set) {
    const created = new Set<(...args: never[]) => void>()
    subscribers.set(channel, created)
    ipcRenderer.on(channel, (_event, ...args) => created.forEach((fn) => (fn as (...a: unknown[]) => void)(...args)))
    set = created
  }
  const fn = cb as unknown as (...args: never[]) => void
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}

const api: BurrowApi = {
  platform: process.platform,
  vault: {
    status: () => invoke('vault:status'),
    create: (pw) => invoke('vault:create', pw),
    unlock: (pw) => invoke('vault:unlock', pw),
    lock: () => invoke('vault:lock'),
    reset: () => invoke('vault:reset'),
    changePassword: (current, next) => invoke('vault:changePassword', current, next),
    onLocked: (cb) => listen('vault:locked', cb)
  },
  files: {
    errors: () => invoke('files:errors'),
    reset: (file) => invoke('files:reset', file)
  },
  profiles: {
    list: () => invoke('profiles:list'),
    save: (p, pw) => invoke('profiles:save', p, pw),
    remove: (id) => invoke('profiles:remove', id),
    hasPassword: (id) => invoke('profiles:hasPassword', id),
    forgetPassword: (id) => invoke('profiles:forgetPassword', id),
    reachable: (id) => invoke('profiles:reachable', id)
  },
  snippets: {
    list: () => invoke('snippets:list'),
    save: (s) => invoke('snippets:save', s),
    remove: (id) => invoke('snippets:remove', id),
    exportFile: () => invoke('snippets:export'),
    importFile: () => invoke('snippets:import')
  },
  keys: {
    list: () => invoke('keys:list'),
    generate: (name, type) => invoke('keys:generate', name, type),
    importKey: (name, key, pp) => invoke('keys:import', name, key, pp),
    remove: (id) => invoke('keys:remove', id),
    readFile: () => invoke('keys:readFile')
  },
  knownHosts: {
    list: () => invoke('knownHosts:list'),
    remove: (id) => invoke('knownHosts:remove', id)
  },
  settings: {
    get: () => invoke('settings:get'),
    save: (s) => invoke('settings:save', s)
  },
  sync: {
    status: () => invoke('sync:status'),
    register: (url, user, pw, code) => invoke('sync:register', url, user, pw, code),
    login: (url, user, pw) => invoke('sync:login', url, user, pw),
    logout: () => invoke('sync:logout'),
    syncNow: () => invoke('sync:now'),
    changePassword: (current, next) => invoke('sync:changePassword', current, next),
    deleteAccount: (pw) => invoke('sync:deleteAccount', pw),
    onChanged: (cb) => listen('sync:changed', cb)
  },
  session: {
    connect: (id, profileId, cols, rows) => invoke('session:connect', id, profileId, cols, rows),
    openLocal: (id, cols, rows) => invoke('session:openLocal', id, cols, rows),
    write: (id, data) => ipcRenderer.send('session:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
    close: (id) => invoke('session:close', id),
    onData: (cb) => listen('session:data', cb),
    onClosed: (cb) => listen('session:closed', cb)
  },
  prompts: {
    onRequest: (cb) => listen('prompt:request', cb),
    answer: (id, answer) => ipcRenderer.send('prompt:answer', id, answer)
  },
  sftp: {
    home: (id) => invoke('sftp:home', id),
    list: (id, path) => invoke('sftp:list', id, path),
    uploadDialog: (id, dir) => invoke('sftp:uploadDialog', id, dir),
    uploadPaths: (id, dir, paths) => invoke('sftp:uploadPaths', id, dir, paths),
    download: (id, remotePath) => invoke('sftp:download', id, remotePath),
    rename: (id, from, to) => invoke('sftp:rename', id, from, to),
    remove: (id, path, isDir) => invoke('sftp:remove', id, path, isDir),
    mkdir: (id, path) => invoke('sftp:mkdir', id, path),
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  updates: {
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    restart: () => invoke('updates:restart')
  },
  openExternal: (url) => invoke('app:openExternal', url)
}

contextBridge.exposeInMainWorld('burrow', api)
