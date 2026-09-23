# Burrow Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Burrow Client, a local-first Termius-style SSH desktop app for macOS and Fedora with tabbed and split terminals, host profiles, snippets, key management, SFTP, known-hosts checks and an encrypted vault.

**Architecture:** Electron app. The main process owns all sensitive work (SSH via `ssh2`, SFTP, vault crypto, file storage) inside a plain TypeScript `Core` class that has no Electron imports and is covered by Vitest. A thin IPC layer exposes `Core` to a sandboxed React renderer through a typed preload bridge (`window.burrow`). Terminals are xterm.js instances managed outside React so they survive split-layout changes.

**Tech Stack:** Electron 44, electron-vite 5, Vite 7, React 19, TypeScript 5.9, xterm.js 6, ssh2 1.17, Vitest 5, electron-builder 26.

**Spec:** `docs/superpowers/specs/2026-09-23-ssh-client-design.md`

## Global Constraints

- App name: `Burrow Client`. `productName` in package.json is `Burrow Client`, so data lives in `app.getPath('userData')` = `~/Library/Application Support/Burrow Client/` (macOS) and `~/.config/Burrow Client/` (Linux).
- Files in the data dir: `profiles.json`, `snippets.json`, `settings.json`, `known_hosts.json`, `keys.json`, `vault.enc`. Plain files never contain passwords, passphrases or private keys.
- All file writes are atomic: write `<file>.tmp`, then rename. Files are created with mode `0o600`.
- Vault: scrypt `N=131072, r=8, p=1`, 16-byte salt, 32-byte key; AES-256-GCM with a new random 12-byte IV on every save.
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Renderer never receives private keys or stored passwords.
- Host key fingerprints are SHA256, formatted like OpenSSH: `SHA256:<base64 without padding>`.
- Keyboard shortcuts: macOS `Cmd+D` split right, `Cmd+Shift+D` split down, `Cmd+W` close pane. Linux `Ctrl+Shift+D` split right, `Ctrl+Shift+E` split down, `Ctrl+Shift+W` close pane (plain `Ctrl+D`/`Ctrl+W` belong to the shell on Linux). Linux copy/paste in the terminal: `Ctrl+Shift+C` / `Ctrl+Shift+V`.
- Do not set `"type": "module"` in package.json. The sandboxed preload must be CommonJS.
- Import ssh2 as `import ssh2 from 'ssh2'` and destructure (`const { Client, utils } = ssh2`), types via `import type { ... } from 'ssh2'`. This works both in Vitest (Node ESM importing CJS) and in the electron-vite CJS bundle.
- No React StrictMode (terminal hosts are created and disposed imperatively).
- Commit messages have no Claude co-author or "Generated with" trailers.

## File Map

```
package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts, .gitignore, README.md
scripts/dev-ssh-server.ts          local echo SSH + SFTP server for manual testing
src/shared/types.ts                data types shared by all processes
src/shared/api.ts                  BurrowApi interface (window.burrow)
src/main/index.ts                  app lifecycle, window
src/main/menu.ts                   application menu (macOS only)
src/main/ipc.ts                    IPC handlers, prompt round-trips, dialogs
src/main/core.ts                   Core: storage + vault + sessions, no Electron imports
src/main/validate.ts               input validation for profiles, snippets, settings
src/main/store/jsonFile.ts         readJson, atomic writes, backups
src/main/store/jsonDoc.ts          JsonDoc<T>: one JSON file in memory, broken-file handling
src/main/store/repo.ts             Repo<T>: list of {id} records on a JsonDoc
src/main/vault/crypto.ts           scrypt + AES-256-GCM seal/open
src/main/vault/vault.ts            Vault: create, unlock, lock, secrets
src/main/keys/keys.ts              generate/import keys, fingerprints
src/main/ssh/hostkeys.ts           known-hosts check
src/main/ssh/session.ts            SshSession: one connection + PTY shell
src/main/ssh/sftp.ts               SftpClient wrapper
src/preload/index.ts               contextBridge implementation of BurrowApi
src/renderer/index.html
src/renderer/src/main.tsx, App.tsx, api.ts, env.d.ts, util.ts, icons.tsx, toast.tsx, data.tsx, styles.css
src/renderer/src/UnlockScreen.tsx, PromptDialog.tsx, HomeView.tsx, Main.tsx, TabBar.tsx
src/renderer/src/components/     Modal, Field, SidePanel, Empty, TextPrompt
src/renderer/src/views/          HostsView, HostForm, KeychainView, SnippetsView, KnownHostsView, SettingsView
src/renderer/src/session/        layout.ts, shortcuts.ts, terminalHost.ts, SessionTab.tsx, SplitView.tsx,
                                 PaneSlot.tsx, SnippetsDrawer.tsx, SftpBrowser.tsx
tests/                           store, vault, keys, hostkeys, session, sftp, core, layout tests
tests/helpers/                   sshServer.ts (in-process ssh2 server with SFTP), waitFor.ts
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`
- Create: `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`

**Interfaces:**
- Produces: all shared types in `src/shared/types.ts` (used by every later task, exact names below).

- [ ] **Step 1: Create package.json**

```json
{
  "name": "burrow-client",
  "productName": "Burrow Client",
  "version": "0.1.0",
  "description": "Local-first SSH client",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install ssh2@1.17.0
npm install -D electron@44.4.5 electron-vite@5.0.0 electron-builder@26.15.3 vite@7.3.6 @vitejs/plugin-react@5.2.0 typescript@5.9.3 vitest@5.0.1 @types/node@24 @types/ssh2@1.15.6 react@19.3.0 react-dom@19.3.0 @types/react@19 @types/react-dom@19 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-web-links@0.12.0 tsx
```
Expected: installs without peer dependency errors. React and xterm are devDependencies on purpose: they are bundled into the renderer, so they do not need to ship in `node_modules` inside the app. Only `ssh2` is a runtime dependency of the main process.

- [ ] **Step 3: Create config files**

`.gitignore`:
```
node_modules/
out/
dist/
*.tmp
.DS_Store
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src", "tests", "scripts", "electron.vite.config.ts", "vitest.config.ts"]
}
```

`electron.vite.config.ts`:
```ts
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000
  }
})
```

- [ ] **Step 4: Create shared types**

`src/shared/types.ts`:
```ts
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
}

export interface Snippet {
  id: string
  name: string
  command: string
  tags?: string[]
}

export interface Settings {
  fontFamily: string
  fontSize: number
  theme: 'dark' | 'light'
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
```

- [ ] **Step 5: Create minimal main, preload and renderer**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
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
      sandbox: true
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
```

`src/preload/index.ts`:
```ts
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('burrow', { platform: process.platform })
```

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
    />
    <title>Burrow Client</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')!).render(<h1>Burrow Client</h1>)
```

- [ ] **Step 6: Verify typecheck and build**

Run: `npm run typecheck && npm run build && ls out/main out/preload out/renderer`
Expected: no type errors; `out/main/index.js`, `out/preload/index.js`, `out/renderer/index.html` exist. If the preload is emitted as `index.mjs`, package.json accidentally has `"type": "module"`; remove it.

- [ ] **Step 7: Verify the window opens**

Run: `npm run dev` (in the background), wait a few seconds, check the log shows the dev server URL and no errors, then stop it.
Expected: an Electron window titled "Burrow Client" showing the heading.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore tsconfig.json electron.vite.config.ts vitest.config.ts src
git commit -m "Scaffold Electron app with electron-vite and React"
```

---

### Task 2: JSON file store

**Files:**
- Create: `src/main/store/jsonFile.ts`, `src/main/store/jsonDoc.ts`, `src/main/store/repo.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Produces:
  - `class CorruptFileError extends Error { readonly file: string }`
  - `readText(file: string): Promise<string | undefined>` (undefined when missing)
  - `readJson<T>(file: string, fallback: T): Promise<T>` (throws `CorruptFileError` on bad JSON)
  - `writeFileAtomic(file: string, contents: string): Promise<void>`
  - `writeJsonAtomic(file: string, data: unknown): Promise<void>`
  - `backupFile(file: string, now?: Date): Promise<string | undefined>` (copies to `<file>.broken-<timestamp>`, returns the path)
  - `class JsonDoc<T> { constructor(file: string, fallback: T); readonly file: string; load(): Promise<void>; get value(): T; get isBroken(): boolean; set(value: T): Promise<void>; reset(): Promise<string | undefined> }`
  - `class Repo<T extends { id: string }> { constructor(file: string); readonly doc: JsonDoc<T[]>; load(): Promise<void>; list(): T[]; get(id: string): T | undefined; upsert(item: T): Promise<void>; remove(id: string): Promise<void> }`

- [ ] **Step 1: Write the failing tests**

`tests/store.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorruptFileError, readJson, writeJsonAtomic } from '../src/main/store/jsonFile'
import { JsonDoc } from '../src/main/store/jsonDoc'
import { Repo } from '../src/main/store/repo'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'burrow-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('jsonFile', () => {
  it('returns the fallback when the file is missing', async () => {
    expect(await readJson(join(dir, 'x.json'), { a: 1 })).toEqual({ a: 1 })
  })

  it('writes atomically and reads back', async () => {
    const file = join(dir, 'x.json')
    await writeJsonAtomic(file, { hello: 'world' })
    expect(await readJson(file, {})).toEqual({ hello: 'world' })
    expect(await readdir(dir)).toEqual(['x.json'])
  })

  it('throws CorruptFileError for invalid JSON', async () => {
    const file = join(dir, 'x.json')
    await writeFile(file, '{nope')
    await expect(readJson(file, {})).rejects.toBeInstanceOf(CorruptFileError)
  })
})

describe('JsonDoc', () => {
  it('blocks writes to a broken file until reset, and keeps a backup', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{nope')
    const doc = new JsonDoc(file, { n: 0 })
    await expect(doc.load()).rejects.toBeInstanceOf(CorruptFileError)
    expect(doc.isBroken).toBe(true)
    await expect(doc.set({ n: 1 })).rejects.toThrow(/Reset it first/)
    expect(await readFile(file, 'utf8')).toBe('{nope')

    const backup = await doc.reset()
    expect(backup).toMatch(/settings\.json\.broken-/)
    expect(await readFile(backup!, 'utf8')).toBe('{nope')
    expect(await readJson(file, null)).toEqual({ n: 0 })
    await doc.set({ n: 2 })
    expect(doc.value).toEqual({ n: 2 })
  })

  it('serializes concurrent writes', async () => {
    const file = join(dir, 'd.json')
    const doc = new JsonDoc(file, 0)
    await Promise.all([doc.set(1), doc.set(2), doc.set(3)])
    expect(await readJson(file, null)).toBe(3)
  })
})

describe('Repo', () => {
  it('inserts, updates in place, removes and persists', async () => {
    const file = join(dir, 'items.json')
    const repo = new Repo<{ id: string; v: number }>(file)
    await repo.load()
    await repo.upsert({ id: 'a', v: 1 })
    await repo.upsert({ id: 'b', v: 2 })
    await repo.upsert({ id: 'a', v: 3 })
    expect(repo.list()).toEqual([
      { id: 'a', v: 3 },
      { id: 'b', v: 2 }
    ])
    await repo.remove('a')

    const again = new Repo<{ id: string; v: number }>(file)
    await again.load()
    expect(again.list()).toEqual([{ id: 'b', v: 2 }])
    expect(again.get('b')).toEqual({ id: 'b', v: 2 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL, cannot resolve `../src/main/store/jsonFile`.

- [ ] **Step 3: Implement the store**

`src/main/store/jsonFile.ts`:
```ts
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export class CorruptFileError extends Error {
  constructor(
    readonly file: string,
    cause: unknown
  ) {
    super(`${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CorruptFileError'
  }
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const text = await readText(file)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new CorruptFileError(file, e)
  }
}

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, contents, { mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n')
}

export async function backupFile(file: string, now = new Date()): Promise<string | undefined> {
  const target = `${file}.broken-${now.toISOString().replace(/[:.]/g, '-')}`
  try {
    await fs.copyFile(file, target)
    return target
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
}
```

`src/main/store/jsonDoc.ts`:
```ts
import { basename } from 'node:path'
import { backupFile, CorruptFileError, readJson, writeJsonAtomic } from './jsonFile'

/** One JSON file held in memory. A file that fails to parse is marked broken and never overwritten until reset. */
export class JsonDoc<T> {
  private data: T
  private broken = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly fallback: T
  ) {
    this.data = structuredClone(fallback)
  }

  async load(): Promise<void> {
    try {
      this.data = await readJson(this.file, structuredClone(this.fallback))
      this.broken = false
    } catch (e) {
      if (e instanceof CorruptFileError) {
        this.broken = true
        this.data = structuredClone(this.fallback)
      }
      throw e
    }
  }

  get value(): T {
    return this.data
  }

  get isBroken(): boolean {
    return this.broken
  }

  set(value: T): Promise<void> {
    if (this.broken) {
      return Promise.reject(new Error(`${basename(this.file)} could not be read. Reset it first.`))
    }
    this.data = value
    const write = this.queue.catch(() => undefined).then(() => writeJsonAtomic(this.file, value))
    this.queue = write
    return write
  }

  /** Copies the current file to a backup, then writes the fallback value. */
  async reset(): Promise<string | undefined> {
    const backup = await backupFile(this.file)
    this.broken = false
    await this.set(structuredClone(this.fallback))
    return backup
  }
}
```

`src/main/store/repo.ts`:
```ts
import { JsonDoc } from './jsonDoc'

export class Repo<T extends { id: string }> {
  readonly doc: JsonDoc<T[]>

  constructor(file: string) {
    this.doc = new JsonDoc<T[]>(file, [])
  }

  load(): Promise<void> {
    return this.doc.load()
  }

  list(): T[] {
    return this.doc.value
  }

  get(id: string): T | undefined {
    return this.doc.value.find((x) => x.id === id)
  }

  async upsert(item: T): Promise<void> {
    const next = [...this.doc.value]
    const i = next.findIndex((x) => x.id === item.id)
    if (i >= 0) next[i] = item
    else next.push(item)
    await this.doc.set(next)
  }

  async remove(id: string): Promise<void> {
    await this.doc.set(this.doc.value.filter((x) => x.id !== id))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/store tests/store.test.ts
git commit -m "Add atomic JSON file store"
```

---

### Task 3: Encrypted vault

**Files:**
- Create: `src/main/vault/crypto.ts`, `src/main/vault/vault.ts`
- Test: `tests/vault.test.ts`

**Interfaces:**
- Consumes: `readText`, `writeFileAtomic`, `backupFile`, `CorruptFileError` from Task 2; `VaultStatus` from types.
- Produces:
  - `interface KdfParams { N: number; r: number; p: number }`, `DEFAULT_KDF: KdfParams` (`{ N: 131072, r: 8, p: 1 }`)
  - `class WrongPasswordError extends Error` (message `Wrong password`)
  - `interface KeySecret { privateKey: string; passphrase?: string }`
  - `class VaultLockedError extends Error` (message `Vault is locked`)
  - `class Vault { constructor(file: string, params?: KdfParams); status(): Promise<VaultStatus>; create(password: string): Promise<void>; unlock(password: string): Promise<void>; lock(): void; get isUnlocked(): boolean; getPassword(profileId: string): string | undefined; setPassword(profileId: string, password: string | undefined): Promise<void>; getKey(keyId: string): KeySecret | undefined; setKey(keyId: string, secret: KeySecret | undefined): Promise<void>; reset(): Promise<string | undefined> }`

- [ ] **Step 1: Write the failing tests**

`tests/vault.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault, VaultLockedError } from '../src/main/vault/vault'
import { WrongPasswordError, type KdfParams } from '../src/main/vault/crypto'

const FAST: KdfParams = { N: 1024, r: 8, p: 1 }
let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'burrow-vault-'))
  file = join(dir, 'vault.enc')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('Vault', () => {
  it('creates a vault and keeps secrets out of the file in plain text', async () => {
    const v = new Vault(file, FAST)
    expect(await v.status()).toBe('missing')
    await v.create('master')
    expect(await v.status()).toBe('unlocked')
    await v.setPassword('p1', 'hunter2-secret')
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('hunter2-secret')
    expect(JSON.parse(text)).toMatchObject({ version: 1, kdf: 'scrypt', N: 1024, r: 8, p: 1 })
  })

  it('locks, rejects a wrong password and unlocks with the right one', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    await v.setKey('k1', { privateKey: 'PRIVATE', passphrase: 'pp' })
    v.lock()
    expect(await v.status()).toBe('locked')
    expect(() => v.getKey('k1')).toThrow(VaultLockedError)
    await expect(v.unlock('nope')).rejects.toBeInstanceOf(WrongPasswordError)

    const fresh = new Vault(file, FAST)
    await fresh.unlock('master')
    expect(fresh.getKey('k1')).toEqual({ privateKey: 'PRIVATE', passphrase: 'pp' })
  })

  it('removes secrets when set to undefined', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    await v.setPassword('p1', 'x')
    await v.setPassword('p1', undefined)
    expect(v.getPassword('p1')).toBeUndefined()
  })

  it('detects a tampered ciphertext', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    const data = JSON.parse(await readFile(file, 'utf8'))
    const bytes = Buffer.from(data.ciphertext, 'base64')
    bytes[0] ^= 0xff
    data.ciphertext = bytes.toString('base64')
    await writeFile(file, JSON.stringify(data))
    await expect(new Vault(file, FAST).unlock('master')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('uses a new IV on every save', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    const iv1 = JSON.parse(await readFile(file, 'utf8')).iv
    await v.setPassword('p1', 'x')
    const iv2 = JSON.parse(await readFile(file, 'utf8')).iv
    expect(iv1).not.toBe(iv2)
  })

  it('reports a broken file and resets it with a backup', async () => {
    await writeFile(file, 'garbage')
    const v = new Vault(file, FAST)
    expect(await v.status()).toBe('broken')
    const backup = await v.reset()
    expect(backup).toMatch(/vault\.enc\.broken-/)
    expect(await v.status()).toBe('missing')
    expect((await readdir(dir)).some((f) => f.startsWith('vault.enc.broken-'))).toBe(true)
  })

  it('refuses to create over an existing vault', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    v.lock()
    await expect(v.create('other')).rejects.toThrow(/already exists/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/vault.test.ts`
Expected: FAIL, cannot resolve `../src/main/vault/vault`.

- [ ] **Step 3: Implement crypto**

`src/main/vault/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'

export interface KdfParams {
  N: number
  r: number
  p: number
}

export const DEFAULT_KDF: KdfParams = { N: 131072, r: 8, p: 1 }

export interface VaultFile extends KdfParams {
  version: 1
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password')
    this.name = 'WrongPasswordError'
  }
}

export function deriveKey(password: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

export function seal(plaintext: string, key: Buffer, salt: Buffer, params: KdfParams): VaultFile {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    version: 1,
    kdf: 'scrypt',
    N: params.N,
    r: params.r,
    p: params.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

/** Throws WrongPasswordError when the key is wrong or the file was modified (GCM cannot tell these apart). */
export function open(file: VaultFile, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
  try {
    return Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new WrongPasswordError()
  }
}

export function isVaultFile(x: unknown): x is VaultFile {
  const f = x as VaultFile
  return (
    !!f &&
    f.version === 1 &&
    f.kdf === 'scrypt' &&
    [f.N, f.r, f.p].every((n) => Number.isInteger(n) && n > 0) &&
    [f.salt, f.iv, f.tag, f.ciphertext].every((s) => typeof s === 'string')
  )
}
```

- [ ] **Step 4: Implement the Vault**

`src/main/vault/vault.ts`:
```ts
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { VaultStatus } from '../../shared/types'
import { backupFile, CorruptFileError, readText, writeFileAtomic } from '../store/jsonFile'
import { DEFAULT_KDF, deriveKey, isVaultFile, open, seal, type KdfParams } from './crypto'

export interface KeySecret {
  privateKey: string
  passphrase?: string
}

interface VaultData {
  version: 1
  passwords: Record<string, string>
  keys: Record<string, KeySecret>
}

interface Unlocked {
  key: Buffer
  salt: Buffer
  params: KdfParams
  data: VaultData
}

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked')
    this.name = 'VaultLockedError'
  }
}

export class Vault {
  private state: Unlocked | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly params: KdfParams = DEFAULT_KDF
  ) {}

  async status(): Promise<VaultStatus> {
    if (this.state) return 'unlocked'
    const text = await readText(this.file)
    if (text === undefined) return 'missing'
    try {
      return isVaultFile(JSON.parse(text)) ? 'locked' : 'broken'
    } catch {
      return 'broken'
    }
  }

  async create(password: string): Promise<void> {
    if ((await this.status()) !== 'missing') throw new Error('A vault already exists')
    if (!password) throw new Error('Password must not be empty')
    const salt = randomBytes(16)
    const key = await deriveKey(password, salt, this.params)
    this.state = { key, salt, params: this.params, data: { version: 1, passwords: {}, keys: {} } }
    await this.save()
  }

  async unlock(password: string): Promise<void> {
    const text = await readText(this.file)
    if (text === undefined) throw new Error('No vault exists yet')
    let file: unknown
    try {
      file = JSON.parse(text)
    } catch (e) {
      throw new CorruptFileError(this.file, e)
    }
    if (!isVaultFile(file)) throw new CorruptFileError(this.file, 'unexpected format')
    const params = { N: file.N, r: file.r, p: file.p }
    const salt = Buffer.from(file.salt, 'base64')
    const key = await deriveKey(password, salt, params)
    const data = JSON.parse(open(file, key)) as VaultData
    this.state = { key, salt, params, data }
  }

  lock(): void {
    this.state?.key.fill(0)
    this.state = null
  }

  get isUnlocked(): boolean {
    return this.state !== null
  }

  getPassword(profileId: string): string | undefined {
    return this.unlocked.data.passwords[profileId]
  }

  async setPassword(profileId: string, password: string | undefined): Promise<void> {
    const { passwords } = this.unlocked.data
    if (password === undefined) delete passwords[profileId]
    else passwords[profileId] = password
    await this.save()
  }

  getKey(keyId: string): KeySecret | undefined {
    return this.unlocked.data.keys[keyId]
  }

  async setKey(keyId: string, secret: KeySecret | undefined): Promise<void> {
    const { keys } = this.unlocked.data
    if (secret === undefined) delete keys[keyId]
    else keys[keyId] = secret
    await this.save()
  }

  /** Backs up the current file and deletes it, so a new vault can be created. */
  async reset(): Promise<string | undefined> {
    this.lock()
    const backup = await backupFile(this.file)
    await fs.rm(this.file, { force: true })
    return backup
  }

  private get unlocked(): Unlocked {
    if (!this.state) throw new VaultLockedError()
    return this.state
  }

  private save(): Promise<void> {
    const s = this.unlocked
    const contents = JSON.stringify(seal(JSON.stringify(s.data), s.key, s.salt, s.params), null, 2)
    const write = this.queue.catch(() => undefined).then(() => writeFileAtomic(this.file, contents))
    this.queue = write
    return write
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/vault.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/vault tests/vault.test.ts
git commit -m "Add scrypt + AES-256-GCM vault"
```

---

### Task 4: Key management

**Files:**
- Create: `src/main/keys/keys.ts`
- Test: `tests/keys.test.ts`

**Interfaces:**
- Consumes: `KeyType` from types.
- Produces:
  - `interface KeyMaterial { type: string; publicKey: string; fingerprint: string; privateKey: string }`
  - `class NeedsPassphraseError extends Error`, `class KeyParseError extends Error`
  - `fingerprint(publicSSH: Buffer): string` (`SHA256:...`)
  - `importKey(privateKey: string, passphrase?: string, comment?: string): KeyMaterial`
  - `isEncrypted(privateKey: string): boolean`
  - `generateKey(type: KeyType, comment: string): Promise<KeyMaterial>`

- [ ] **Step 1: Write the failing tests**

`tests/keys.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { generateKey, importKey, isEncrypted, KeyParseError, NeedsPassphraseError } from '../src/main/keys/keys'

const FP = /^SHA256:[A-Za-z0-9+/]{43}$/

describe('keys', () => {
  it('generates an ed25519 key', async () => {
    const k = await generateKey('ed25519', 'laptop')
    expect(k.type).toBe('ssh-ed25519')
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ laptop$/)
    expect(k.fingerprint).toMatch(FP)
    expect(k.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY')
  })

  it('generates an RSA key', async () => {
    const k = await generateKey('rsa', 'old-box')
    expect(k.type).toBe('ssh-rsa')
    expect(k.fingerprint).toMatch(FP)
  })

  it('imports a generated key with the same fingerprint', async () => {
    const k = await generateKey('ed25519', 'x')
    expect(importKey(k.privateKey).fingerprint).toBe(k.fingerprint)
  })

  it('imports a PEM RSA key', () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    })
    expect(importKey(privateKey).type).toBe('ssh-rsa')
  })

  it('asks for a passphrase for encrypted keys', () => {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr' })
    expect(isEncrypted(pair.private)).toBe(true)
    expect(() => importKey(pair.private)).toThrow(NeedsPassphraseError)
    expect(importKey(pair.private, 'secret').type).toBe('ssh-ed25519')
    expect(() => importKey(pair.private, 'wrong')).toThrow(KeyParseError)
  })

  it('rejects garbage', () => {
    expect(() => importKey('not a key')).toThrow(KeyParseError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/keys.test.ts`
Expected: FAIL, cannot resolve `../src/main/keys/keys`.

- [ ] **Step 3: Implement keys**

`src/main/keys/keys.ts`:
```ts
import { createHash } from 'node:crypto'
import ssh2 from 'ssh2'
import type { ParsedKey } from 'ssh2'
import type { KeyType } from '../../shared/types'

const { utils } = ssh2

export interface KeyMaterial {
  type: string
  publicKey: string
  fingerprint: string
  privateKey: string
}

export class NeedsPassphraseError extends Error {
  constructor() {
    super('This key is encrypted. Enter its passphrase.')
    this.name = 'NeedsPassphraseError'
  }
}

export class KeyParseError extends Error {
  constructor(message: string) {
    super(`Could not read key: ${message}`)
    this.name = 'KeyParseError'
  }
}

export function fingerprint(publicSSH: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicSSH).digest('base64').replace(/=+$/, '')
}

function parsePrivate(privateKey: string, passphrase?: string): ParsedKey {
  const parsed = utils.parseKey(privateKey, passphrase)
  if (parsed instanceof Error) {
    if (/no passphrase given/i.test(parsed.message)) throw new NeedsPassphraseError()
    throw new KeyParseError(parsed.message)
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || !key.isPrivateKey()) throw new KeyParseError('not a private key')
  return key
}

export function importKey(privateKey: string, passphrase?: string, comment = ''): KeyMaterial {
  const key = parsePrivate(privateKey, passphrase || undefined)
  const pub = key.getPublicSSH()
  return {
    type: key.type,
    publicKey: `${key.type} ${pub.toString('base64')}${comment ? ` ${comment}` : ''}`,
    fingerprint: fingerprint(pub),
    privateKey
  }
}

export function isEncrypted(privateKey: string): boolean {
  try {
    parsePrivate(privateKey)
    return false
  } catch (e) {
    if (e instanceof NeedsPassphraseError) return true
    throw e
  }
}

export function generateKey(type: KeyType, comment: string): Promise<KeyMaterial> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, keys: { private: string; public: string }) => {
      if (err) return reject(err)
      resolve(importKey(keys.private, undefined, comment))
    }
    if (type === 'rsa') utils.generateKeyPair('rsa', { bits: 4096, comment }, done)
    else utils.generateKeyPair('ed25519', { comment }, done)
  })
}
```

Note: if `@types/ssh2` types the `generateKeyPair` callback slightly differently (e.g. `err: Error | undefined`), adjust the `done` signature to match; behavior stays the same.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/keys.test.ts`
Expected: PASS (6 tests). If the wrong-passphrase case throws `NeedsPassphraseError` instead of `KeyParseError`, print the ssh2 error message and tighten the regex in `parsePrivate` to match only the "no passphrase given" case.

- [ ] **Step 5: Commit**

```bash
git add src/main/keys tests/keys.test.ts
git commit -m "Add SSH key generation and import"
```

---
### Task 5: SSH session, host key check and test server

**Files:**
- Create: `src/main/ssh/hostkeys.ts`, `src/main/ssh/session.ts`
- Create: `tests/helpers/waitFor.ts`, `tests/helpers/sshServer.ts`
- Test: `tests/hostkeys.test.ts`, `tests/session.test.ts`

**Interfaces:**
- Consumes: `fingerprint` from Task 4; `KnownHosts`, `HostKeyCheck` from types.
- Produces:
  - `hostId(host: string, port: number): string` (`"host:port"`)
  - `checkHostKey(known: KnownHosts, host: string, port: number, algo: string, fingerprint: string): HostKeyCheck`
  - `interface ConnectOptions { host: string; port: number; username: string; password?: string; privateKey?: string; passphrase?: string; cols: number; rows: number; verifyHostKey(algo: string, fingerprint: string): Promise<boolean>; readyTimeout?: number }`
  - `interface SessionHandlers { onData(data: string): void; onClose(reason?: string): void }`
  - `describeError(err: unknown): string`
  - `class SshSession { static open(opts: ConnectOptions, handlers: SessionHandlers): Promise<SshSession>; write(data: string): void; resize(cols: number, rows: number): void; sftp(): Promise<SFTPWrapper>; close(): void }`
  - Test helper: `startTestServer(opts: { user: string; password?: string; publicKey?: string; sftpRoot?: string; port?: number }): Promise<TestServer>` with `TestServer { port: number; hostKey: string; resizes: { cols: number; rows: number }[]; dropClients(): void; close(): Promise<void> }`. The shell echoes input, turns `\r` into `\r\n$ `, and starts with `welcome\r\n$ `.
  - Test helper: `waitFor(cond: () => boolean, timeoutMs?: number): Promise<void>`

- [ ] **Step 1: Write the host key tests**

`tests/hostkeys.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { checkHostKey, hostId } from '../src/main/ssh/hostkeys'

const known = { 'example.com:22': { algo: 'ssh-ed25519', fingerprint: 'SHA256:aaa', addedAt: '2026-01-01' } }

describe('checkHostKey', () => {
  it('builds ids from host and port', () => {
    expect(hostId('example.com', 2222)).toBe('example.com:2222')
  })
  it('reports unknown hosts', () => {
    expect(checkHostKey(known, 'other', 22, 'ssh-ed25519', 'SHA256:bbb')).toEqual({
      state: 'unknown',
      algo: 'ssh-ed25519',
      fingerprint: 'SHA256:bbb'
    })
  })
  it('matches known fingerprints', () => {
    expect(checkHostKey(known, 'example.com', 22, 'ssh-ed25519', 'SHA256:aaa')).toEqual({ state: 'match' })
  })
  it('reports changed fingerprints with the old value', () => {
    expect(checkHostKey(known, 'example.com', 22, 'ssh-ed25519', 'SHA256:ccc')).toEqual({
      state: 'changed',
      algo: 'ssh-ed25519',
      fingerprint: 'SHA256:ccc',
      oldFingerprint: 'SHA256:aaa'
    })
  })
  it('treats a different port as a different host', () => {
    expect(checkHostKey(known, 'example.com', 2222, 'ssh-ed25519', 'SHA256:aaa').state).toBe('unknown')
  })
})
```

- [ ] **Step 2: Create test helpers**

`tests/helpers/waitFor.ts`:
```ts
export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

`tests/helpers/sshServer.ts`:
```ts
import { promises as fs, type Stats } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, posix } from 'node:path'
import ssh2 from 'ssh2'
import type { Connection, ParsedKey, SFTPWrapper } from 'ssh2'

const { Server, utils } = ssh2
const { STATUS_CODE, flagsToString } = utils.sftp

export interface TestServerOptions {
  user: string
  password?: string
  /** OpenSSH public key line allowed to log in. */
  publicKey?: string
  /** Directory served over SFTP. SFTP is refused when unset. */
  sftpRoot?: string
  port?: number
}

export interface TestServer {
  port: number
  hostKey: string
  resizes: { cols: number; rows: number }[]
  dropClients(): void
  close(): Promise<void>
}

export async function startTestServer(opts: TestServerOptions): Promise<TestServer> {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const allowed = opts.publicKey ? (utils.parseKey(opts.publicKey) as ParsedKey) : undefined
  const clients = new Set<Connection>()
  const resizes: { cols: number; rows: number }[] = []

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== opts.user) return ctx.reject()
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) {
        return ctx.accept()
      }
      if (
        ctx.method === 'publickey' &&
        allowed &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.equals(allowed.getPublicSSH())
      ) {
        if (!ctx.signature) return ctx.accept()
        if (allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) return ctx.accept()
      }
      ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept, _reject, info) => {
          resizes.push({ cols: info.cols, rows: info.rows })
          accept?.()
        })
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('welcome\r\n$ ')
          stream.on('data', (d: Buffer) => stream.write(d.toString('utf8').replace(/\r/g, '\r\n$ ')))
        })
        session.on('sftp', (accept, reject) => {
          if (!opts.sftpRoot) return reject?.()
          serveSftp(accept(), opts.sftpRoot)
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    hostKey,
    resizes,
    dropClients: () => clients.forEach((c) => c.end()),
    close: () =>
      new Promise<void>((resolve) => {
        clients.forEach((c) => c.end())
        server.close(() => resolve())
      })
  }
}

interface Handle {
  path: string
  file?: fs.FileHandle
  names?: string[]
}

function serveSftp(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<number, Handle>()
  let nextHandle = 0
  const real = (p: string) => join(root, posix.normalize('/' + p))
  const makeHandle = (h: Handle) => {
    const id = nextHandle++
    handles.set(id, h)
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id)
    return buf
  }
  const getHandle = (buf: Buffer) => handles.get(buf.readUInt32BE(0))
  const attrs = (s: Stats) => ({
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    size: s.size,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000)
  })
  const guard = (reqid: number, fn: () => Promise<unknown>) => {
    fn().catch(() => sftp.status(reqid, STATUS_CODE.FAILURE))
  }
  const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK)

  sftp.on('REALPATH', (reqid, p) => {
    const n = posix.normalize('/' + p)
    sftp.name(reqid, [{ filename: n, longname: n, attrs: {} as never }])
  })
  const stat = (reqid: number, p: string) => guard(reqid, async () => sftp.attrs(reqid, attrs(await fs.stat(real(p)))))
  sftp.on('STAT', stat)
  sftp.on('LSTAT', stat)
  sftp.on('OPENDIR', (reqid, p) =>
    guard(reqid, async () => {
      const names = await fs.readdir(real(p))
      sftp.handle(reqid, makeHandle({ path: real(p), names }))
    })
  )
  sftp.on('READDIR', (reqid, hbuf) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.names) throw new Error('bad handle')
      if (h.names.length === 0) return sftp.status(reqid, STATUS_CODE.EOF)
      const names = h.names.splice(0)
      const entries = await Promise.all(
        names.map(async (n) => ({ filename: n, longname: n, attrs: attrs(await fs.stat(join(h.path, n))) }))
      )
      sftp.name(reqid, entries)
    })
  )
  sftp.on('OPEN', (reqid, p, flags) =>
    guard(reqid, async () => {
      const file = await fs.open(real(p), flagsToString(flags) ?? 'r')
      sftp.handle(reqid, makeHandle({ path: real(p), file }))
    })
  )
  sftp.on('READ', (reqid, hbuf, offset, length) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      const buf = Buffer.alloc(length)
      const { bytesRead } = await h.file.read(buf, 0, length, offset)
      if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, buf.subarray(0, bytesRead))
    })
  )
  sftp.on('WRITE', (reqid, hbuf, offset, data) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      await h.file.write(data, 0, data.length, offset)
      ok(reqid)
    })
  )
  sftp.on('FSTAT', (reqid, hbuf) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      sftp.attrs(reqid, attrs(await h.file.stat()))
    })
  )
  sftp.on('FSETSTAT', (reqid) => ok(reqid))
  sftp.on('SETSTAT', (reqid) => ok(reqid))
  sftp.on('CLOSE', (reqid, hbuf) =>
    guard(reqid, async () => {
      const id = hbuf.readUInt32BE(0)
      const h = handles.get(id)
      handles.delete(id)
      await h?.file?.close()
      ok(reqid)
    })
  )
  sftp.on('REMOVE', (reqid, p) => guard(reqid, async () => (await fs.unlink(real(p)), ok(reqid))))
  sftp.on('RMDIR', (reqid, p) => guard(reqid, async () => (await fs.rmdir(real(p)), ok(reqid))))
  sftp.on('MKDIR', (reqid, p) => guard(reqid, async () => (await fs.mkdir(real(p)), ok(reqid))))
  sftp.on('RENAME', (reqid, a, b) => guard(reqid, async () => (await fs.rename(real(a), real(b)), ok(reqid))))
}
```

- [ ] **Step 3: Write the session tests**

`tests/session.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest'
import ssh2 from 'ssh2'
import type { ParsedKey } from 'ssh2'
import { describeError, SshSession, type ConnectOptions } from '../src/main/ssh/session'
import { fingerprint, generateKey } from '../src/main/keys/keys'
import { startTestServer, type TestServer } from './helpers/sshServer'
import { waitFor } from './helpers/waitFor'

let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

function collector() {
  const state = { out: '', closed: null as string | null }
  return {
    state,
    handlers: {
      onData: (d: string) => {
        state.out += d
      },
      onClose: (r?: string) => {
        state.closed = r ?? ''
      }
    }
  }
}

const base = (port: number, extra: Partial<ConnectOptions>): ConnectOptions => ({
  host: '127.0.0.1',
  port,
  username: 'alice',
  cols: 80,
  rows: 24,
  verifyHostKey: async () => true,
  ...extra
})

describe('SshSession', () => {
  it('connects with a password, streams output and sends input', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const c = collector()
    const s = await SshSession.open(base(server.port, { password: 'pw' }), c.handlers)
    await waitFor(() => c.state.out.includes('welcome'))
    s.write('hi')
    await waitFor(() => c.state.out.includes('$ hi'))
    s.close()
    await waitFor(() => c.state.closed !== null)
  })

  it('reports a wrong password as an authentication failure', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await expect(SshSession.open(base(server.port, { password: 'nope' }), collector().handlers)).rejects.toThrow(
      'Authentication failed'
    )
  })

  it('connects with a key', async () => {
    const key = await generateKey('ed25519', 'test')
    server = await startTestServer({ user: 'alice', publicKey: key.publicKey })
    const s = await SshSession.open(base(server.port, { privateKey: key.privateKey }), collector().handlers)
    s.close()
  })

  it('connects with an encrypted key and its passphrase', async () => {
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr' })
    server = await startTestServer({ user: 'alice', publicKey: pair.public })
    const s = await SshSession.open(
      base(server.port, { privateKey: pair.private, passphrase: 'secret' }),
      collector().handlers
    )
    s.close()
  })

  it('passes the host key type and fingerprint to the verifier', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const seen: [string, string][] = []
    const s = await SshSession.open(
      base(server.port, {
        password: 'pw',
        verifyHostKey: async (algo, fp) => {
          seen.push([algo, fp])
          return true
        }
      }),
      collector().handlers
    )
    const hostPub = ssh2.utils.parseKey(server.hostKey) as ParsedKey
    expect(seen).toEqual([['ssh-ed25519', fingerprint(hostPub.getPublicSSH())]])
    s.close()
  })

  it('aborts when the host key is not trusted', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await expect(
      SshSession.open(base(server.port, { password: 'pw', verifyHostKey: async () => false }), collector().handlers)
    ).rejects.toThrow('Host key rejected')
  })

  it('forwards terminal resizes', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const s = await SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)
    s.resize(100, 40)
    await waitFor(() => server!.resizes.some((r) => r.cols === 100 && r.rows === 40))
    s.close()
  })

  it('reports a refused connection', async () => {
    const tmp = await startTestServer({ user: 'alice', password: 'pw' })
    const port = tmp.port
    await tmp.close()
    await expect(SshSession.open(base(port, { password: 'pw' }), collector().handlers)).rejects.toThrow(
      'Connection refused'
    )
  })

  it('calls onClose when the server drops the connection', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const c = collector()
    await SshSession.open(base(server.port, { password: 'pw' }), c.handlers)
    server.dropClients()
    await waitFor(() => c.state.closed !== null)
  })

  it('maps common errors to readable messages', () => {
    expect(describeError({ code: 'ENOTFOUND' })).toBe('Host not found')
    expect(describeError({ code: 'ECONNREFUSED' })).toBe('Connection refused')
    expect(describeError(new Error('Timed out while waiting for handshake'))).toBe('Connection timed out')
    expect(describeError({ level: 'client-authentication', message: 'x' })).toBe('Authentication failed')
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/hostkeys.test.ts tests/session.test.ts`
Expected: FAIL, cannot resolve `../src/main/ssh/hostkeys` and `../src/main/ssh/session`.

- [ ] **Step 5: Implement host key check**

`src/main/ssh/hostkeys.ts`:
```ts
import type { HostKeyCheck, KnownHosts } from '../../shared/types'

export function hostId(host: string, port: number): string {
  return `${host}:${port}`
}

export function checkHostKey(
  known: KnownHosts,
  host: string,
  port: number,
  algo: string,
  fingerprint: string
): HostKeyCheck {
  const entry = known[hostId(host, port)]
  if (!entry) return { state: 'unknown', algo, fingerprint }
  if (entry.fingerprint === fingerprint) return { state: 'match' }
  return { state: 'changed', algo, fingerprint, oldFingerprint: entry.fingerprint }
}
```

- [ ] **Step 6: Implement the session**

`src/main/ssh/session.ts`:
```ts
import { StringDecoder } from 'node:string_decoder'
import ssh2 from 'ssh2'
import type { Client as SshClient, ClientChannel, SFTPWrapper } from 'ssh2'
import { fingerprint } from '../keys/keys'

const { Client, utils } = ssh2

export interface ConnectOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols: number
  rows: number
  verifyHostKey(algo: string, fingerprint: string): Promise<boolean>
  readyTimeout?: number
}

export interface SessionHandlers {
  onData(data: string): void
  onClose(reason?: string): void
}

export function describeError(err: unknown): string {
  const e = (err ?? {}) as { code?: string; level?: string; message?: string }
  const msg = e.message ?? ''
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'Host not found'
  if (e.code === 'ECONNREFUSED') return 'Connection refused'
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return 'Host unreachable'
  if (e.code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'Connection timed out'
  if (/^Host denied/i.test(msg)) return 'Host key rejected'
  if (e.level === 'client-authentication') return 'Authentication failed'
  return msg || String(err)
}

function hostKeyType(key: Buffer): string {
  const parsed = utils.parseKey(key)
  if (parsed instanceof Error) return 'unknown'
  return (Array.isArray(parsed) ? parsed[0] : parsed).type
}

export class SshSession {
  private closed = false
  private sftpPromise?: Promise<SFTPWrapper>

  private constructor(
    private readonly conn: SshClient,
    private readonly channel: ClientChannel,
    private readonly handlers: SessionHandlers
  ) {
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    channel.on('data', (d: Buffer) => handlers.onData(out.write(d)))
    channel.stderr.on('data', (d: Buffer) => handlers.onData(err.write(d)))
    channel.on('close', () => this.finish())
    conn.on('error', (e) => this.finish(describeError(e)))
    conn.on('close', () => this.finish())
  }

  static open(opts: ConnectOptions, handlers: SessionHandlers): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      let settled = false
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        conn.end()
        reject(new Error(describeError(err)))
      }
      conn.on('error', fail)
      conn.on('close', () => fail(new Error('Connection closed')))
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, channel) => {
          if (err) return fail(err)
          if (settled) return channel.close()
          settled = true
          conn.removeListener('error', fail)
          resolve(new SshSession(conn, channel, handlers))
        })
      })
      conn.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
        readyTimeout: opts.readyTimeout ?? 20000,
        keepaliveInterval: 15000,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          opts.verifyHostKey(hostKeyType(key), fingerprint(key)).then(verify, () => verify(false))
        }
      })
    })
  }

  write(data: string): void {
    if (!this.closed) this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.channel.setWindow(rows, cols, 0, 0)
  }

  sftp(): Promise<SFTPWrapper> {
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    }).catch((e) => {
      this.sftpPromise = undefined
      throw e
    })
    return this.sftpPromise
  }

  close(): void {
    this.finish()
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.conn.end()
    this.handlers.onClose(reason)
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/hostkeys.test.ts tests/session.test.ts`
Expected: PASS (15 tests). If "aborts when the host key is not trusted" fails with a different message, print the raw ssh2 error and adjust the `Host denied` check in `describeError`.

- [ ] **Step 8: Commit**

```bash
git add src/main/ssh tests/helpers tests/hostkeys.test.ts tests/session.test.ts
git commit -m "Add SSH session with host key verification"
```

---

### Task 6: SFTP client

**Files:**
- Create: `src/main/ssh/sftp.ts`
- Test: `tests/sftp.test.ts`

**Interfaces:**
- Consumes: `SshSession.sftp()` from Task 5; `RemoteEntry` from types.
- Produces: `class SftpClient { constructor(sftp: SFTPWrapper); home(): Promise<string>; list(dir: string): Promise<RemoteEntry[]>; upload(localPath: string, remotePath: string): Promise<void>; download(remotePath: string, localPath: string): Promise<void>; rename(from: string, to: string): Promise<void>; remove(path: string, isDir: boolean): Promise<void>; mkdir(path: string): Promise<void> }`. `list` omits `.` and `..` and sorts folders first, then by name.

- [ ] **Step 1: Write the failing tests**

`tests/sftp.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshSession } from '../src/main/ssh/session'
import { SftpClient } from '../src/main/ssh/sftp'
import { startTestServer, type TestServer } from './helpers/sshServer'

let root: string
let local: string
let server: TestServer
let session: SshSession
let client: SftpClient

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'burrow-sftp-root-'))
  local = await mkdtemp(join(tmpdir(), 'burrow-sftp-local-'))
  await writeFile(join(root, 'a.txt'), 'alpha')
  await mkdir(join(root, 'sub'))
  server = await startTestServer({ user: 'alice', password: 'pw', sftpRoot: root })
  session = await SshSession.open(
    {
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: 'pw',
      cols: 80,
      rows: 24,
      verifyHostKey: async () => true
    },
    { onData: () => undefined, onClose: () => undefined }
  )
  client = new SftpClient(await session.sftp())
})

afterEach(async () => {
  session.close()
  await server.close()
  await rm(root, { recursive: true, force: true })
  await rm(local, { recursive: true, force: true })
})

describe('SftpClient', () => {
  it('resolves the home directory', async () => {
    expect(await client.home()).toBe('/')
  })

  it('lists folders first, then files', async () => {
    const list = await client.list('/')
    expect(list.map((e) => [e.name, e.isDir])).toEqual([
      ['sub', true],
      ['a.txt', false]
    ])
    expect(list[1].size).toBe(5)
  })

  it('uploads and downloads files', async () => {
    const src = join(local, 'up.txt')
    await writeFile(src, 'uploaded')
    await client.upload(src, '/sub/up.txt')
    expect(await readFile(join(root, 'sub', 'up.txt'), 'utf8')).toBe('uploaded')

    const dst = join(local, 'down.txt')
    await client.download('/a.txt', dst)
    expect(await readFile(dst, 'utf8')).toBe('alpha')
  })

  it('renames, creates and removes', async () => {
    await client.rename('/a.txt', '/b.txt')
    await client.mkdir('/new')
    expect((await stat(join(root, 'new'))).isDirectory()).toBe(true)
    await client.remove('/b.txt', false)
    await client.remove('/new', true)
    expect((await client.list('/')).map((e) => e.name)).toEqual(['sub'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sftp.test.ts`
Expected: FAIL, cannot resolve `../src/main/ssh/sftp`.

- [ ] **Step 3: Implement the SFTP client**

`src/main/ssh/sftp.ts`:
```ts
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import type { RemoteEntry } from '../../shared/types'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

type Done = (err?: Error | null) => void

function run(fn: (done: Done) => void): Promise<void> {
  return new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())))
}

export class SftpClient {
  constructor(private readonly sftp: SFTPWrapper) {}

  home(): Promise<string> {
    return new Promise((resolve, reject) => this.sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))))
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = await new Promise<FileEntryWithStats[]>((resolve, reject) =>
      this.sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    )
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        isDir: (i.attrs.mode & S_IFMT) === S_IFDIR,
        size: i.attrs.size,
        mtime: i.attrs.mtime
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return run((done) => this.sftp.fastPut(localPath, remotePath, done))
  }

  download(remotePath: string, localPath: string): Promise<void> {
    return run((done) => this.sftp.fastGet(remotePath, localPath, done))
  }

  rename(from: string, to: string): Promise<void> {
    return run((done) => this.sftp.rename(from, to, done))
  }

  remove(path: string, isDir: boolean): Promise<void> {
    return run((done) => (isDir ? this.sftp.rmdir(path, done) : this.sftp.unlink(path, done)))
  }

  mkdir(path: string): Promise<void> {
    return run((done) => this.sftp.mkdir(path, done))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sftp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ssh/sftp.ts tests/sftp.test.ts
git commit -m "Add SFTP client"
```

---

### Task 7: Core and validation

**Files:**
- Create: `src/main/validate.ts`, `src/main/core.ts`
- Test: `tests/core.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 to 6.
- Produces:
  - `validateProfile(v: unknown): Profile`, `validateSnippet(v: unknown): Snippet`, `validateSettings(v: unknown): Settings`
  - `DEFAULT_SETTINGS: Settings`
  - `type Emit = (channel: 'session:data' | 'session:closed', ...args: unknown[]) => void`
  - `type Ask = (prompt: Prompt) => Promise<PromptAnswer>`
  - `class Core` with:
    - `constructor(dir: string, emit: Emit, kdf?: KdfParams)`
    - `readonly vault: Vault; profiles: Repo<Profile>; snippets: Repo<Snippet>; keys: Repo<KeyMeta>; knownHosts: JsonDoc<KnownHosts>; settings: JsonDoc<Settings>`
    - `init(): Promise<void>`, `getLoadErrors(): LoadError[]`, `resetFile(file: string): Promise<void>`
    - `lock(): void`
    - `saveProfile(p: unknown, password?: string): Promise<void>`, `deleteProfile(id: string)`, `hasPassword(id: string): boolean`, `forgetPassword(id: string)`
    - `saveSnippet(s: unknown)`, `deleteSnippet(id: string)`, `saveSettings(s: unknown)`
    - `generateKey(name: string, type: KeyType): Promise<KeyMeta>`, `importKey(name: string, privateKey: string, passphrase?: string): Promise<KeyMeta>`, `deleteKey(id: string)`
    - `removeKnownHost(id: string)`
    - `connect(sessionId: string, profileId: string, cols: number, rows: number, ask: Ask): Promise<void>`
    - `write(id: string, data: string): void`, `resize(id: string, cols: number, rows: number): void`, `closeSession(id: string): void`, `closeAll(): void`
    - `sftp(id: string): Promise<SftpClient>`
  - Emits `('session:data', sessionId, data)` and `('session:closed', sessionId, reason)`.

- [ ] **Step 1: Write the failing tests**

`tests/core.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core, type Ask } from '../src/main/core'
import type { Profile, Prompt } from '../src/shared/types'
import { startTestServer, type TestServer } from './helpers/sshServer'
import { waitFor } from './helpers/waitFor'

const FAST = { N: 1024, r: 8, p: 1 }
let dir: string
let events: unknown[][]
let core: Core
let server: TestServer | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'burrow-core-'))
  events = []
  core = new Core(dir, (...args) => events.push(args), FAST)
  await core.init()
  await core.vault.create('master')
})

afterEach(async () => {
  core.closeAll()
  await server?.close()
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

const profile = (port: number, extra: Partial<Profile> = {}): Profile => ({
  id: 'p1',
  name: 'Test box',
  group: '',
  host: '127.0.0.1',
  port,
  user: 'alice',
  authType: 'password',
  ...extra
})

function asker(answers: Partial<Record<Prompt['kind'], { ok: boolean; value?: string; save?: boolean }>>) {
  const seen: Prompt[] = []
  const ask: Ask = async (p) => {
    seen.push(p)
    return answers[p.kind] ?? { ok: false }
  }
  return { ask, seen }
}

describe('Core storage', () => {
  it('stores passwords in the vault, not in profiles.json', async () => {
    await core.saveProfile(profile(22), 'hunter2-secret')
    expect(await readFile(join(dir, 'profiles.json'), 'utf8')).not.toContain('hunter2-secret')
    expect(core.hasPassword('p1')).toBe(true)
    await core.forgetPassword('p1')
    expect(core.hasPassword('p1')).toBe(false)
  })

  it('validates profiles', async () => {
    await expect(core.saveProfile(profile(0))).rejects.toThrow(/Port/)
    await expect(core.saveProfile({ ...profile(22), host: ' ' })).rejects.toThrow(/Host/)
    await expect(core.saveProfile(profile(22, { authType: 'key', keyId: 'missing' }))).rejects.toThrow(/Key not found/)
  })

  it('refuses to delete a key that a host uses', async () => {
    const key = await core.generateKey('laptop', 'ed25519')
    await core.saveProfile(profile(22, { authType: 'key', keyId: key.id }))
    await expect(core.deleteKey(key.id)).rejects.toThrow('Key is used by: Test box')
    await core.deleteProfile('p1')
    await core.deleteKey(key.id)
    expect(core.keys.list()).toEqual([])
  })

  it('reports a corrupt file, blocks writes, and resets with a backup', async () => {
    await writeFile(join(dir, 'snippets.json'), '{broken')
    const c2 = new Core(dir, () => undefined, FAST)
    await c2.init()
    expect(c2.getLoadErrors().map((e) => e.file)).toEqual(['snippets.json'])
    await expect(c2.saveSnippet({ id: 's', name: 'n', command: 'ls' })).rejects.toThrow(/Reset it first/)
    await c2.resetFile('snippets.json')
    expect(c2.getLoadErrors()).toEqual([])
    expect((await readdir(dir)).some((f) => f.startsWith('snippets.json.broken-'))).toBe(true)
    await c2.vault.unlock('master')
    await c2.saveSnippet({ id: 's', name: 'n', command: 'ls' })
  })
})

describe('Core sessions', () => {
  it('asks to trust an unknown host once, then connects silently', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    const a = asker({ hostkey: { ok: true } })
    await core.connect('s1', 'p1', 80, 24, a.ask)
    expect(a.seen).toHaveLength(1)
    expect(a.seen[0]).toMatchObject({ kind: 'hostkey', check: { state: 'unknown' } })
    await waitFor(() => events.some((e) => e[0] === 'session:data' && e[1] === 's1' && String(e[2]).includes('welcome')))
    expect(Object.keys(core.knownHosts.value)).toEqual([`127.0.0.1:${server.port}`])

    const b = asker({})
    await core.connect('s2', 'p1', 80, 24, b.ask)
    expect(b.seen).toHaveLength(0)
  })

  it('warns about a changed host key and aborts when declined', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    await core.knownHosts.set({
      [`127.0.0.1:${server.port}`]: { algo: 'ssh-ed25519', fingerprint: 'SHA256:old', addedAt: 'x' }
    })
    const a = asker({ hostkey: { ok: false } })
    await expect(core.connect('s1', 'p1', 80, 24, a.ask)).rejects.toThrow('Host key rejected')
    expect(a.seen[0]).toMatchObject({ kind: 'hostkey', check: { state: 'changed', oldFingerprint: 'SHA256:old' } })
  })

  it('prompts for a missing password and saves it when asked', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port))
    const a = asker({ hostkey: { ok: true }, password: { ok: true, value: 'pw', save: true } })
    await core.connect('s1', 'p1', 80, 24, a.ask)
    expect(a.seen.map((p) => p.kind)).toEqual(['password', 'hostkey'])
    expect(core.hasPassword('p1')).toBe(true)
  })

  it('does not save a prompted password without the checkbox', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port))
    await core.connect('s1', 'p1', 80, 24, asker({ hostkey: { ok: true }, password: { ok: true, value: 'pw' } }).ask)
    expect(core.hasPassword('p1')).toBe(false)
  })

  it('connects with a stored key', async () => {
    const key = await core.generateKey('laptop', 'ed25519')
    server = await startTestServer({ user: 'alice', publicKey: key.publicKey })
    await core.saveProfile(profile(server.port, { authType: 'key', keyId: key.id }))
    await core.connect('s1', 'p1', 80, 24, asker({ hostkey: { ok: true } }).ask)
  })

  it('closes sessions when locking', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    await core.connect('s1', 'p1', 80, 24, asker({ hostkey: { ok: true } }).ask)
    core.lock()
    await waitFor(() => events.some((e) => e[0] === 'session:closed' && e[1] === 's1'))
    expect(core.vault.isUnlocked).toBe(false)
  })

  it('rejects a duplicate session id', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    const a = asker({ hostkey: { ok: true } })
    await core.connect('s1', 'p1', 80, 24, a.ask)
    await expect(core.connect('s1', 'p1', 80, 24, a.ask)).rejects.toThrow(/already in use/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core.test.ts`
Expected: FAIL, cannot resolve `../src/main/core`.

- [ ] **Step 3: Implement validation**

`src/main/validate.ts`:
```ts
import type { Profile, Settings, Snippet } from '../shared/types'

const isStr = (v: unknown): v is string => typeof v === 'string'
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  fontSize: 13,
  theme: 'dark'
}

export function validateProfile(v: unknown): Profile {
  const p = (v ?? {}) as Partial<Profile>
  if (!nonEmpty(p.id)) throw new Error('Invalid host id')
  if (!nonEmpty(p.name)) throw new Error('Label is required')
  if (!nonEmpty(p.host)) throw new Error('Host is required')
  if (!nonEmpty(p.user)) throw new Error('Username is required')
  if (!Number.isInteger(p.port) || p.port! < 1 || p.port! > 65535) throw new Error('Port must be between 1 and 65535')
  if (p.authType !== 'password' && p.authType !== 'key') throw new Error('Invalid authentication type')
  if (p.authType === 'key' && !nonEmpty(p.keyId)) throw new Error('Choose a key')
  return {
    id: p.id,
    name: p.name.trim(),
    group: isStr(p.group) ? p.group.trim() : '',
    host: p.host.trim(),
    port: p.port!,
    user: p.user.trim(),
    authType: p.authType,
    ...(p.authType === 'key' ? { keyId: p.keyId } : {})
  }
}

export function validateSnippet(v: unknown): Snippet {
  const s = (v ?? {}) as Partial<Snippet>
  if (!nonEmpty(s.id)) throw new Error('Invalid snippet id')
  if (!nonEmpty(s.name)) throw new Error('Name is required')
  if (!nonEmpty(s.command)) throw new Error('Command is required')
  const tags = Array.isArray(s.tags) ? s.tags.filter(nonEmpty).map((t) => t.trim()) : []
  return { id: s.id, name: s.name.trim(), command: s.command, ...(tags.length ? { tags } : {}) }
}

export function validateSettings(v: unknown): Settings {
  const s = (v ?? {}) as Partial<Settings>
  if (!nonEmpty(s.fontFamily)) throw new Error('Font family is required')
  if (!Number.isInteger(s.fontSize) || s.fontSize! < 8 || s.fontSize! > 32) throw new Error('Font size must be 8 to 32')
  if (s.theme !== 'dark' && s.theme !== 'light') throw new Error('Invalid theme')
  return { fontFamily: s.fontFamily.trim(), fontSize: s.fontSize!, theme: s.theme }
}
```

- [ ] **Step 4: Implement Core**

`src/main/core.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import type {
  KeyMeta,
  KeyType,
  KnownHosts,
  LoadError,
  Profile,
  Prompt,
  PromptAnswer,
  Settings,
  Snippet
} from '../shared/types'
import { generateKey, importKey, isEncrypted, type KeyMaterial } from './keys/keys'
import { checkHostKey, hostId } from './ssh/hostkeys'
import { SshSession } from './ssh/session'
import { SftpClient } from './ssh/sftp'
import { CorruptFileError } from './store/jsonFile'
import { JsonDoc } from './store/jsonDoc'
import { Repo } from './store/repo'
import { DEFAULT_SETTINGS, validateProfile, validateSettings, validateSnippet } from './validate'
import { DEFAULT_KDF, type KdfParams } from './vault/crypto'
import { Vault } from './vault/vault'

export type Emit = (channel: 'session:data' | 'session:closed', ...args: unknown[]) => void
export type Ask = (prompt: Prompt) => Promise<PromptAnswer>

export class Core {
  readonly vault: Vault
  readonly profiles: Repo<Profile>
  readonly snippets: Repo<Snippet>
  readonly keys: Repo<KeyMeta>
  readonly knownHosts: JsonDoc<KnownHosts>
  readonly settings: JsonDoc<Settings>
  private readonly sessions = new Map<string, SshSession>()
  private readonly sftps = new Map<string, SftpClient>()
  private loadErrors: LoadError[] = []

  constructor(
    dir: string,
    private readonly emit: Emit,
    kdf: KdfParams = DEFAULT_KDF
  ) {
    this.vault = new Vault(join(dir, 'vault.enc'), kdf)
    this.profiles = new Repo(join(dir, 'profiles.json'))
    this.snippets = new Repo(join(dir, 'snippets.json'))
    this.keys = new Repo(join(dir, 'keys.json'))
    this.knownHosts = new JsonDoc<KnownHosts>(join(dir, 'known_hosts.json'), {})
    this.settings = new JsonDoc<Settings>(join(dir, 'settings.json'), DEFAULT_SETTINGS)
  }

  private get docs(): JsonDoc<unknown>[] {
    return [this.profiles.doc, this.snippets.doc, this.keys.doc, this.knownHosts, this.settings] as JsonDoc<unknown>[]
  }

  async init(): Promise<void> {
    this.loadErrors = []
    for (const doc of this.docs) {
      try {
        await doc.load()
      } catch (e) {
        if (!(e instanceof CorruptFileError)) throw e
        this.loadErrors.push({ file: basename(doc.file), message: e.message })
      }
    }
  }

  getLoadErrors(): LoadError[] {
    return this.loadErrors
  }

  async resetFile(file: string): Promise<void> {
    const doc = this.docs.find((d) => basename(d.file) === file)
    if (!doc) throw new Error(`Unknown file: ${file}`)
    await doc.reset()
    this.loadErrors = this.loadErrors.filter((e) => e.file !== file)
  }

  lock(): void {
    this.closeAll()
    this.vault.lock()
  }

  // Profiles

  async saveProfile(input: unknown, password?: string): Promise<void> {
    const p = validateProfile(input)
    if (p.authType === 'key' && !this.keys.get(p.keyId!)) throw new Error('Key not found')
    await this.profiles.upsert(p)
    if (p.authType === 'key') await this.vault.setPassword(p.id, undefined)
    else if (password) await this.vault.setPassword(p.id, password)
  }

  async deleteProfile(id: string): Promise<void> {
    await this.profiles.remove(id)
    await this.vault.setPassword(id, undefined)
  }

  hasPassword(id: string): boolean {
    return this.vault.getPassword(id) !== undefined
  }

  async forgetPassword(id: string): Promise<void> {
    await this.vault.setPassword(id, undefined)
  }

  // Snippets and settings

  async saveSnippet(input: unknown): Promise<void> {
    await this.snippets.upsert(validateSnippet(input))
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.snippets.remove(id)
  }

  async saveSettings(input: unknown): Promise<void> {
    await this.settings.set(validateSettings(input))
  }

  // Keys

  async generateKey(name: string, type: KeyType): Promise<KeyMeta> {
    if (!name.trim()) throw new Error('Name is required')
    return this.addKey(name.trim(), await generateKey(type, name.trim()))
  }

  async importKey(name: string, privateKey: string, passphrase?: string): Promise<KeyMeta> {
    if (!name.trim()) throw new Error('Name is required')
    return this.addKey(name.trim(), importKey(privateKey.trim() + '\n', passphrase, name.trim()), passphrase)
  }

  private async addKey(name: string, m: KeyMaterial, passphrase?: string): Promise<KeyMeta> {
    const meta: KeyMeta = {
      id: randomUUID(),
      name,
      type: m.type,
      publicKey: m.publicKey,
      fingerprint: m.fingerprint,
      createdAt: new Date().toISOString()
    }
    await this.vault.setKey(meta.id, { privateKey: m.privateKey, ...(passphrase ? { passphrase } : {}) })
    await this.keys.upsert(meta)
    return meta
  }

  async deleteKey(id: string): Promise<void> {
    const users = this.profiles.list().filter((p) => p.authType === 'key' && p.keyId === id)
    if (users.length) throw new Error(`Key is used by: ${users.map((u) => u.name).join(', ')}`)
    await this.keys.remove(id)
    await this.vault.setKey(id, undefined)
  }

  // Known hosts

  async removeKnownHost(id: string): Promise<void> {
    const next = { ...this.knownHosts.value }
    delete next[id]
    await this.knownHosts.set(next)
  }

  // Sessions

  async connect(sessionId: string, profileId: string, cols: number, rows: number, ask: Ask): Promise<void> {
    if (this.sessions.has(sessionId)) throw new Error('Session id already in use')
    const p = this.profiles.get(profileId)
    if (!p) throw new Error('Host not found in profiles')

    const auth: { password?: string; privateKey?: string; passphrase?: string } = {}
    let persist: (() => Promise<void>) | undefined

    if (p.authType === 'password') {
      auth.password = this.vault.getPassword(p.id)
      if (auth.password === undefined) {
        const ans = await ask({ kind: 'password', label: `${p.user}@${p.host}` })
        if (!ans.ok || ans.value === undefined) throw new Error('Cancelled')
        const value = ans.value
        auth.password = value
        if (ans.save) persist = () => this.vault.setPassword(p.id, value)
      }
    } else {
      const keyId = p.keyId!
      const secret = this.vault.getKey(keyId)
      if (!secret) throw new Error('The key for this host is missing')
      auth.privateKey = secret.privateKey
      auth.passphrase = secret.passphrase
      if (!auth.passphrase && isEncrypted(secret.privateKey)) {
        const ans = await ask({ kind: 'passphrase', label: this.keys.get(keyId)?.name ?? 'key' })
        if (!ans.ok || !ans.value) throw new Error('Cancelled')
        const value = ans.value
        importKey(secret.privateKey, value) // throws KeyParseError on a wrong passphrase
        auth.passphrase = value
        if (ans.save) persist = () => this.vault.setKey(keyId, { ...secret, passphrase: value })
      }
    }

    const session = await SshSession.open(
      {
        host: p.host,
        port: p.port,
        username: p.user,
        ...auth,
        cols,
        rows,
        verifyHostKey: async (algo, fingerprint) => {
          const check = checkHostKey(this.knownHosts.value, p.host, p.port, algo, fingerprint)
          if (check.state === 'match') return true
          const ans = await ask({ kind: 'hostkey', host: p.host, port: p.port, check })
          if (!ans.ok) return false
          await this.knownHosts.set({
            ...this.knownHosts.value,
            [hostId(p.host, p.port)]: { algo, fingerprint, addedAt: new Date().toISOString() }
          })
          return true
        }
      },
      {
        onData: (data) => this.emit('session:data', sessionId, data),
        onClose: (reason) => {
          this.sessions.delete(sessionId)
          this.sftps.delete(sessionId)
          this.emit('session:closed', sessionId, reason ?? 'Connection closed')
        }
      }
    )
    this.sessions.set(sessionId, session)
    await persist?.()
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows)
  }

  closeSession(id: string): void {
    this.sessions.get(id)?.close()
  }

  closeAll(): void {
    for (const s of [...this.sessions.values()]) s.close()
  }

  async sftp(id: string): Promise<SftpClient> {
    const existing = this.sftps.get(id)
    if (existing) return existing
    const session = this.sessions.get(id)
    if (!session) throw new Error('Session is not connected')
    const client = new SftpClient(await session.sftp())
    this.sftps.set(id, client)
    return client
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/core.ts src/main/validate.ts tests/core.test.ts
git commit -m "Add Core tying storage, vault and sessions together"
```

---

### Task 8: Electron wiring (IPC, preload, menu)

**Files:**
- Create: `src/shared/api.ts`, `src/main/ipc.ts`, `src/main/menu.ts`
- Modify: `src/main/index.ts` (replace whole file), `src/preload/index.ts` (replace whole file)

**Interfaces:**
- Consumes: `Core` from Task 7.
- Produces: `BurrowApi` exposed as `window.burrow` (exact shape below). Errors thrown in main arrive in the renderer as `Error` with only the original message (the Electron prefix is stripped).

- [ ] **Step 1: Define the API**

`src/shared/api.ts`:
```ts
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
  }
  snippets: {
    list(): Promise<Snippet[]>
    save(snippet: Snippet): Promise<void>
    remove(id: string): Promise<void>
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
```

- [ ] **Step 2: Implement IPC handlers**

`src/main/ipc.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { KeyType, PromptAnswer } from '../shared/types'
import type { Ask, Core } from './core'

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

export function registerIpc(core: Core, getWindow: () => BrowserWindow | null): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (_event, ...args) => fn(...args))

  const pending = new Map<string, (answer: PromptAnswer) => void>()
  const ask: Ask = (prompt) =>
    new Promise((resolve) => {
      const win = getWindow()
      if (!win) return resolve({ ok: false })
      const id = randomUUID()
      pending.set(id, resolve)
      win.webContents.send('prompt:request', id, prompt)
    })
  ipcMain.on('prompt:answer', (_event, id: unknown, answer: unknown) => {
    const resolve = typeof id === 'string' ? pending.get(id) : undefined
    if (!resolve) return
    pending.delete(id as string)
    const a = (answer ?? {}) as PromptAnswer
    resolve({ ok: a.ok === true, value: typeof a.value === 'string' ? a.value : undefined, save: a.save === true })
  })

  handle('vault:status', () => core.vault.status())
  handle('vault:create', (pw) => core.vault.create(str(pw, 'password')))
  handle('vault:unlock', (pw) => core.vault.unlock(str(pw, 'password')))
  handle('vault:lock', () => core.lock())
  handle('vault:reset', async () => {
    await core.vault.reset()
  })

  handle('files:errors', () => core.getLoadErrors())
  handle('files:reset', (file) => core.resetFile(str(file, 'file')))

  handle('profiles:list', () => core.profiles.list())
  handle('profiles:save', (p, pw) => core.saveProfile(p, optStr(pw, 'password')))
  handle('profiles:remove', (id) => core.deleteProfile(str(id, 'id')))
  handle('profiles:hasPassword', (id) => core.hasPassword(str(id, 'id')))
  handle('profiles:forgetPassword', (id) => core.forgetPassword(str(id, 'id')))

  handle('snippets:list', () => core.snippets.list())
  handle('snippets:save', (s) => core.saveSnippet(s))
  handle('snippets:remove', (id) => core.deleteSnippet(str(id, 'id')))

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

  handle('knownHosts:list', () => core.knownHosts.value)
  handle('knownHosts:remove', (id) => core.removeKnownHost(str(id, 'id')))

  handle('settings:get', () => core.settings.value)
  handle('settings:save', (s) => core.saveSettings(s))

  handle('session:connect', (id, profileId, cols, rows) =>
    core.connect(str(id, 'id'), str(profileId, 'profileId'), int(cols, 'cols'), int(rows, 'rows'), ask)
  )
  ipcMain.on('session:write', (_event, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') core.write(id, data)
  })
  ipcMain.on('session:resize', (_event, id: unknown, cols: unknown, rows: unknown) => {
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

  handle('app:openExternal', async (url) => {
    const u = str(url, 'url')
    if (/^https?:\/\//i.test(u)) await shell.openExternal(u)
  })
}
```

- [ ] **Step 3: Implement the menu**

`src/main/menu.ts`:
```ts
import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * macOS gets a small menu so Cmd+C/V/Q work. There is no "Close Window" item, so Cmd+W reaches the app.
 * Linux gets no menu: its default accelerators (Ctrl+C, Ctrl+R, Ctrl+W) would steal keys from the shell.
 */
export function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
```

- [ ] **Step 4: Replace main entry**

`src/main/index.ts`:
```ts
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { Core } from './core'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'

let win: BrowserWindow | null = null
const core = new Core(app.getPath('userData'), (channel, ...args) => win?.webContents.send(channel, ...args))

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
      sandbox: true
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.on('closed', () => {
    win = null
    core.lock()
  })
  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  await core.init()
  registerIpc(core, () => win)
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 5: Replace preload**

`src/preload/index.ts`:
```ts
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
    reset: () => invoke('vault:reset')
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
    forgetPassword: (id) => invoke('profiles:forgetPassword', id)
  },
  snippets: {
    list: () => invoke('snippets:list'),
    save: (s) => invoke('snippets:save', s),
    remove: (id) => invoke('snippets:remove', id)
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
  session: {
    connect: (id, profileId, cols, rows) => invoke('session:connect', id, profileId, cols, rows),
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
  openExternal: (url) => invoke('app:openExternal', url)
}

contextBridge.exposeInMainWorld('burrow', api)
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, all tests pass, build succeeds.

Then run `npm run dev` in the background, open DevTools in the window (View > Toggle Developer Tools on macOS) and evaluate `await burrow.vault.status()`.
Expected: `"missing"` on a fresh machine. Stop the dev process afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/shared/api.ts src/main src/preload
git commit -m "Wire Core to the renderer through IPC and preload"
```

---
### Task 9: Renderer foundation (unlock, data, dialogs, simple views)

**Files:**
- Create: `src/renderer/src/env.d.ts`, `api.ts`, `util.ts`, `icons.tsx`, `toast.tsx`, `data.tsx`, `styles.css`
- Create: `src/renderer/src/components/Modal.tsx`, `Field.tsx`, `SidePanel.tsx`, `Empty.tsx`, `TextPrompt.tsx`
- Create: `src/renderer/src/UnlockScreen.tsx`, `PromptDialog.tsx`, `HomeView.tsx`, `App.tsx`
- Create: `src/renderer/src/views/SnippetsView.tsx`, `KnownHostsView.tsx`, `SettingsView.tsx`
- Modify: `src/renderer/src/main.tsx` (replace whole file)

**Interfaces:**
- Consumes: `window.burrow` (`BurrowApi`) from Task 8.
- Produces:
  - `api: BurrowApi` from `./api`
  - `errMsg(e: unknown): string`, `formatSize(bytes: number): string` from `./util`
  - `useData(): { profiles; snippets; keys; knownHosts; settings; loadErrors; reload(): Promise<void> }` and `DataProvider` from `./data`
  - `ToastProvider`, `useToast(): (text: string, kind?: 'info' | 'error') => void`, `useAction(): (fn: () => Promise<unknown>, success?: string) => Promise<boolean>` from `./toast`
  - Components `Modal({ warning?, children })`, `Field({ label, hint?, width?, children })`, `SidePanel({ title, onClose, children })`, `Empty({ title, text })`, `TextPrompt({ title, initial?, confirmLabel?, onSubmit(value), onCancel })`
  - Icons: `ServerIcon, KeyIcon, CodeIcon, ShieldIcon, SettingsIcon, LockIcon, PlusIcon, EditIcon, PlayIcon, FolderIcon, FileIcon, SplitRightIcon, SplitDownIcon, RefreshIcon, UpIcon, BurrowMark`

- [ ] **Step 1: Create API access, utilities and icons**

`src/renderer/src/env.d.ts`:
```ts
import type { BurrowApi } from '../../shared/api'

declare global {
  interface Window {
    burrow: BurrowApi
  }
}

export {}
```

`src/renderer/src/api.ts`:
```ts
export const api = window.burrow
```

`src/renderer/src/util.ts`:
```ts
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}
```

`src/renderer/src/icons.tsx`:
```tsx
import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const ServerIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Svg>
)
export const KeyIcon = () => (
  <Svg>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M17 6l3 3M15 8l2 2" />
  </Svg>
)
export const CodeIcon = () => (
  <Svg>
    <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
  </Svg>
)
export const ShieldIcon = () => (
  <Svg>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  </Svg>
)
export const SettingsIcon = () => (
  <Svg>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </Svg>
)
export const LockIcon = () => (
  <Svg>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
)
export const PlusIcon = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const EditIcon = () => (
  <Svg>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
  </Svg>
)
export const PlayIcon = () => (
  <Svg>
    <path d="M7 5l12 7-12 7z" />
  </Svg>
)
export const FolderIcon = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)
export const FileIcon = () => (
  <Svg>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </Svg>
)
export const SplitRightIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </Svg>
)
export const SplitDownIcon = () => (
  <Svg>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </Svg>
)
export const RefreshIcon = () => (
  <Svg>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </Svg>
)
export const UpIcon = () => (
  <Svg>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
)

/** The app mark: a hill with a burrow entrance. */
export const BurrowMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 20a10 10 0 0 1 20 0z" fill="var(--accent)" />
    <path d="M8 20a4 4 0 0 1 8 0z" fill="var(--bg)" />
  </svg>
)
```

- [ ] **Step 2: Create toasts and the data provider**

`src/renderer/src/toast.tsx`:
```tsx
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { errMsg } from './util'

type Kind = 'info' | 'error'
type Push = (text: string, kind?: Kind) => void

const ToastContext = createContext<Push>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: Kind }[]>([])
  const push = useCallback<Push>((text, kind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/** Runs an async action, shows errors as toasts and resolves to whether it succeeded. */
export function useAction() {
  const toast = useToast()
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      try {
        await fn()
        if (success) toast(success)
        return true
      } catch (e) {
        toast(errMsg(e), 'error')
        return false
      }
    },
    [toast]
  )
}
```

`src/renderer/src/data.tsx`:
```tsx
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
```

- [ ] **Step 3: Create shared components**

`src/renderer/src/components/Modal.tsx`:
```tsx
import type { ReactNode } from 'react'

export function Modal({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className="modal-backdrop">
      <div className={`modal ${warning ? 'warning' : ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  )
}
```

`src/renderer/src/components/Field.tsx`:
```tsx
import type { ReactNode } from 'react'

export function Field({ label, hint, width, children }: { label: string; hint?: ReactNode; width?: number; children: ReactNode }) {
  return (
    <div className="field" style={width ? { width, flex: 'none' } : undefined}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
```

`src/renderer/src/components/SidePanel.tsx`:
```tsx
import { useEffect, type ReactNode } from 'react'

export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="panel-backdrop" onClick={onClose} />
      <aside className="side-panel">
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="side-panel-body">{children}</div>
      </aside>
    </>
  )
}
```

`src/renderer/src/components/Empty.tsx`:
```tsx
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="muted">{text}</p>
    </div>
  )
}
```

`src/renderer/src/components/TextPrompt.tsx`:
```tsx
import { useState } from 'react'
import { Modal } from './Modal'

export function TextPrompt({
  title,
  initial = '',
  confirmLabel = 'Save',
  onSubmit,
  onCancel
}: {
  title: string
  initial?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Modal>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <h3>{title}</h3>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
```

- [ ] **Step 4: Create the unlock screen and the prompt dialog**

`src/renderer/src/UnlockScreen.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import type { VaultStatus } from '../../shared/types'
import { api } from './api'
import { BurrowMark } from './icons'
import { errMsg } from './util'

export function UnlockScreen({ status, onDone }: { status: Exclude<VaultStatus, 'unlocked'>; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setPassword('')
      setRepeat('')
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <div className="auth-logo">
      <BurrowMark />
      <h1>Burrow Client</h1>
    </div>
  )

  if (status === 'broken') {
    return (
      <div className="center-screen">
        <div className="auth-card">
          {header}
          <h2>The vault can't be read</h2>
          <p className="muted">
            vault.enc is damaged or not a Burrow vault. Resetting copies it to a backup file next to it and starts a new,
            empty vault. Saved passwords and keys will not be available.
          </p>
          {error && <p className="error">{error}</p>}
          <button className="danger" disabled={busy} onClick={() => run(() => api.vault.reset())}>
            Back up and reset vault
          </button>
        </div>
      </div>
    )
  }

  const creating = status === 'missing'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (creating) {
      if (!password) return setError('Choose a master password')
      if (password !== repeat) return setError('The passwords do not match')
      void run(() => api.vault.create(password))
    } else {
      void run(() => api.vault.unlock(password))
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit}>
        {header}
        <p className="muted">
          {creating
            ? 'Set a master password. It encrypts your saved passwords and keys on this computer.'
            : 'Enter your master password to unlock the vault.'}
        </p>
        <input type="password" placeholder="Master password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {creating && (
          <input type="password" placeholder="Repeat password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        )}
        {creating && <p className="muted small">There is no way to recover a forgotten master password.</p>}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Working…' : creating ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
```

`src/renderer/src/PromptDialog.tsx`:
```tsx
import { useEffect, useState, type FormEvent } from 'react'
import type { Prompt } from '../../shared/types'
import { api } from './api'
import { Modal } from './components/Modal'

/** Shows host key, password and passphrase prompts that the main process requests while connecting. */
export function PromptDialog() {
  const [queue, setQueue] = useState<{ id: string; prompt: Prompt }[]>([])
  const [value, setValue] = useState('')
  const [save, setSave] = useState(false)

  useEffect(
    () =>
      api.prompts.onRequest((id, prompt) => {
        // Core never asks about matching keys, but answer defensively instead of showing an empty dialog.
        if (prompt.kind === 'hostkey' && prompt.check.state === 'match') return api.prompts.answer(id, { ok: true })
        setQueue((q) => [...q, { id, prompt }])
      }),
    []
  )

  const current = queue[0]
  if (!current) return null

  const answer = (ok: boolean) => {
    api.prompts.answer(current.id, { ok, value: ok ? value : undefined, save: ok && save })
    setValue('')
    setSave(false)
    setQueue((q) => q.slice(1))
  }

  const p = current.prompt
  if (p.kind === 'hostkey') {
    const target = `${p.host}:${p.port}`
    if (p.check.state === 'changed') {
      return (
        <Modal warning>
          <h3>Host key changed for {target}</h3>
          <p>
            The server presents a different key than the one you trusted before. This can mean the server was reinstalled,
            or that someone is intercepting the connection. Only continue if you know why the key changed.
          </p>
          <div className="field">
            <span className="field-label">Trusted key</span>
            <div className="fp mono">{p.check.oldFingerprint}</div>
          </div>
          <div className="field">
            <span className="field-label">New key ({p.check.algo})</span>
            <div className="fp mono">{p.check.fingerprint}</div>
          </div>
          <div className="actions">
            <button className="danger ghost" onClick={() => answer(true)}>
              Replace & connect
            </button>
            <button className="primary" autoFocus onClick={() => answer(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )
    }
    if (p.check.state === 'unknown') {
      return (
        <Modal>
          <h3>Trust {target}?</h3>
          <p className="muted">This is the first connection to this host. Check that the fingerprint matches the server.</p>
          <div className="field">
            <span className="field-label">{p.check.algo}</span>
            <div className="fp mono">{p.check.fingerprint}</div>
          </div>
          <div className="actions">
            <button onClick={() => answer(false)}>Cancel</button>
            <button className="primary" autoFocus onClick={() => answer(true)}>
              Trust & connect
            </button>
          </div>
        </Modal>
      )
    }
    return null
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    answer(true)
  }
  return (
    <Modal>
      <form className="form" onSubmit={submit}>
        <h3>{p.kind === 'password' ? 'Password' : 'Key passphrase'}</h3>
        <p className="muted">{p.label}</p>
        <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          Save to vault
        </label>
        <div className="actions">
          <button type="button" onClick={() => answer(false)}>
            Cancel
          </button>
          <button className="primary" type="submit">
            Connect
          </button>
        </div>
      </form>
    </Modal>
  )
}
```

- [ ] **Step 5: Create the snippets, known hosts and settings views**

`src/renderer/src/views/SnippetsView.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import type { Snippet } from '../../../shared/types'
import { api } from '../api'
import { Empty } from '../components/Empty'
import { Field } from '../components/Field'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { CodeIcon, PlusIcon } from '../icons'
import { useAction } from '../toast'

export function SnippetsView() {
  const { snippets, reload } = useData()
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const list = snippets.filter((s) => `${s.name} ${s.command} ${(s.tags ?? []).join(' ')}`.toLowerCase().includes(q))
  const exists = editing ? snippets.some((s) => s.id === editing.id) : false

  return (
    <div className="view">
      <header className="view-header">
        <h1>Snippets</h1>
        <input className="search" placeholder="Search snippets" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing({ id: crypto.randomUUID(), name: '', command: '' })}>
          <PlusIcon /> New snippet
        </button>
      </header>
      {snippets.length === 0 ? (
        <Empty title="No snippets yet" text="Save commands you run often and send them to any terminal with one click." />
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.id} className="list-row clickable" onClick={() => setEditing(s)}>
              <div className="list-icon">
                <CodeIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{s.name}</div>
                <div className="list-sub mono">{s.command}</div>
              </div>
              {s.tags?.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <SidePanel title={exists ? 'Edit snippet' : 'New snippet'} onClose={() => setEditing(null)}>
          <SnippetForm
            snippet={editing}
            exists={exists}
            onDone={() => {
              setEditing(null)
              void reload()
            }}
          />
        </SidePanel>
      )}
    </div>
  )
}

function SnippetForm({ snippet, exists, onDone }: { snippet: Snippet; exists: boolean; onDone: () => void }) {
  const run = useAction()
  const [name, setName] = useState(snippet.name)
  const [command, setCommand] = useState(snippet.command)
  const [tags, setTags] = useState((snippet.tags ?? []).join(', '))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    if (await run(() => api.snippets.save({ id: snippet.id, name, command, tags: tagList }))) onDone()
  }
  const remove = async () => {
    if (confirm(`Delete snippet "${snippet.name}"?`) && (await run(() => api.snippets.remove(snippet.id)))) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Command">
        <textarea className="mono" required spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)} />
      </Field>
      <Field label="Tags" hint="Comma separated, optional">
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <div className="form-actions">
        {exists && (
          <button type="button" className="danger ghost" onClick={remove}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="primary">
          Save
        </button>
      </div>
    </form>
  )
}
```

`src/renderer/src/views/KnownHostsView.tsx`:
```tsx
import { api } from '../api'
import { Empty } from '../components/Empty'
import { useData } from '../data'
import { ShieldIcon } from '../icons'
import { useAction } from '../toast'

export function KnownHostsView() {
  const { knownHosts, reload } = useData()
  const run = useAction()
  const entries = Object.entries(knownHosts).sort(([a], [b]) => a.localeCompare(b))

  const remove = async (id: string) => {
    if (!confirm(`Forget ${id}? You will be asked to trust it again on the next connection.`)) return
    if (await run(() => api.knownHosts.remove(id))) void reload()
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Known hosts</h1>
      </header>
      <p className="muted">Servers you trusted. Burrow warns you when one of them presents a different key.</p>
      {entries.length === 0 ? (
        <Empty title="No known hosts" text="Hosts show up here after you trust them on the first connection." />
      ) : (
        <div className="list">
          {entries.map(([id, h]) => (
            <div key={id} className="list-row">
              <div className="list-icon">
                <ShieldIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{id}</div>
                <div className="list-sub mono">
                  {h.algo} · {h.fingerprint}
                </div>
              </div>
              <span className="muted">{new Date(h.addedAt).toLocaleDateString()}</span>
              <button className="danger ghost" onClick={() => remove(id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

`src/renderer/src/views/SettingsView.tsx`:
```tsx
import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { api } from '../api'
import { Field } from '../components/Field'
import { useData } from '../data'
import { useAction } from '../toast'

export function SettingsView() {
  const { settings, reload } = useData()
  const run = useAction()
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [settings])

  const save = async (next: Settings) => {
    setDraft(next)
    if (await run(() => api.settings.save(next))) void reload()
  }

  return (
    <div className="view narrow">
      <header className="view-header">
        <h1>Settings</h1>
      </header>
      <div className="form">
        <Field label="Theme">
          <div className="segmented">
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} type="button" className={draft.theme === t ? 'on' : ''} onClick={() => save({ ...draft, theme: t })}>
                {t === 'dark' ? 'Dark' : 'Light'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Terminal font">
          <input
            value={draft.fontFamily}
            onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}
            onBlur={() => draft.fontFamily !== settings.fontFamily && save(draft)}
          />
        </Field>
        <Field label="Font size">
          <input
            type="number"
            min={8}
            max={32}
            value={draft.fontSize}
            onChange={(e) => setDraft({ ...draft, fontSize: Number(e.target.value) })}
            onBlur={() => draft.fontSize !== settings.fontSize && save(draft)}
          />
        </Field>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Create HomeView, App and the entry point**

`src/renderer/src/HomeView.tsx`:
```tsx
import { useState, type ReactNode } from 'react'
import { api } from './api'
import { useData } from './data'
import { BurrowMark, CodeIcon, LockIcon, SettingsIcon, ShieldIcon } from './icons'
import { useAction } from './toast'
import { KnownHostsView } from './views/KnownHostsView'
import { SettingsView } from './views/SettingsView'
import { SnippetsView } from './views/SnippetsView'

type Section = 'snippets' | 'knownHosts' | 'settings'

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'snippets', label: 'Snippets', icon: <CodeIcon /> },
  { id: 'knownHosts', label: 'Known hosts', icon: <ShieldIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> }
]

export function HomeView({ onLock }: { onLock: () => void }) {
  const [section, setSection] = useState<Section>('snippets')
  const { loadErrors, reload } = useData()
  const run = useAction()

  const reset = async (file: string) => {
    if (!confirm(`Reset ${file}? A backup copy is kept next to it.`)) return
    if (await run(() => api.files.reset(file), `${file} was reset`)) void reload()
  }

  return (
    <div className="home">
      <nav className="sidebar">
        <div className="brand">
          <BurrowMark /> Burrow
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => setSection(n.id)}>
            {n.icon}
            {n.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="nav-item" onClick={onLock}>
          <LockIcon /> Lock vault
        </button>
      </nav>
      <main className="home-main">
        {loadErrors.map((e) => (
          <div key={e.file} className="banner">
            <span className="spacer">{e.file} could not be read. Changes to it are blocked until you reset it.</span>
            <button onClick={() => reset(e.file)}>Reset</button>
          </div>
        ))}
        {section === 'snippets' && <SnippetsView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
```

`src/renderer/src/App.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react'
import type { VaultStatus } from '../../shared/types'
import { api } from './api'
import { DataProvider } from './data'
import { HomeView } from './HomeView'
import { PromptDialog } from './PromptDialog'
import { ToastProvider } from './toast'
import { UnlockScreen } from './UnlockScreen'

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const refresh = useCallback(() => {
    void api.vault.status().then(setStatus)
  }, [])
  useEffect(refresh, [refresh])

  if (status === null) return null
  if (status !== 'unlocked') return <UnlockScreen status={status} onDone={refresh} />

  const lock = async () => {
    await api.vault.lock()
    refresh()
  }
  return (
    <ToastProvider>
      <DataProvider>
        <div className="app">
          <div className="app-body">
            <div className="tab-content">
              <HomeView onLock={lock} />
            </div>
          </div>
        </div>
        <PromptDialog />
      </DataProvider>
    </ToastProvider>
  )
}
```

`src/renderer/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 7: Create the stylesheet**

`src/renderer/src/styles.css`:
```css
:root,
:root[data-theme='dark'] {
  --bg: #15171c;
  --surface: #1b1e25;
  --surface-2: #22262f;
  --surface-3: #2b303b;
  --border: #2e333e;
  --text: #e6e8ee;
  --muted: #8b92a5;
  --accent: #5b8cff;
  --accent-hover: #6f9bff;
  --accent-text: #ffffff;
  --danger: #ef5b5b;
  --ok: #3fcf8e;
  --warn: #f2b84b;
  --shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  color-scheme: dark;
}

:root[data-theme='light'] {
  --bg: #f4f5f8;
  --surface: #ffffff;
  --surface-2: #ffffff;
  --surface-3: #eceef3;
  --border: #dfe2e9;
  --text: #1b1f27;
  --muted: #667085;
  --accent: #3d6df2;
  --accent-hover: #2f5de0;
  --accent-text: #ffffff;
  --danger: #d64545;
  --ok: #1f9d63;
  --warn: #b7791f;
  --shadow: 0 12px 40px rgba(20, 30, 50, 0.15);
  color-scheme: light;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Cantarell, sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  overflow: hidden;
}
input, textarea, select, button { font: inherit; color: inherit; }
p { margin: 0; }
.mono { font-family: Menlo, 'DejaVu Sans Mono', monospace; font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.error { color: var(--danger); }
.spacer { flex: 1; }
[hidden] { display: none !important; }

button {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
button:hover:not(:disabled) { filter: brightness(1.12); }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover:not(:disabled) { background: var(--accent-hover); filter: none; }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
button.ghost { background: transparent; border-color: transparent; }
button.danger.ghost { background: transparent; border-color: transparent; color: var(--danger); }
button.link { background: none; border: none; padding: 0; color: var(--accent); }
.icon-btn { background: transparent; border: none; padding: 5px; border-radius: 6px; color: var(--muted); }
.icon-btn:hover:not(:disabled) { background: var(--surface-3); color: var(--text); filter: none; }

input, textarea, select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  outline: none;
  width: 100%;
  user-select: text;
}
input:focus, textarea:focus, select:focus { border-color: var(--accent); }
textarea { resize: vertical; min-height: 90px; }
input[type='checkbox'] { width: auto; }

/* Unlock screen */
.center-screen {
  height: 100%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 30%, var(--surface-2), var(--bg) 70%);
}
.auth-card {
  width: 360px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 28px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.auth-card h1 { margin: 0; font-size: 20px; }
.auth-card h2 { margin: 0; font-size: 16px; }
.auth-logo { display: flex; align-items: center; gap: 10px; }
.auth-logo svg { width: 32px; height: 32px; }

/* App frame and tabs */
.app { height: 100%; display: flex; flex-direction: column; }
.app-body { flex: 1; min-height: 0; position: relative; }
.tab-content { position: absolute; inset: 0; display: flex; }
.tabbar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 6px 8px 0;
  height: 40px;
  overflow-x: auto;
  flex-shrink: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-radius: 8px 8px 0 0;
  background: transparent;
  border: none;
  color: var(--muted);
  max-width: 220px;
  cursor: pointer;
}
.tab:hover { background: var(--surface-2); color: var(--text); filter: none; }
.tab.active { background: var(--bg); color: var(--text); }
.tab-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { background: none; border: none; padding: 0 2px; color: var(--muted); line-height: 1; visibility: hidden; }
.tab:hover .tab-close, .tab.active .tab-close { visibility: visible; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--muted); }
.dot.connecting { background: var(--warn); }
.dot.connected { background: var(--ok); }
.dot.closed { background: var(--danger); }

/* Home */
.home { flex: 1; display: flex; min-width: 0; }
.sidebar {
  width: 210px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
}
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; padding: 4px 10px 16px; }
.nav-item { background: transparent; border: none; justify-content: flex-start; padding: 8px 10px; color: var(--muted); border-radius: 7px; width: 100%; }
.nav-item:hover { background: var(--surface-2); color: var(--text); filter: none; }
.nav-item.active { background: var(--surface-3); color: var(--text); }
.home-main { flex: 1; min-width: 0; overflow-y: auto; }
.view { padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; }
.view.narrow { max-width: 560px; }
.view-header { display: flex; align-items: center; gap: 10px; }
.view-header h1 { margin: 0; font-size: 20px; font-weight: 600; }
.search { max-width: 340px; }
.group-title { margin: 6px 0 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
.banner {
  background: color-mix(in srgb, var(--danger) 15%, transparent);
  border: 1px solid var(--danger);
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 28px 0;
}

/* Host cards */
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
.host-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  outline: none;
}
.host-card:hover, .host-card:focus { border-color: var(--accent); }
.host-icon, .list-icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--accent-text);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.host-info { flex: 1; min-width: 0; }
.host-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-actions { display: flex; opacity: 0; transition: opacity 0.1s; }
.host-card:hover .host-actions, .host-card:focus .host-actions { opacity: 1; }

/* Lists */
.list { display: flex; flex-direction: column; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.list-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.list-row:last-child { border-bottom: none; }
.list-row.clickable { cursor: pointer; }
.list-row.clickable:hover { background: var(--surface-3); }
.list-main { flex: 1; min-width: 0; }
.list-title { font-weight: 600; }
.list-sub { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { background: var(--surface-3); border-radius: 10px; padding: 1px 8px; font-size: 11px; color: var(--muted); }
.empty { text-align: center; padding: 60px 20px; }
.empty h3 { margin: 0 0 6px; }

/* Side panel and modals */
.panel-backdrop, .modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); z-index: 10; }
.side-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  max-width: 100%;
  background: var(--surface);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
  z-index: 11;
  display: flex;
  flex-direction: column;
  animation: slide-in 0.15s ease-out;
}
@keyframes slide-in { from { transform: translateX(30px); opacity: 0; } }
.side-panel header { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.side-panel h2 { margin: 0; font-size: 16px; flex: 1; }
.side-panel-body { padding: 20px; overflow-y: auto; flex: 1; }
.modal-backdrop { display: grid; place-items: center; z-index: 20; }
.modal {
  width: 460px;
  max-width: calc(100% - 32px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal h3 { margin: 0; font-size: 16px; }
.modal.warning { border-color: var(--danger); }
.modal.warning h3 { color: var(--danger); }
.fp { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; word-break: break-all; user-select: text; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }

/* Forms */
.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: var(--muted); font-weight: 500; }
.field-hint { font-size: 12px; color: var(--muted); }
.row { display: flex; gap: 10px; }
.row > .field:first-child { flex: 1; }
.form-actions { display: flex; gap: 8px; margin-top: 8px; }
.segmented { display: flex; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 2px; }
.segmented button { flex: 1; justify-content: center; background: transparent; border: none; padding: 5px; }
.segmented button.on { background: var(--surface-3); }
.check { display: flex; align-items: center; gap: 8px; }

/* Toasts */
.toasts { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 30; }
.toast { background: var(--surface-3); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; box-shadow: var(--shadow); max-width: 380px; }
.toast.error { border-color: var(--danger); }

/* Session */
.session { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.session-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.session-title { font-weight: 600; margin-right: 6px; }
.toggle { background: transparent; border-color: transparent; color: var(--muted); }
.toggle.on { background: var(--surface-3); color: var(--text); border-color: var(--border); }
.session-body { flex: 1; display: flex; min-height: 0; }
.session-terminals { flex: 1; min-width: 0; display: flex; background: var(--bg); }
.split { flex: 1; display: flex; min-width: 0; min-height: 0; }
.split-row { flex-direction: row; }
.split-col { flex-direction: column; }
.split-cell { display: flex; min-width: 0; min-height: 0; }
.divider { background: var(--border); flex-shrink: 0; }
.divider-row { width: 4px; cursor: col-resize; }
.divider-col { height: 4px; cursor: row-resize; }
.divider:hover { background: var(--accent); }
.pane { flex: 1; position: relative; min-width: 0; min-height: 0; display: flex; border: 1px solid transparent; }
.pane.focused { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.pane-term { flex: 1; min-width: 0; min-height: 0; padding: 6px 0 0 8px; }
.terminal-host { width: 100%; height: 100%; }
.terminal-host .xterm { height: 100%; }
.pane-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  text-align: center;
  padding: 20px;
}
.spinner { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Snippets drawer and SFTP */
.drawer, .sftp {
  width: 300px;
  border-left: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex-shrink: 0;
}
.sftp { width: 380px; }
.drawer-header, .sftp-header { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-weight: 600; }
.drawer .search { margin: 10px 12px; width: auto; max-width: none; }
.drawer-list { overflow-y: auto; flex: 1; }
.snippet-item { display: block; width: 100%; text-align: left; background: transparent; border: none; border-radius: 0; padding: 9px 12px; border-bottom: 1px solid var(--border); }
.snippet-item:hover { background: var(--surface-2); filter: none; }
.pad { padding: 12px; }
.sftp-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
.sftp-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.sftp-actions button { padding: 4px 9px; font-size: 12px; }
.sftp-list { flex: 1; overflow-y: auto; }
.sftp-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px; }
.sftp-row:hover { background: var(--surface-2); }
.sftp-row.selected { background: color-mix(in srgb, var(--accent) 25%, transparent); }
.sftp-icon { color: var(--muted); display: flex; }
.sftp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sftp-size { font-size: 12px; }
.sftp-hint { padding: 8px 12px; font-size: 12px; border-top: 1px solid var(--border); }
.sftp.drag-over { outline: 2px dashed var(--accent); outline-offset: -4px; }
.sftp-empty { padding: 20px; }
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run build`
Expected: no errors.

Run `npm run dev` and check:
- A fresh data dir shows "Create vault". Mismatched passwords show an error; matching ones open the home view.
- Snippets: create, edit, delete a snippet. `snippets.json` in the data dir updates.
- Settings: switching to Light changes the theme immediately and persists after a restart.
- Lock vault returns to the unlock screen; a wrong password shows "Wrong password"; the right one unlocks.

To start from a clean state during testing, quit the app and delete `~/Library/Application Support/Burrow Client/` (only this app's folder). Stop the dev process afterwards.

- [ ] **Step 9: Commit**

```bash
git add src/renderer
git commit -m "Add renderer foundation: unlock, dialogs, snippets, known hosts, settings"
```

---

### Task 10: Hosts and Keychain views

**Files:**
- Create: `src/renderer/src/views/HostsView.tsx`, `src/renderer/src/views/HostForm.tsx`, `src/renderer/src/views/KeychainView.tsx`
- Modify: `src/renderer/src/HomeView.tsx` (replace whole file), `src/renderer/src/App.tsx` (pass `onConnect`)

**Interfaces:**
- Consumes: Task 9 components and hooks.
- Produces: `HomeView({ onConnect(profileId: string): void; onLock(): void })`, `HostsView({ onConnect })`, `newProfile(): Profile`.

- [ ] **Step 1: Create the host form**

`src/renderer/src/views/HostForm.tsx`:
```tsx
import { useEffect, useState, type FormEvent } from 'react'
import type { Profile } from '../../../shared/types'
import { api } from '../api'
import { Field } from '../components/Field'
import { useData } from '../data'
import { useAction } from '../toast'

export const newProfile = (): Profile => ({
  id: crypto.randomUUID(),
  name: '',
  group: '',
  host: '',
  port: 22,
  user: '',
  authType: 'password'
})

export function HostForm({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { keys, profiles } = useData()
  const run = useAction()
  const [p, setP] = useState(profile)
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const exists = profiles.some((x) => x.id === profile.id)
  const groups = [...new Set(profiles.map((x) => x.group).filter(Boolean))]

  useEffect(() => {
    if (exists) void api.profiles.hasPassword(profile.id).then(setHasPassword)
  }, [exists, profile.id])

  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => setP((x) => ({ ...x, [key]: value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pw = p.authType === 'password' && password ? password : undefined
    if (await run(() => api.profiles.save(p, pw))) onDone()
  }
  const remove = async () => {
    if (confirm(`Delete ${profile.name}?`) && (await run(() => api.profiles.remove(profile.id)))) onDone()
  }
  const forget = () =>
    run(async () => {
      await api.profiles.forgetPassword(profile.id)
      setHasPassword(false)
    }, 'Saved password removed')

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Label">
        <input autoFocus required value={p.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Web server" />
      </Field>
      <Field label="Group">
        <input list="host-groups" value={p.group} onChange={(e) => set('group', e.target.value)} placeholder="Optional" />
        <datalist id="host-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </Field>
      <div className="row">
        <Field label="Host">
          <input required value={p.host} onChange={(e) => set('host', e.target.value)} placeholder="example.com or 10.0.0.5" />
        </Field>
        <Field label="Port" width={90}>
          <input type="number" min={1} max={65535} required value={p.port} onChange={(e) => set('port', Number(e.target.value))} />
        </Field>
      </div>
      <Field label="Username">
        <input required value={p.user} onChange={(e) => set('user', e.target.value)} />
      </Field>
      <Field label="Authentication">
        <div className="segmented">
          <button type="button" className={p.authType === 'password' ? 'on' : ''} onClick={() => set('authType', 'password')}>
            Password
          </button>
          <button type="button" className={p.authType === 'key' ? 'on' : ''} onClick={() => set('authType', 'key')}>
            Key
          </button>
        </div>
      </Field>
      {p.authType === 'password' ? (
        <Field
          label="Password"
          hint={
            hasPassword ? (
              <>
                A password is saved in the vault. Type a new one to replace it, or{' '}
                <button type="button" className="link" onClick={forget}>
                  forget it
                </button>
                .
              </>
            ) : (
              'Leave empty to be asked when connecting.'
            )
          }
        >
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      ) : (
        <Field label="Key">
          {keys.length === 0 ? (
            <p className="muted">No keys yet. Create or import one in Keychain first.</p>
          ) : (
            <select required value={p.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || undefined)}>
              <option value="">Choose a key</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.type})
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="form-actions">
        {exists && (
          <button type="button" className="danger ghost" onClick={remove}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="primary">
          Save
        </button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Create the hosts view**

`src/renderer/src/views/HostsView.tsx`:
```tsx
import { useState } from 'react'
import type { Profile } from '../../../shared/types'
import { Empty } from '../components/Empty'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { EditIcon, PlayIcon, PlusIcon, ServerIcon } from '../icons'
import { HostForm, newProfile } from './HostForm'

export function HostsView({ onConnect }: { onConnect: (profileId: string) => void }) {
  const { profiles, reload } = useData()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Profile | null>(null)

  const q = query.toLowerCase()
  const filtered = profiles
    .filter((p) => `${p.name} ${p.host} ${p.user} ${p.group}`.toLowerCase().includes(q))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  const groups = new Map<string, Profile[]>()
  for (const p of filtered) {
    const g = p.group || 'Ungrouped'
    groups.set(g, [...(groups.get(g) ?? []), p])
  }
  const exists = editing ? profiles.some((p) => p.id === editing.id) : false

  return (
    <div className="view">
      <header className="view-header">
        <h1>Hosts</h1>
        <input className="search" placeholder="Search hosts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing(newProfile())}>
          <PlusIcon /> New host
        </button>
      </header>
      {profiles.length === 0 ? (
        <Empty title="No hosts yet" text="Add your first server to get started." />
      ) : (
        [...groups].map(([group, items]) => (
          <section key={group}>
            <h3 className="group-title">{group}</h3>
            <div className="card-grid">
              {items.map((p) => (
                <div
                  key={p.id}
                  className="host-card"
                  tabIndex={0}
                  onDoubleClick={() => onConnect(p.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onConnect(p.id)}
                >
                  <div className="host-icon">
                    <ServerIcon />
                  </div>
                  <div className="host-info">
                    <div className="host-name">{p.name}</div>
                    <div className="host-sub">
                      {p.user}@{p.host}
                      {p.port !== 22 ? `:${p.port}` : ''}
                    </div>
                  </div>
                  <div className="host-actions">
                    <button className="icon-btn" title="Edit" onClick={() => setEditing(p)}>
                      <EditIcon />
                    </button>
                    <button className="icon-btn" title="Connect" onClick={() => onConnect(p.id)}>
                      <PlayIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      {editing && (
        <SidePanel title={exists ? 'Edit host' : 'New host'} onClose={() => setEditing(null)}>
          <HostForm
            profile={editing}
            onDone={() => {
              setEditing(null)
              void reload()
            }}
          />
        </SidePanel>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create the keychain view**

`src/renderer/src/views/KeychainView.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import type { KeyType } from '../../../shared/types'
import { api } from '../api'
import { Empty } from '../components/Empty'
import { Field } from '../components/Field'
import { SidePanel } from '../components/SidePanel'
import { useData } from '../data'
import { KeyIcon, PlusIcon } from '../icons'
import { useAction } from '../toast'

export function KeychainView() {
  const { keys, reload } = useData()
  const run = useAction()
  const [mode, setMode] = useState<'generate' | 'import' | null>(null)
  const done = () => {
    setMode(null)
    void reload()
  }
  const remove = async (id: string, name: string) => {
    if (confirm(`Delete key "${name}"? This cannot be undone.`) && (await run(() => api.keys.remove(id)))) void reload()
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Keychain</h1>
        <span className="spacer" />
        <button onClick={() => setMode('import')}>Import</button>
        <button className="primary" onClick={() => setMode('generate')}>
          <PlusIcon /> Generate key
        </button>
      </header>
      {keys.length === 0 ? (
        <Empty title="No keys yet" text="Generate a new key or import an existing private key." />
      ) : (
        <div className="list">
          {keys.map((k) => (
            <div key={k.id} className="list-row">
              <div className="list-icon">
                <KeyIcon />
              </div>
              <div className="list-main">
                <div className="list-title">{k.name}</div>
                <div className="list-sub mono">
                  {k.type} · {k.fingerprint}
                </div>
              </div>
              <button onClick={() => run(() => navigator.clipboard.writeText(k.publicKey), 'Public key copied')}>
                Copy public key
              </button>
              <button className="danger ghost" onClick={() => remove(k.id, k.name)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {mode && (
        <SidePanel title={mode === 'generate' ? 'Generate key' : 'Import key'} onClose={() => setMode(null)}>
          {mode === 'generate' ? <GenerateKeyForm onDone={done} /> : <ImportKeyForm onDone={done} />}
        </SidePanel>
      )}
    </div>
  )
}

function GenerateKeyForm({ onDone }: { onDone: () => void }) {
  const run = useAction()
  const [name, setName] = useState('')
  const [type, setType] = useState<KeyType>('ed25519')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const ok = await run(() => api.keys.generate(name, type), 'Key created')
    setBusy(false)
    if (ok) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" />
      </Field>
      <Field label="Type" hint="Ed25519 is the modern default. Pick RSA only for old servers without Ed25519 support.">
        <div className="segmented">
          <button type="button" className={type === 'ed25519' ? 'on' : ''} onClick={() => setType('ed25519')}>
            Ed25519
          </button>
          <button type="button" className={type === 'rsa' ? 'on' : ''} onClick={() => setType('rsa')}>
            RSA 4096
          </button>
        </div>
      </Field>
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </form>
  )
}

function ImportKeyForm({ onDone }: { onDone: () => void }) {
  const run = useAction()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const load = () =>
    run(async () => {
      const text = await api.keys.readFile()
      if (text !== null) setKey(text)
    })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => api.keys.importKey(name, key, passphrase || undefined), 'Key imported')) onDone()
  }

  return (
    <form className="form" onSubmit={submit}>
      <Field label="Name">
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field
        label="Private key"
        hint={
          <button type="button" className="link" onClick={load}>
            Load from file…
          </button>
        }
      >
        <textarea
          className="mono"
          required
          rows={8}
          spellCheck={false}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      <Field label="Passphrase" hint="Only needed if the key is encrypted. It is stored in the vault.">
        <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
      </Field>
      <div className="form-actions">
        <span className="spacer" />
        <button type="submit" className="primary">
          Import
        </button>
      </div>
    </form>
  )
}
```

- [ ] **Step 4: Replace HomeView**

`src/renderer/src/HomeView.tsx`:
```tsx
import { useState, type ReactNode } from 'react'
import { api } from './api'
import { useData } from './data'
import { BurrowMark, CodeIcon, KeyIcon, LockIcon, ServerIcon, SettingsIcon, ShieldIcon } from './icons'
import { useAction } from './toast'
import { HostsView } from './views/HostsView'
import { KeychainView } from './views/KeychainView'
import { KnownHostsView } from './views/KnownHostsView'
import { SettingsView } from './views/SettingsView'
import { SnippetsView } from './views/SnippetsView'

type Section = 'hosts' | 'keychain' | 'snippets' | 'knownHosts' | 'settings'

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'hosts', label: 'Hosts', icon: <ServerIcon /> },
  { id: 'keychain', label: 'Keychain', icon: <KeyIcon /> },
  { id: 'snippets', label: 'Snippets', icon: <CodeIcon /> },
  { id: 'knownHosts', label: 'Known hosts', icon: <ShieldIcon /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon /> }
]

export function HomeView({ onConnect, onLock }: { onConnect: (profileId: string) => void; onLock: () => void }) {
  const [section, setSection] = useState<Section>('hosts')
  const { loadErrors, reload } = useData()
  const run = useAction()

  const reset = async (file: string) => {
    if (!confirm(`Reset ${file}? A backup copy is kept next to it.`)) return
    if (await run(() => api.files.reset(file), `${file} was reset`)) void reload()
  }

  return (
    <div className="home">
      <nav className="sidebar">
        <div className="brand">
          <BurrowMark /> Burrow
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => setSection(n.id)}>
            {n.icon}
            {n.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="nav-item" onClick={onLock}>
          <LockIcon /> Lock vault
        </button>
      </nav>
      <main className="home-main">
        {loadErrors.map((e) => (
          <div key={e.file} className="banner">
            <span className="spacer">{e.file} could not be read. Changes to it are blocked until you reset it.</span>
            <button onClick={() => reset(e.file)}>Reset</button>
          </div>
        ))}
        {section === 'hosts' && <HostsView onConnect={onConnect} />}
        {section === 'keychain' && <KeychainView />}
        {section === 'snippets' && <SnippetsView />}
        {section === 'knownHosts' && <KnownHostsView />}
        {section === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Pass onConnect from App**

In `src/renderer/src/App.tsx`, change `<HomeView onLock={lock} />` to:
```tsx
<HomeView onConnect={() => undefined} onLock={lock} />
```
Task 11 replaces this with real session tabs.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run build`
Expected: no errors.

Run `npm run dev` and check:
- Hosts: create a host, it appears as a card under its group; search filters; editing opens the side panel; Escape closes it.
- A password typed in the form is not in `profiles.json` (check the file). Reopening the host shows "A password is saved"; "forget it" removes it.
- Keychain: generate an Ed25519 key and an RSA key (RSA takes a few seconds, the button shows "Generating…"). "Copy public key" puts an `ssh-ed25519 AAAA… name` line on the clipboard.
- Import: pasting garbage shows an error toast; importing an encrypted key without passphrase shows "This key is encrypted. Enter its passphrase."
- A host using a key blocks deleting that key with "Key is used by: <host>".

Stop the dev process afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/renderer
git commit -m "Add hosts and keychain views"
```

---
### Task 11: Session tabs, terminals and split panes

**Files:**
- Create: `src/renderer/src/session/layout.ts`, `shortcuts.ts`, `terminalHost.ts`, `PaneSlot.tsx`, `SplitView.tsx`, `SessionTab.tsx`
- Create: `src/renderer/src/TabBar.tsx`, `src/renderer/src/Main.tsx`
- Create: `scripts/dev-ssh-server.ts`
- Modify: `src/renderer/src/App.tsx` (replace whole file), `package.json` (add `dev:server` script)
- Test: `tests/layout.test.ts`

**Interfaces:**
- Consumes: `api`, `useData`, `errMsg`, icons from Task 9; `HomeView({ onConnect, onLock })` from Task 10; `startTestServer` from Task 5.
- Produces:
  - `type PaneNode`, `pane(id)`, `paneIds(node)`, `splitPane(node, targetId, dir, newId)`, `removePane(node, targetId)`, `resizeSplit(node, splitId, sizes)`
  - `isMac: boolean`, `type ShortcutAction = 'splitRight' | 'splitDown' | 'closePane'`, `matchShortcut(e: KeyboardEvent): ShortcutAction | null`, `SHORTCUT_LABELS`
  - `class TerminalHost { el; status: PaneStatus; sessionId: string | null; onFocus?: () => void; attach(slot); detach(); connect(); send(text); focus(); applySettings(s); subscribe(fn): () => void; dispose() }`
  - `useHostStatus(host): PaneStatus`
  - `SessionTab({ profileId, active, onStatus(s: TabStatus), onEmpty() })`, `type TabStatus = 'connecting' | 'connected' | 'closed'`

- [ ] **Step 1: Write the failing layout tests**

`tests/layout.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { pane, paneIds, removePane, resizeSplit, splitPane, type PaneNode } from '../src/renderer/src/session/layout'

type Split = Extract<PaneNode, { type: 'split' }>

describe('layout', () => {
  it('splits a single pane', () => {
    expect(splitPane(pane('a'), 'a', 'row', 'b')).toEqual({
      type: 'split',
      id: 'split-b',
      dir: 'row',
      children: [pane('a'), pane('b')],
      sizes: [0.5, 0.5]
    })
  })

  it('adds a sibling when splitting in the same direction', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'a', 'row', 'c')
    expect(paneIds(l)).toEqual(['a', 'c', 'b'])
    expect((l as Split).sizes).toEqual([0.25, 0.25, 0.5])
  })

  it('nests when splitting in the other direction', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'b', 'col', 'c')
    expect(l).toMatchObject({
      dir: 'row',
      children: [pane('a'), { type: 'split', dir: 'col', children: [pane('b'), pane('c')] }]
    })
  })

  it('removes panes and collapses single-child splits', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'b', 'col', 'c')
    const r = removePane(l, 'c')!
    expect(r).toMatchObject({ dir: 'row', children: [pane('a'), pane('b')] })
    expect(removePane(r, 'a')).toEqual(pane('b'))
    expect(removePane(pane('b'), 'b')).toBeNull()
  })

  it('renormalizes sizes after removal', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'a', 'row', 'c')
    expect((removePane(l, 'b') as Split).sizes).toEqual([0.5, 0.5])
  })

  it('resizes a split by id', () => {
    expect(resizeSplit(splitPane(pane('a'), 'a', 'row', 'b'), 'split-b', [0.3, 0.7])).toMatchObject({ sizes: [0.3, 0.7] })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/layout.test.ts`
Expected: FAIL, cannot resolve `../src/renderer/src/session/layout`.

- [ ] **Step 3: Implement the layout functions**

`src/renderer/src/session/layout.ts`:
```ts
export type SplitDir = 'row' | 'col'

export type PaneNode =
  | { type: 'pane'; id: string }
  | { type: 'split'; id: string; dir: SplitDir; children: PaneNode[]; sizes: number[] }

export function pane(id: string): PaneNode {
  return { type: 'pane', id }
}

export function paneIds(node: PaneNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(paneIds)
}

export function splitPane(node: PaneNode, targetId: string, dir: SplitDir, newId: string): PaneNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return { type: 'split', id: `split-${newId}`, dir, children: [node, pane(newId)], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    children.splice(i + 1, 0, pane(newId))
    const sizes = [...node.sizes]
    const half = sizes[i] / 2
    sizes.splice(i, 1, half, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => splitPane(c, targetId, dir, newId)) }
}

export function removePane(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === 'pane') return node.id === targetId ? null : node
  const children: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const kept = removePane(c, targetId)
    if (kept) {
      children.push(kept)
      sizes.push(node.sizes[i])
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children, sizes: sizes.map((s) => s / total) }
}

export function resizeSplit(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, sizes }
  return { ...node, children: node.children.map((c) => resizeSplit(c, splitId, sizes)) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/layout.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Create shortcuts and the terminal host**

`src/renderer/src/session/shortcuts.ts`:
```ts
import { api } from '../api'

export const isMac = api.platform === 'darwin'

export type ShortcutAction = 'splitRight' | 'splitDown' | 'closePane'

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = isMac
  ? { splitRight: '⌘D', splitDown: '⇧⌘D', closePane: '⌘W' }
  : { splitRight: 'Ctrl+Shift+D', splitDown: 'Ctrl+Shift+E', closePane: 'Ctrl+Shift+W' }

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (e.type !== 'keydown' || e.altKey) return null
  const key = e.key.toLowerCase()
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return null
    if (key === 'd') return e.shiftKey ? 'splitDown' : 'splitRight'
    if (key === 'w' && !e.shiftKey) return 'closePane'
    return null
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null
  if (key === 'd') return 'splitRight'
  if (key === 'e') return 'splitDown'
  if (key === 'w') return 'closePane'
  return null
}
```

`src/renderer/src/session/terminalHost.ts`:
```ts
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useCallback, useSyncExternalStore } from 'react'
import type { Settings } from '../../../shared/types'
import { api } from '../api'
import { errMsg } from '../util'
import { isMac, matchShortcut } from './shortcuts'

export type PaneStatus = { state: 'connecting' } | { state: 'connected' } | { state: 'closed'; reason: string }

const THEMES: Record<Settings['theme'], ITheme> = {
  dark: { background: '#15171c', foreground: '#d8dee9', cursor: '#7aa2f7', selectionBackground: '#3b4261' },
  light: { background: '#f4f5f8', foreground: '#1f2328', cursor: '#3d6df2', selectionBackground: '#c9d4f5' }
}

/**
 * One terminal pane and its SSH session. Lives outside React so it survives split-layout changes:
 * React only moves `el` between slot elements.
 */
export class TerminalHost {
  readonly el = document.createElement('div')
  status: PaneStatus = { state: 'connecting' }
  sessionId: string | null = null
  onFocus?: () => void
  private readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly listeners = new Set<() => void>()
  private readonly resizeObserver = new ResizeObserver(() => this.fitNow())
  private unsubscribe: (() => void)[] = []
  private opened = false
  private disposed = false

  constructor(
    private readonly profileId: string,
    settings: Settings
  ) {
    this.el.className = 'terminal-host'
    this.term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      theme: THEMES[settings.theme],
      cursorBlink: true,
      scrollback: 5000
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(new WebLinksAddon((_event, uri) => void api.openExternal(uri)))
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e))
    this.term.onData((data) => this.send(data))
    this.term.onResize(({ cols, rows }) => {
      if (this.sessionId && this.status.state === 'connected') api.session.resize(this.sessionId, cols, rows)
    })
  }

  attach(slot: HTMLElement): void {
    slot.appendChild(this.el)
    if (this.opened) return this.fitNow()
    this.opened = true
    this.term.open(this.el)
    this.term.textarea?.addEventListener('focus', () => this.onFocus?.())
    this.resizeObserver.observe(this.el)
    this.fitNow()
    void this.connect()
  }

  detach(): void {
    this.el.remove()
  }

  async connect(): Promise<void> {
    if (this.disposed) return
    this.unsubscribe.forEach((u) => u())
    const id = crypto.randomUUID()
    this.sessionId = id
    this.setStatus({ state: 'connecting' })
    this.unsubscribe = [
      api.session.onData((sid, data) => {
        if (sid === id) this.term.write(data)
      }),
      api.session.onClosed((sid, reason) => {
        if (sid === id) this.setStatus({ state: 'closed', reason })
      })
    ]
    try {
      await api.session.connect(id, this.profileId, this.term.cols, this.term.rows)
      if (this.disposed) return void api.session.close(id)
      if (this.sessionId !== id || this.status.state !== 'connecting') return
      this.setStatus({ state: 'connected' })
      api.session.resize(id, this.term.cols, this.term.rows)
      this.term.focus()
    } catch (e) {
      if (this.sessionId === id) this.setStatus({ state: 'closed', reason: errMsg(e) })
    }
  }

  send(text: string): void {
    if (this.sessionId && this.status.state === 'connected') api.session.write(this.sessionId, text)
  }

  focus(): void {
    this.term.focus()
  }

  applySettings(s: Settings): void {
    this.term.options.fontFamily = s.fontFamily
    this.term.options.fontSize = s.fontSize
    this.term.options.theme = THEMES[s.theme]
    this.fitNow()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe.forEach((u) => u())
    this.resizeObserver.disconnect()
    if (this.sessionId) void api.session.close(this.sessionId)
    this.term.dispose()
    this.el.remove()
    this.listeners.clear()
  }

  private setStatus(status: PaneStatus): void {
    this.status = status
    this.listeners.forEach((fn) => fn())
  }

  private fitNow(): void {
    if (this.opened && this.el.offsetWidth > 0 && this.el.offsetHeight > 0) this.fit.fit()
  }

  /** Returning false stops xterm from handling the key (it still bubbles to window listeners). */
  private handleKey(e: KeyboardEvent): boolean {
    if (matchShortcut(e)) return false
    if (!isMac && e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'c') {
        const selection = this.term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
        return false
      }
      if (key === 'v') {
        void navigator.clipboard.readText().then((text) => this.term.paste(text))
        return false
      }
    }
    return true
  }
}

export function useHostStatus(host: TerminalHost): PaneStatus {
  const subscribe = useCallback((fn: () => void) => host.subscribe(fn), [host])
  return useSyncExternalStore(subscribe, () => host.status)
}
```

- [ ] **Step 6: Create PaneSlot and SplitView**

`src/renderer/src/session/PaneSlot.tsx`:
```tsx
import { useLayoutEffect, useRef } from 'react'
import { useHostStatus, type TerminalHost } from './terminalHost'

export function PaneSlot({ host, focused, onClose }: { host: TerminalHost; focused: boolean; onClose: () => void }) {
  const slot = useRef<HTMLDivElement>(null)
  const status = useHostStatus(host)

  useLayoutEffect(() => {
    host.attach(slot.current!)
    return () => host.detach()
  }, [host])

  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={() => host.onFocus?.()}>
      <div ref={slot} className="pane-term" />
      {status.state === 'connecting' && (
        <div className="pane-overlay">
          <div className="spinner" />
          Connecting…
        </div>
      )}
      {status.state === 'closed' && (
        <div className="pane-overlay">
          <p>{status.reason}</p>
          <div className="actions">
            <button onClick={onClose}>Close</button>
            <button className="primary" onClick={() => void host.connect()}>
              Reconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

`src/renderer/src/session/SplitView.tsx`:
```tsx
import { Fragment, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { PaneNode } from './layout'

interface Props {
  node: PaneNode
  renderPane: (paneId: string) => ReactNode
  onResize: (splitId: string, sizes: number[]) => void
}

export function SplitView({ node, renderPane, onResize }: Props) {
  if (node.type === 'pane') return <>{renderPane(node.id)}</>
  return <SplitContainer node={node} renderPane={renderPane} onResize={onResize} />
}

const MIN = 0.1

function SplitContainer({ node, renderPane, onResize }: Props & { node: Extract<PaneNode, { type: 'split' }> }) {
  const ref = useRef<HTMLDivElement>(null)
  const horizontal = node.dir === 'row'

  const startDrag = (i: number) => (e: ReactPointerEvent) => {
    e.preventDefault()
    const rect = ref.current!.getBoundingClientRect()
    const total = horizontal ? rect.width : rect.height
    const start = horizontal ? e.clientX : e.clientY
    const initial = [...node.sizes]
    const pair = initial[i] + initial[i + 1]
    const move = (ev: PointerEvent) => {
      const delta = ((horizontal ? ev.clientX : ev.clientY) - start) / total
      const a = Math.max(MIN, Math.min(pair - MIN, initial[i] + delta))
      const next = [...initial]
      next[i] = a
      next[i + 1] = pair - a
      onResize(node.id, next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div ref={ref} className={`split split-${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <div className={`divider divider-${node.dir}`} onPointerDown={startDrag(i - 1)} />}
          <div className="split-cell" style={{ flexGrow: node.sizes[i], flexBasis: 0 }}>
            <SplitView node={child} renderPane={renderPane} onResize={onResize} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}
```

- [ ] **Step 7: Create SessionTab**

`src/renderer/src/session/SessionTab.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useData } from '../data'
import { SplitDownIcon, SplitRightIcon } from '../icons'
import { pane, paneIds, removePane, resizeSplit, splitPane, type PaneNode } from './layout'
import { PaneSlot } from './PaneSlot'
import { matchShortcut, SHORTCUT_LABELS, type ShortcutAction } from './shortcuts'
import { SplitView } from './SplitView'
import { TerminalHost } from './terminalHost'

export type TabStatus = 'connecting' | 'connected' | 'closed'

interface Props {
  profileId: string
  active: boolean
  onStatus: (status: TabStatus) => void
  onEmpty: () => void
}

export function SessionTab({ profileId, active, onStatus, onEmpty }: Props) {
  const { settings, profiles } = useData()
  const profile = profiles.find((p) => p.id === profileId)
  const hosts = useRef(new Map<string, TerminalHost>())
  const [initialId] = useState(() => crypto.randomUUID())
  const [layout, setLayout] = useState<PaneNode>(() => pane(initialId))
  const [focused, setFocused] = useState(initialId)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const getHost = useCallback(
    (paneId: string) => {
      let host = hosts.current.get(paneId)
      if (!host) {
        host = new TerminalHost(profileId, settingsRef.current)
        host.onFocus = () => setFocused(paneId)
        hosts.current.set(paneId, host)
      }
      return host
    },
    [profileId]
  )

  const closePane = useCallback(
    (paneId: string) => {
      hosts.current.get(paneId)?.dispose()
      hosts.current.delete(paneId)
      const next = removePane(layout, paneId)
      if (!next) return onEmpty()
      setLayout(next)
      setFocused((f) => (f === paneId ? paneIds(next)[0] : f))
    },
    [layout, onEmpty]
  )

  const act = useCallback(
    (action: ShortcutAction) => {
      if (action === 'closePane') return closePane(focused)
      const id = crypto.randomUUID()
      setLayout((l) => splitPane(l, focused, action === 'splitRight' ? 'row' : 'col', id))
      setFocused(id)
    },
    [closePane, focused]
  )

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      act(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, act])

  useEffect(() => {
    if (active) hosts.current.get(focused)?.focus()
  }, [active, focused])

  useEffect(() => {
    hosts.current.forEach((h) => h.applySettings(settings))
  }, [settings])

  useEffect(() => {
    const map = hosts.current
    return () => {
      map.forEach((h) => h.dispose())
      map.clear()
    }
  }, [])

  useEffect(() => {
    const list = paneIds(layout).map(getHost)
    const update = () => {
      const states = list.map((h) => h.status.state)
      onStatusRef.current(states.includes('connected') ? 'connected' : states.includes('connecting') ? 'connecting' : 'closed')
    }
    update()
    const subs = list.map((h) => h.subscribe(update))
    return () => subs.forEach((u) => u())
  }, [layout, getHost])

  return (
    <div className="session">
      <div className="session-toolbar">
        <span className="session-title">{profile?.name ?? 'Deleted host'}</span>
        {profile && (
          <span className="muted">
            {profile.user}@{profile.host}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn" title={`Split right (${SHORTCUT_LABELS.splitRight})`} onClick={() => act('splitRight')}>
          <SplitRightIcon />
        </button>
        <button className="icon-btn" title={`Split down (${SHORTCUT_LABELS.splitDown})`} onClick={() => act('splitDown')}>
          <SplitDownIcon />
        </button>
      </div>
      <div className="session-body">
        <div className="session-terminals">
          <SplitView
            node={layout}
            onResize={(id, sizes) => setLayout((l) => resizeSplit(l, id, sizes))}
            renderPane={(id) => <PaneSlot key={id} host={getHost(id)} focused={id === focused} onClose={() => closePane(id)} />}
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Create TabBar and Main, replace App**

`src/renderer/src/TabBar.tsx`:
```tsx
import { useRef } from 'react'
import { BurrowMark } from './icons'
import type { TabStatus } from './session/SessionTab'

export interface SessionTabInfo {
  id: string
  profileId: string
  title: string
}

interface Props {
  tabs: SessionTabInfo[]
  active: string
  statuses: Record<string, TabStatus>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (tabs: SessionTabInfo[]) => void
}

export function TabBar({ tabs, active, statuses, onSelect, onClose, onReorder }: Props) {
  const dragId = useRef<string | null>(null)

  const drop = (targetId: string) => {
    const from = tabs.findIndex((t) => t.id === dragId.current)
    const to = tabs.findIndex((t) => t.id === targetId)
    dragId.current = null
    if (from < 0 || to < 0 || from === to) return
    const next = [...tabs]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorder(next)
  }

  return (
    <div className="tabbar">
      <button className={`tab ${active === 'home' ? 'active' : ''}`} onClick={() => onSelect('home')}>
        <BurrowMark /> Vault
      </button>
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${active === t.id ? 'active' : ''}`}
          draggable
          onDragStart={() => (dragId.current = t.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => drop(t.id)}
          onClick={() => onSelect(t.id)}
          onAuxClick={(e) => e.button === 1 && onClose(t.id)}
        >
          <span className={`dot ${statuses[t.id] ?? 'connecting'}`} />
          <span className="tab-title">{t.title}</span>
          <button
            className="tab-close"
            aria-label="Close tab"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
```

`src/renderer/src/Main.tsx`:
```tsx
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

  const open = (profileId: string) => {
    const id = crypto.randomUUID()
    const title = profiles.find((p) => p.id === profileId)?.name ?? 'Session'
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
      <TabBar tabs={tabs} active={active} statuses={statuses} onSelect={setActive} onClose={close} onReorder={setTabs} />
      <div className="app-body">
        <div className="tab-content" hidden={active !== 'home'}>
          <HomeView onConnect={open} onLock={onLock} />
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
```

`src/renderer/src/App.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react'
import type { VaultStatus } from '../../shared/types'
import { api } from './api'
import { DataProvider } from './data'
import { Main } from './Main'
import { PromptDialog } from './PromptDialog'
import { ToastProvider } from './toast'
import { UnlockScreen } from './UnlockScreen'

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const refresh = useCallback(() => {
    void api.vault.status().then(setStatus)
  }, [])
  useEffect(refresh, [refresh])

  if (status === null) return null
  if (status !== 'unlocked') return <UnlockScreen status={status} onDone={refresh} />

  const lock = async () => {
    await api.vault.lock()
    refresh()
  }
  return (
    <ToastProvider>
      <DataProvider>
        <Main onLock={lock} />
        <PromptDialog />
      </DataProvider>
    </ToastProvider>
  )
}
```

- [ ] **Step 9: Add the dev SSH server**

`scripts/dev-ssh-server.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestServer } from '../tests/helpers/sshServer'

// A local echo SSH server with SFTP for clicking through the app. Not a real shell.
// A new host key is generated on every start, so reconnecting after a restart shows the "host key changed" warning.
async function main() {
  const root = mkdtempSync(join(tmpdir(), 'burrow-dev-sftp-'))
  writeFileSync(join(root, 'hello.txt'), 'hello from the dev server\n')
  mkdirSync(join(root, 'docs'))
  const server = await startTestServer({ user: 'dev', password: 'dev', sftpRoot: root, port: 2222 })
  console.log(`Dev SSH server on 127.0.0.1:${server.port} (user "dev", password "dev")`)
  console.log(`SFTP root: ${root}`)
}

void main()
```

In `package.json` `scripts`, add:
```json
"dev:server": "tsx scripts/dev-ssh-server.ts"
```

- [ ] **Step 10: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, all tests pass, build succeeds.

Run `npm run dev:server` and `npm run dev` (both in the background) and check:
- Add a host `127.0.0.1`, port `2222`, user `dev`, no password. Double-click it: a tab opens with a yellow dot, a password prompt appears, then the "Trust 127.0.0.1:2222?" dialog with a `SHA256:` fingerprint. After trusting, the dot turns green and `welcome` / `$ ` appear; typing echoes.
- Cmd+D (macOS) opens a second pane to the right that connects without a host key prompt. Cmd+Shift+D splits down. Dragging a divider resizes panes and the terminals refit. Cmd+W closes the focused pane; closing the last pane closes the tab.
- Stop `dev:server`: panes show "Connection closed" (or similar) with Reconnect; the tab dot turns red. Restart `dev:server` and press Reconnect: the red "Host key changed" dialog appears with Cancel focused.
- Switching tabs and back keeps terminal contents. Changing the font size in Settings updates open terminals.
- Lock vault closes all tabs and returns to the unlock screen.

Stop both processes afterwards.

- [ ] **Step 11: Commit**

```bash
git add src/renderer scripts package.json tests/layout.test.ts
git commit -m "Add session tabs with split terminal panes"
```

---

### Task 12: Snippets drawer and SFTP browser

**Files:**
- Create: `src/renderer/src/session/SnippetsDrawer.tsx`, `src/renderer/src/session/SftpBrowser.tsx`
- Modify: `src/renderer/src/session/SessionTab.tsx` (toolbar toggles and side panels; full file below)

**Interfaces:**
- Consumes: `api.sftp.*` from Task 8, `TextPrompt`, `useAction`, `useToast`, `formatSize`, icons from Task 9, `TerminalHost` and `useHostStatus` from Task 11.
- Produces: `SnippetsDrawer({ onSend(command: string) })`, `SftpBrowser({ sessionId: string | null })`.

- [ ] **Step 1: Create the snippets drawer**

`src/renderer/src/session/SnippetsDrawer.tsx`:
```tsx
import { useState } from 'react'
import { useData } from '../data'

export function SnippetsDrawer({ onSend }: { onSend: (command: string) => void }) {
  const { snippets } = useData()
  const [query, setQuery] = useState('')
  const q = query.toLowerCase()
  const list = snippets.filter((s) => `${s.name} ${s.command}`.toLowerCase().includes(q))

  return (
    <aside className="drawer">
      <header className="drawer-header">Snippets</header>
      <input className="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="drawer-list">
        {list.map((s) => (
          <button key={s.id} className="snippet-item" title={s.command} onClick={() => onSend(s.command)}>
            <div className="list-title">{s.name}</div>
            <div className="list-sub mono">{s.command}</div>
          </button>
        ))}
        {snippets.length === 0 && <p className="muted pad">No snippets yet. Add some in the Snippets section.</p>}
      </div>
    </aside>
  )
}
```

- [ ] **Step 2: Create the SFTP browser**

`src/renderer/src/session/SftpBrowser.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react'
import type { RemoteEntry } from '../../../shared/types'
import { api } from '../api'
import { TextPrompt } from '../components/TextPrompt'
import { FileIcon, FolderIcon, RefreshIcon, UpIcon } from '../icons'
import { useAction, useToast } from '../toast'
import { formatSize } from '../util'

const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
const parentOf = (dir: string) => dir.replace(/\/[^/]+\/?$/, '') || '/'

type Dialog = { kind: 'mkdir' } | { kind: 'rename'; entry: RemoteEntry } | null

export function SftpBrowser({ sessionId }: { sessionId: string | null }) {
  const run = useAction()
  const toast = useToast()
  const [path, setPath] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dragOver, setDragOver] = useState(false)

  const load = useCallback(
    (dir: string) =>
      run(async () => {
        if (!sessionId) return
        setEntries(await api.sftp.list(sessionId, dir))
        setPath(dir)
        setSelected(null)
      }),
    [run, sessionId]
  )

  useEffect(() => {
    setPath(null)
    setEntries([])
    if (sessionId) void run(async () => load(await api.sftp.home(sessionId)))
  }, [sessionId, run, load])

  if (!sessionId) {
    return (
      <aside className="sftp">
        <p className="sftp-empty muted">SFTP is available once the first pane is connected.</p>
      </aside>
    )
  }

  const sel = entries.find((e) => e.name === selected) ?? null
  // Runs a change, shows errors as a toast, then reloads the listing either way.
  const op = async (fn: () => Promise<unknown>, success?: string) => {
    await run(fn, success)
    if (path) await load(path)
  }

  const upload = () =>
    path &&
    op(async () => {
      const n = await api.sftp.uploadDialog(sessionId, path)
      if (n) toast(`Uploaded ${n} file${n === 1 ? '' : 's'}`)
    })
  const download = () =>
    path &&
    sel &&
    run(async () => {
      if (await api.sftp.download(sessionId, join(path, sel.name))) toast(`Downloaded ${sel.name}`)
    })
  const remove = () => {
    if (path && sel && confirm(`Delete ${sel.name}?`)) void op(() => api.sftp.remove(sessionId, join(path, sel.name), sel.isDir))
  }
  const drop = (files: FileList) => {
    const paths = [...files].map((f) => api.sftp.pathForFile(f)).filter(Boolean)
    if (path && paths.length) {
      void op(() => api.sftp.uploadPaths(sessionId, path, paths), `Uploaded ${paths.length} file${paths.length === 1 ? '' : 's'}`)
    }
  }
  const submitDialog = (name: string) => {
    const d = dialog
    setDialog(null)
    if (!path || !d) return
    if (d.kind === 'mkdir') void op(() => api.sftp.mkdir(sessionId, join(path, name)))
    else void op(() => api.sftp.rename(sessionId, join(path, d.entry.name), join(path, name)))
  }

  return (
    <aside
      className={`sftp ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        drop(e.dataTransfer.files)
      }}
    >
      <header className="sftp-header">
        <button className="icon-btn" title="Parent folder" disabled={!path || path === '/'} onClick={() => path && load(parentOf(path))}>
          <UpIcon />
        </button>
        <div className="sftp-path mono" title={path ?? ''}>
          {path ?? '…'}
        </div>
        <button className="icon-btn" title="Refresh" onClick={() => path && load(path)}>
          <RefreshIcon />
        </button>
      </header>
      <div className="sftp-actions">
        <button onClick={upload}>Upload</button>
        <button disabled={!sel || sel.isDir} onClick={download}>
          Download
        </button>
        <button onClick={() => setDialog({ kind: 'mkdir' })}>New folder</button>
        <button disabled={!sel} onClick={() => sel && setDialog({ kind: 'rename', entry: sel })}>
          Rename
        </button>
        <button className="danger ghost" disabled={!sel} onClick={remove}>
          Delete
        </button>
      </div>
      <div className="sftp-list">
        {entries.map((e) => (
          <div
            key={e.name}
            className={`sftp-row ${selected === e.name ? 'selected' : ''}`}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => e.isDir && path && load(join(path, e.name))}
          >
            <span className="sftp-icon">{e.isDir ? <FolderIcon /> : <FileIcon />}</span>
            <span className="sftp-name">{e.name}</span>
            <span className="sftp-size muted">{e.isDir ? '' : formatSize(e.size)}</span>
          </div>
        ))}
      </div>
      <div className="sftp-hint muted">Drop files here to upload</div>
      {dialog && (
        <TextPrompt
          title={dialog.kind === 'mkdir' ? 'New folder' : `Rename ${dialog.entry.name}`}
          initial={dialog.kind === 'rename' ? dialog.entry.name : ''}
          confirmLabel={dialog.kind === 'mkdir' ? 'Create' : 'Rename'}
          onSubmit={submitDialog}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  )
}
```

- [ ] **Step 3: Replace SessionTab with the version that has drawers**

`src/renderer/src/session/SessionTab.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useData } from '../data'
import { CodeIcon, FolderIcon, SplitDownIcon, SplitRightIcon } from '../icons'
import { pane, paneIds, removePane, resizeSplit, splitPane, type PaneNode } from './layout'
import { PaneSlot } from './PaneSlot'
import { SftpBrowser } from './SftpBrowser'
import { matchShortcut, SHORTCUT_LABELS, type ShortcutAction } from './shortcuts'
import { SnippetsDrawer } from './SnippetsDrawer'
import { SplitView } from './SplitView'
import { TerminalHost, useHostStatus } from './terminalHost'

export type TabStatus = 'connecting' | 'connected' | 'closed'

interface Props {
  profileId: string
  active: boolean
  onStatus: (status: TabStatus) => void
  onEmpty: () => void
}

export function SessionTab({ profileId, active, onStatus, onEmpty }: Props) {
  const { settings, profiles } = useData()
  const profile = profiles.find((p) => p.id === profileId)
  const hosts = useRef(new Map<string, TerminalHost>())
  const [initialId] = useState(() => crypto.randomUUID())
  const [layout, setLayout] = useState<PaneNode>(() => pane(initialId))
  const [focused, setFocused] = useState(initialId)
  const [showSnippets, setShowSnippets] = useState(false)
  const [showSftp, setShowSftp] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const getHost = useCallback(
    (paneId: string) => {
      let host = hosts.current.get(paneId)
      if (!host) {
        host = new TerminalHost(profileId, settingsRef.current)
        host.onFocus = () => setFocused(paneId)
        hosts.current.set(paneId, host)
      }
      return host
    },
    [profileId]
  )

  const closePane = useCallback(
    (paneId: string) => {
      hosts.current.get(paneId)?.dispose()
      hosts.current.delete(paneId)
      const next = removePane(layout, paneId)
      if (!next) return onEmpty()
      setLayout(next)
      setFocused((f) => (f === paneId ? paneIds(next)[0] : f))
    },
    [layout, onEmpty]
  )

  const act = useCallback(
    (action: ShortcutAction) => {
      if (action === 'closePane') return closePane(focused)
      const id = crypto.randomUUID()
      setLayout((l) => splitPane(l, focused, action === 'splitRight' ? 'row' : 'col', id))
      setFocused(id)
    },
    [closePane, focused]
  )

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e)
      if (!action) return
      e.preventDefault()
      act(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, act])

  useEffect(() => {
    if (active) hosts.current.get(focused)?.focus()
  }, [active, focused])

  useEffect(() => {
    hosts.current.forEach((h) => h.applySettings(settings))
  }, [settings])

  useEffect(() => {
    const map = hosts.current
    return () => {
      map.forEach((h) => h.dispose())
      map.clear()
    }
  }, [])

  useEffect(() => {
    const list = paneIds(layout).map(getHost)
    const update = () => {
      const states = list.map((h) => h.status.state)
      onStatusRef.current(states.includes('connected') ? 'connected' : states.includes('connecting') ? 'connecting' : 'closed')
    }
    update()
    const subs = list.map((h) => h.subscribe(update))
    return () => subs.forEach((u) => u())
  }, [layout, getHost])

  // SFTP runs over the connection of the first pane in the layout.
  const firstHost = getHost(paneIds(layout)[0])
  const firstStatus = useHostStatus(firstHost)
  const sftpSession = firstStatus.state === 'connected' ? firstHost.sessionId : null

  const sendSnippet = (command: string) => {
    const host = hosts.current.get(focused)
    host?.send(command.replace(/\r?\n/g, '\r') + '\r')
    host?.focus()
  }

  return (
    <div className="session">
      <div className="session-toolbar">
        <span className="session-title">{profile?.name ?? 'Deleted host'}</span>
        {profile && (
          <span className="muted">
            {profile.user}@{profile.host}
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn" title={`Split right (${SHORTCUT_LABELS.splitRight})`} onClick={() => act('splitRight')}>
          <SplitRightIcon />
        </button>
        <button className="icon-btn" title={`Split down (${SHORTCUT_LABELS.splitDown})`} onClick={() => act('splitDown')}>
          <SplitDownIcon />
        </button>
        <button className={`toggle ${showSnippets ? 'on' : ''}`} onClick={() => setShowSnippets((s) => !s)}>
          <CodeIcon /> Snippets
        </button>
        <button className={`toggle ${showSftp ? 'on' : ''}`} onClick={() => setShowSftp((s) => !s)}>
          <FolderIcon /> SFTP
        </button>
      </div>
      <div className="session-body">
        <div className="session-terminals">
          <SplitView
            node={layout}
            onResize={(id, sizes) => setLayout((l) => resizeSplit(l, id, sizes))}
            renderPane={(id) => <PaneSlot key={id} host={getHost(id)} focused={id === focused} onClose={() => closePane(id)} />}
          />
        </div>
        {showSftp && <SftpBrowser sessionId={sftpSession} />}
        {showSnippets && <SnippetsDrawer onSend={sendSnippet} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors, all tests pass, build succeeds.

Run `npm run dev:server` and `npm run dev` and check:
- Create a snippet `echo hello`. In a session, open Snippets and click it: `echo hello` followed by a new `$ ` prompt appears in the focused pane, and focus returns to the terminal. With two panes, it goes to the one with the highlighted border.
- Open SFTP: it lists `docs` then `hello.txt` at `/`. Double-click `docs` enters it; the up arrow goes back.
- Upload via the button and by dragging a file from Finder onto the panel; the file appears in the SFTP root folder printed by `dev:server`.
- Download `hello.txt` via the save dialog; the file has the expected content.
- New folder, Rename, Delete work and the listing reloads. Deleting a non-empty folder shows an error toast and the listing reloads.
- Stopping `dev:server` switches SFTP to "available once the first pane is connected".

Stop both processes afterwards.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/session
git commit -m "Add snippets drawer and SFTP browser"
```

---

### Task 13: Packaging and README

**Files:**
- Modify: `package.json` (scripts and `build` config)
- Create: `README.md`

**Interfaces:**
- Produces: `npm run build:mac` → `dist/*.dmg`; `npm run build:linux` → `dist/*.rpm` and `dist/*.AppImage`.

- [ ] **Step 1: Add build scripts and electron-builder config**

In `package.json`, add to `scripts`:
```json
"build:mac": "electron-vite build && electron-builder --mac",
"build:linux": "electron-vite build && electron-builder --linux"
```

Add a top-level `build` key:
```json
"build": {
  "appId": "dev.burrow.client",
  "productName": "Burrow Client",
  "directories": { "output": "dist" },
  "files": ["out/**/*"],
  "npmRebuild": false,
  "mac": {
    "target": ["dmg"],
    "category": "public.app-category.developer-tools",
    "identity": null
  },
  "linux": {
    "target": ["rpm", "AppImage"],
    "category": "Network",
    "maintainer": "Burrow Client"
  }
}
```
`npmRebuild: false` because ssh2's optional native modules are not needed; ssh2 falls back to pure JavaScript. `identity: null` skips macOS code signing. `dist/` is already in `.gitignore` from Task 1.

- [ ] **Step 2: Write the README**

`README.md`:
````markdown
# Burrow Client

A local-first SSH client for macOS and Linux. No accounts, no sync, nothing leaves your machine.

- Tabbed sessions with split panes
- Host profiles with groups and search
- Snippets you can send to any terminal
- Key management: generate Ed25519/RSA keys, import existing ones
- SFTP browser with drag and drop upload
- Known-hosts checks with a warning when a server key changes
- Passwords and private keys live in an encrypted vault (scrypt + AES-256-GCM) behind a master password

## Development

```bash
npm install
npm run dev          # start the app with hot reload
npm run dev:server   # local echo SSH + SFTP server on 127.0.0.1:2222 (user dev / password dev)
npm test             # unit and integration tests
npm run typecheck
```

## Building

macOS (unsigned `.dmg` in `dist/`):

```bash
npm run build:mac
```

The app is not signed. On first launch, right-click it in Finder and choose Open.

Fedora (`.rpm` and AppImage in `dist/`), run on the Fedora machine:

```bash
sudo dnf install rpm-build
npm install
npm run build:linux
```

## Where data is stored

- macOS: `~/Library/Application Support/Burrow Client/`
- Linux: `~/.config/Burrow Client/`

`profiles.json`, `snippets.json`, `keys.json` (public keys only), `known_hosts.json` and `settings.json` are plain JSON you can read and back up. `vault.enc` holds passwords, private keys and passphrases, encrypted with your master password. A forgotten master password cannot be recovered.

## Keyboard shortcuts

| Action | macOS | Linux |
|---|---|---|
| Split right | Cmd+D | Ctrl+Shift+D |
| Split down | Cmd+Shift+D | Ctrl+Shift+E |
| Close pane | Cmd+W | Ctrl+Shift+W |
| Copy / paste in terminal | Cmd+C / Cmd+V | Ctrl+Shift+C / Ctrl+Shift+V |
````

- [ ] **Step 3: Build the macOS package**

Run: `npm run build:mac && ls dist`
Expected: a `Burrow Client-0.1.0-arm64.dmg` (or `-x64` on Intel) in `dist/`. Warnings about the missing icon and signing are expected.

- [ ] **Step 4: Smoke test the packaged app**

Open the `.dmg`, drag the app out to a temporary folder (or run `open "dist/mac-arm64/Burrow Client.app"`), and check that it starts, shows the unlock screen, and can connect to `npm run dev:server`.
Expected: same behavior as in dev. If it fails with "Cannot find module 'ssh2'", check that `ssh2` is in `dependencies` (not `devDependencies`).

- [ ] **Step 5: Final full check**

Run: `npm run typecheck && npm test`
Expected: no type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md
git commit -m "Add packaging config and README"
```
