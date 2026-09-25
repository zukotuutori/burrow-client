import { timingSafeEqual } from 'node:crypto'
import { masterPasswordProblems, PASSWORD_RULE_TEXT } from '../../shared/passwordPolicy'
import type { Settings, SyncStatus } from '../../shared/types'
import { JsonDoc } from '../store/jsonDoc'
import type { KdfParams } from '../vault/crypto'
import type { SyncKeys, Vault } from '../vault/vault'
import { emptyState, isSyncState } from './merge'
import {
  decryptBlob,
  deriveSyncKeys,
  encryptBlob,
  normalizeUsername,
  SYNC_KDF,
  USERNAME_RULE,
  type SealedBlob
} from './syncCrypto'
import type { SyncConfig, SyncState } from './types'

/** What the sync service needs from Core. */
export interface SyncHost {
  readonly vault: Vault
  exportSyncState(): SyncState
  applySyncState(state: SyncState): Promise<void>
  getSettings(): Settings
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

const REQUEST_TIMEOUT_MS = 15_000
const SCHEDULE_DELAY_MS = 3_000

function assertStrongAccountPassword(password: string): void {
  const problems = masterPasswordProblems(password)
  if (problems.length) {
    throw new Error(`Account password needs: ${problems.map((p) => PASSWORD_RULE_TEXT[p].toLowerCase()).join(', ')}`)
  }
}

/** Only https, except plain http to this machine for development. Returns the origin to store. */
export function checkServerUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    throw new Error('The server address is not a valid URL, e.g. https://sync.example.com')
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('The sync server must use https://')
  if (u.username || u.password) throw new Error('The server address must not contain a user name or password')
  return u.origin
}

function checkUsername(input: string): string {
  const username = normalizeUsername(input)
  if (!USERNAME_RULE.test(username)) throw new Error('User name: 3 to 32 characters from a-z, 0-9, dot, underscore and dash')
  return username
}

/** JSON with sorted object keys and lists sorted by id, so equal content gives equal text. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) => {
    if (Array.isArray(value)) {
      return [...value].sort((a, b) => String((a as { id?: unknown })?.id).localeCompare(String((b as { id?: unknown })?.id)))
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    }
    return value
  })
}

export class SyncService {
  readonly config: JsonDoc<SyncConfig>
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private again = false

  constructor(
    private readonly host: SyncHost,
    configFile: string,
    /** Tells the window that local data or the sync status changed. */
    private readonly onChanged: () => void,
    private readonly kdf: KdfParams = SYNC_KDF
  ) {
    this.config = new JsonDoc<SyncConfig>(configFile, {})
  }

  private get keys(): SyncKeys | undefined {
    return this.config.value.serverUrl && this.host.vault.isUnlocked ? this.host.vault.getSyncKeys() : undefined
  }

  get loggedIn(): boolean {
    return !!this.keys
  }

  status(): SyncStatus {
    const { serverUrl, username, lastSyncAt, lastError } = this.config.value
    return { loggedIn: this.loggedIn, serverUrl, username, lastSyncAt, lastError }
  }

  async register(serverUrl: string, username: string, password: string, code: string): Promise<void> {
    const origin = checkServerUrl(serverUrl)
    const name = checkUsername(username)
    assertStrongAccountPassword(password)
    const keys = await deriveSyncKeys(name, password, this.kdf)
    await this.request(
      'POST',
      '/api/register',
      undefined,
      { username: name, authKey: keys.authKey.toString('base64'), code: code.trim() },
      origin
    )
    await this.saveLogin(origin, name, keys)
  }

  async login(serverUrl: string, username: string, password: string): Promise<void> {
    const origin = checkServerUrl(serverUrl)
    const name = checkUsername(username)
    const keys = await deriveSyncKeys(name, password, this.kdf)
    try {
      await this.request('POST', '/api/login', keys.authKey, undefined, origin)
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 401) throw new Error('Wrong user name or password')
      throw e
    }
    await this.saveLogin(origin, name, keys)
  }

  private async saveLogin(serverUrl: string, username: string, keys: SyncKeys): Promise<void> {
    await this.host.vault.setSyncKeys(keys)
    await this.config.set({ serverUrl, username })
    await this.syncNow()
  }

  /** This device stops syncing. Local data stays as it is. */
  async logout(lastError?: string): Promise<void> {
    this.stop()
    if (this.host.vault.isUnlocked) await this.host.vault.setSyncKeys(undefined)
    await this.config.set(lastError ? { lastError } : {})
    this.onChanged()
  }

  /** Call after every local change. A burst of changes becomes one sync a few seconds later. */
  schedule(): void {
    clearTimeout(this.timer)
    if (this.loggedIn) this.timer = setTimeout(() => void this.syncIfLoggedIn(), SCHEDULE_DELAY_MS)
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** For timers and unlock: syncs when logged in and never throws (the error is kept in the status). */
  async syncIfLoggedIn(): Promise<void> {
    if (!this.loggedIn) return
    await this.syncNow().catch(() => undefined)
  }

  /** Runs one sync. If one is already running, runs exactly one more after it. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.syncOnce()
        } while (this.again)
        await this.config.set({ ...this.config.value, lastSyncAt: new Date().toISOString(), lastError: undefined })
        this.onChanged()
      } catch (e) {
        if (e instanceof HttpStatusError && e.status === 401) {
          await this.logout('The account password was changed or the account was deleted. Log in again.')
        } else if (this.config.value.serverUrl) {
          await this.config.set({ ...this.config.value, lastError: (e as Error).message }).catch(() => undefined)
          this.onChanged()
        }
        throw e
      } finally {
        this.running = undefined
      }
    })()
    return this.running
  }

  private async syncOnce(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const keys = this.keys
      if (!keys) throw new Error('Not logged in to a sync server')
      const remote = await this.request<{ version: number; data: SealedBlob | null }>('GET', '/api/blob', keys.authKey)
      let remoteState = emptyState(this.host.getSettings())
      if (remote.data) {
        const decrypted = decryptBlob(remote.data, keys.encKey)
        if (!isSyncState(decrypted)) throw new Error('The synced data has an unknown format. Update Burrow on all devices.')
        remoteState = decrypted
      }

      await this.host.applySyncState(remoteState)
      this.onChanged()

      const merged = this.host.exportSyncState()
      if (remote.data && canonical(merged) === canonical(remoteState)) {
        await this.config.set({ ...this.config.value, version: remote.version })
        return
      }
      try {
        const { version } = await this.request<{ version: number }>('PUT', '/api/blob', keys.authKey, {
          version: remote.version,
          data: encryptBlob(merged, keys.encKey)
        })
        await this.config.set({ ...this.config.value, version })
        return
      } catch (e) {
        // 409: another device uploaded in between. Fetch again and merge its changes too.
        if (e instanceof HttpStatusError && e.status === 409) continue
        throw e
      }
    }
    throw new Error('Sync failed three times in a row because other devices kept uploading. Try again.')
  }

  /** Checks the account password against the keys stored on this device. */
  private async verifyPassword(password: string): Promise<SyncKeys> {
    const stored = this.keys
    const { username } = this.config.value
    if (!stored || !username) throw new Error('Not logged in to a sync server')
    const keys = await deriveSyncKeys(username, password, this.kdf)
    if (!timingSafeEqual(keys.authKey, stored.authKey)) throw new Error('The account password is wrong')
    return keys
  }

  async changePassword(current: string, next: string): Promise<void> {
    const old = await this.verifyPassword(current)
    assertStrongAccountPassword(next)
    const fresh = await deriveSyncKeys(this.config.value.username!, next, this.kdf)
    for (let attempt = 0; attempt < 3; attempt++) {
      // Upload everything first, so the re-encrypted copy is complete.
      await this.syncNow()
      try {
        const { version } = await this.request<{ version: number }>('POST', '/api/password', old.authKey, {
          newAuthKey: fresh.authKey.toString('base64'),
          version: this.config.value.version ?? 0,
          data: encryptBlob(this.host.exportSyncState(), fresh.encKey)
        })
        await this.host.vault.setSyncKeys(fresh)
        await this.config.set({ ...this.config.value, version })
        this.onChanged()
        return
      } catch (e) {
        if (e instanceof HttpStatusError && e.status === 409) continue
        throw e
      }
    }
    throw new Error('Could not change the password because other devices kept uploading. Try again.')
  }

  async deleteAccount(password: string): Promise<void> {
    const keys = await this.verifyPassword(password)
    await this.request('DELETE', '/api/account', keys.authKey)
    await this.logout()
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    authKey?: Buffer,
    body?: unknown,
    serverUrl = this.config.value.serverUrl
  ): Promise<T> {
    if (!serverUrl) throw new Error('No sync server set')
    let res: Response
    try {
      res = await fetch(new URL(path, serverUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(authKey ? { authorization: `Bearer ${authKey.toString('base64')}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new Error(`Could not reach the sync server at ${serverUrl}`)
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new HttpStatusError(res.status, json.error ?? `The sync server answered with status ${res.status}`)
    return json as T
  }
}
