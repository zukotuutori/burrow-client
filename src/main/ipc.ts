import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { KeyType } from '../shared/types'
import type { Ask, Core } from './core'
import { PendingPrompts } from './prompts'
import { checkForUpdate, downloadUpdate, restartToUpdate } from './updates'

const MAX_IMPORT_BYTES = 5 * 1024 * 1024

function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`${name} must be a string`)
  return v
}

function int(v: unknown, name: string): number {
  if (!Number.isInteger(v)) throw new Error(`${name} must be an integer`)
  return v as number
}

function optStr(v: unknown, name: string): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : str(v, name)
}

/** Returns a function that cancels every prompt still waiting on the renderer. */
export function registerIpc(core: Core, getWindow: () => BrowserWindow | null): () => void {
  // Only the main frame of the app's own window may talk to the main process.
  const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = getWindow()
    return !!win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  }
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event)) throw new Error('Rejected message from an unknown sender')
      return fn(...args)
    })
  const on = (channel: string, fn: (...args: unknown[]) => void) =>
    ipcMain.on(channel, (event, ...args) => {
      if (fromApp(event)) fn(...args)
    })

  const prompts = new PendingPrompts()
  const ask: Ask = async (prompt) => {
    const win = getWindow()
    if (!win) return { ok: false }
    return prompts.ask((id) => win.webContents.send('prompt:request', id, prompt))
  }
  on('prompt:answer', (id, answer) => prompts.answer(id, answer))

  handle('vault:status', () => core.vault.status())
  handle('vault:create', (pw) => core.createVault(str(pw, 'password')))
  handle('vault:unlock', async (pw) => {
    await core.vault.unlock(str(pw, 'password'))
    void core.sync.syncIfLoggedIn()
  })
  handle('vault:lock', () => {
    prompts.cancelAll()
    core.lock()
  })
  handle('vault:changePassword', (current, next) =>
    core.changeMasterPassword(str(current, 'current password'), str(next, 'new password'))
  )
  handle('vault:reset', async () => {
    await core.resetVault()
  })

  handle('files:errors', () => core.getLoadErrors())
  handle('files:reset', (file) => core.resetFile(str(file, 'file')))

  handle('profiles:list', () => core.profiles.list())
  handle('profiles:save', (p, pw) => core.saveProfile(p, optStr(pw, 'password')))
  handle('profiles:remove', (id) => core.deleteProfile(str(id, 'id')))
  handle('profiles:hasPassword', (id) => core.hasPassword(str(id, 'id')))
  handle('profiles:forgetPassword', (id) => core.forgetPassword(str(id, 'id')))
  handle('profiles:reachable', (id) => core.isReachable(str(id, 'id')))

  handle('snippets:list', () => core.snippets.list())
  handle('snippets:save', (s) => core.saveSnippet(s))
  handle('snippets:remove', (id) => core.deleteSnippet(str(id, 'id')))
  handle('snippets:export', async () => {
    const win = getWindow()
    if (!win) return null
    const r = await dialog.showSaveDialog(win, {
      title: 'Export snippets',
      defaultPath: 'burrow-snippets.json',
      filters: [{ name: 'Burrow snippets', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePath) return null
    const data = core.exportSnippets()
    // Commands can contain sensitive details, so the file is readable only by the user.
    await writeFile(r.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    return data.snippets.length
  })
  handle('snippets:import', async () => {
    const win = getWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Import snippets',
      properties: ['openFile'],
      filters: [{ name: 'Burrow snippets', extensions: ['json'] }]
    })
    if (r.canceled || r.filePaths.length === 0) return null
    if ((await stat(r.filePaths[0])).size > MAX_IMPORT_BYTES) throw new Error('The file is too large for a snippets file')
    let data: unknown
    try {
      data = JSON.parse(await readFile(r.filePaths[0], 'utf8'))
    } catch {
      throw new Error('This file is not valid JSON')
    }
    return core.importSnippets(data)
  })

  handle('keys:list', () => core.keys.list())
  handle('keys:generate', (name, type) => {
    if (type !== 'ed25519' && type !== 'rsa') throw new Error('Unsupported key type')
    return core.generateKey(str(name, 'name'), type as KeyType)
  })
  handle('keys:import', (name, key, pp) =>
    core.importKey(str(name, 'name'), str(key, 'privateKey'), optStr(pp, 'passphrase'))
  )
  handle('keys:remove', (id) => core.deleteKey(str(id, 'id')))
  handle('keys:readFile', async () => {
    const win = getWindow()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Import private key', properties: ['openFile', 'showHiddenFiles'] })
    if (r.canceled || r.filePaths.length === 0) return null
    return readFile(r.filePaths[0], 'utf8')
  })

  handle('knownHosts:list', () => core.listKnownHosts())
  handle('knownHosts:remove', (id) => core.removeKnownHost(str(id, 'id')))

  handle('settings:get', () => core.getSettings())
  handle('settings:save', async (s) => {
    await core.saveSettings(s)
    getWindow()?.setContentProtection(core.getSettings().blockScreenshots)
  })

  handle('sync:status', () => core.sync.status())
  handle('sync:register', (url, user, pw, code) =>
    core.sync.register(str(url, 'server'), str(user, 'user name'), str(pw, 'password'), str(code, 'invite code'))
  )
  handle('sync:login', (url, user, pw) => core.sync.login(str(url, 'server'), str(user, 'user name'), str(pw, 'password')))
  handle('sync:logout', () => core.sync.logout())
  handle('sync:now', () => core.sync.syncNow())
  handle('sync:changePassword', (current, next) =>
    core.sync.changePassword(str(current, 'current password'), str(next, 'new password'))
  )
  handle('sync:deleteAccount', (pw) => core.sync.deleteAccount(str(pw, 'password')))

  handle('session:connect', (id, profileId, cols, rows) =>
    core.connect(str(id, 'id'), str(profileId, 'profileId'), int(cols, 'cols'), int(rows, 'rows'), ask)
  )
  handle('session:openLocal', (id, cols, rows) => core.openLocal(str(id, 'id'), int(cols, 'cols'), int(rows, 'rows')))
  on('session:write', (id, data) => {
    if (typeof id === 'string' && typeof data === 'string') core.write(id, data)
  })
  on('session:resize', (id, cols, rows) => {
    if (typeof id === 'string' && Number.isInteger(cols) && Number.isInteger(rows)) {
      core.resize(id, cols as number, rows as number)
    }
  })
  handle('session:close', (id) => core.closeSession(str(id, 'id')))

  const sftp = (id: unknown) => core.sftp(str(id, 'id'))
  handle('sftp:home', async (id) => (await sftp(id)).home())
  handle('sftp:list', async (id, path) => (await sftp(id)).list(str(path, 'path')))
  handle('sftp:uploadDialog', async (id, dir) => {
    const win = getWindow()
    if (!win) return 0
    const client = await sftp(id)
    const r = await dialog.showOpenDialog(win, { title: 'Upload files', properties: ['openFile', 'multiSelections'] })
    if (r.canceled) return 0
    for (const p of r.filePaths) await client.upload(p, posix.join(str(dir, 'dir'), basename(p)))
    return r.filePaths.length
  })
  handle('sftp:uploadPaths', async (id, dir, paths) => {
    if (!Array.isArray(paths)) throw new Error('paths must be an array')
    const client = await sftp(id)
    for (const p of paths) await client.upload(str(p, 'path'), posix.join(str(dir, 'dir'), basename(p)))
  })
  handle('sftp:download', async (id, remotePath) => {
    const win = getWindow()
    if (!win) return false
    const client = await sftp(id)
    const r = await dialog.showSaveDialog(win, { defaultPath: posix.basename(str(remotePath, 'path')) })
    if (r.canceled || !r.filePath) return false
    await client.download(remotePath as string, r.filePath)
    return true
  })
  handle('sftp:rename', async (id, from, to) => (await sftp(id)).rename(str(from, 'from'), str(to, 'to')))
  handle('sftp:remove', async (id, path, isDir) => (await sftp(id)).remove(str(path, 'path'), isDir === true))
  handle('sftp:mkdir', async (id, path) => (await sftp(id)).mkdir(str(path, 'path')))

  const isAppImage = !!process.env.APPIMAGE
  handle('updates:check', () =>
    checkForUpdate(app.getVersion(), { platform: process.platform, arch: process.arch, isAppImage })
  )
  handle('updates:download', () => {
    if (!isAppImage) throw new Error('Only the AppImage can install updates itself')
    return downloadUpdate()
  })
  handle('updates:restart', () => {
    if (!isAppImage) throw new Error('Only the AppImage can install updates itself')
    return restartToUpdate()
  })

  handle('app:openExternal', async (url) => {
    const u = str(url, 'url')
    if (/^https?:\/\//i.test(u)) await shell.openExternal(u)
  })

  return () => prompts.cancelAll()
}
