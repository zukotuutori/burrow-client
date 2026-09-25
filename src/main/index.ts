import { app, BrowserWindow, powerMonitor, session, shell } from 'electron'
import { join } from 'node:path'
import { APP_URL } from './appPath'
import { registerAppScheme, serveAppFiles } from './appProtocol'
import { Core } from './core'
import { shouldIdleLock } from './idleLock'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'

// Fuses block --inspect, but Chromium's remote debugging switches cannot be fused off. In a packaged build
// another program could use them to watch the window (including typed passwords), so refuse to start.
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1)
}

// When launched without a terminal (desktop launcher, or the terminal was closed) stdout/stderr are dead
// pipes. Electron logs every IPC handler error with console.error, and the resulting EPIPE would otherwise
// crash the main process instead of returning the error to the window.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
}

// Only one copy may run: two copies on the same data would overwrite each other's saves.
if (!app.requestSingleInstanceLock()) app.exit(0)

// The UI is served from app://burrow instead of file://, so file:// needs no special privileges.
registerAppScheme()

let win: BrowserWindow | null = null
let cancelPrompts = (): void => undefined
const core = new Core(app.getPath('userData'), (channel, ...args) => win?.webContents.send(channel, ...args))

/** Locks the vault, closes sessions and prompts, and sends the window back to the unlock screen. */
function lockVault(): void {
  cancelPrompts()
  core.lock()
  win?.webContents.send('vault:locked')
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#15171c',
    title: 'Burrow Client',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // On Linux the spellchecker downloads Hunspell dictionaries from Google; keep the app fully local.
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  // Keep the window out of screenshots and screen recordings (macOS and Windows; not supported on Linux).
  win.setContentProtection(true)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.on('closed', () => {
    win = null
    lockVault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadURL(APP_URL)
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from electron-builder; in dev the dock would otherwise show Electron's.
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  session.defaultSession.setSpellCheckerEnabled(false)
  // Deny every web permission (camera, mic, location, notifications, ...) except the clipboard the app uses.
  const allowedPermissions = new Set<string>(['clipboard-read', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowedPermissions.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission))
  await core.init()
  serveAppFiles(join(__dirname, '../renderer'))
  cancelPrompts = registerIpc(core, () => win)
  app.on('second-instance', () => {
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  // Auto-lock when the machine sleeps or the screen locks ('lock-screen' exists on macOS and Windows only).
  powerMonitor.on('suspend', lockVault)
  powerMonitor.on('lock-screen', lockVault)
  // Auto-lock after the configured minutes without keyboard or mouse input anywhere on the machine.
  setInterval(() => {
    const idle = { idleSeconds: powerMonitor.getSystemIdleTime(), minutes: core.getSettings().autoLockMinutes }
    if (shouldIdleLock({ ...idle, unlocked: core.vault.isUnlocked })) lockVault()
  }, 15_000)
  // Pick up changes from other devices while nothing changes here.
  setInterval(() => void core.sync.syncIfLoggedIn(), 5 * 60_000)
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
