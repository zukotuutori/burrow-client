import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { VaultStatus } from '../../shared/types'
import { backupFile, CorruptFileError, readText, writeFileAtomic } from '../store/jsonFile'
import { DEFAULT_KDF, deriveKey, isVaultFile, open, seal, WrongPasswordError, type KdfParams } from './crypto'

export interface KeySecret {
  privateKey: string
  passphrase?: string
}

interface VaultData {
  version: 1
  passwords: Record<string, string>
  keys: Record<string, KeySecret>
  /** Base64 keys of the sync account. Missing when this device is not logged in. */
  sync?: { authKey: string; encKey: string }
}

export interface SyncKeys {
  authKey: Buffer
  encKey: Buffer
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
    return this.fileStatus()
  }

  /** State of vault.enc on disk, ignoring whether it is unlocked in memory. */
  async fileStatus(): Promise<Exclude<VaultStatus, 'unlocked'>> {
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

  /** Re-encrypts the vault under a new password with a fresh salt. Throws WrongPasswordError if `current` is wrong. */
  async changePassword(current: string, next: string): Promise<void> {
    const prev = this.unlocked
    const check = await deriveKey(current, prev.salt, prev.params)
    // The vault may have been locked (e.g. auto-lock) while scrypt ran; never unlock it again here.
    if (this.state !== prev) throw new VaultLockedError()
    if (!timingSafeEqual(check, prev.key)) throw new WrongPasswordError()
    const salt = randomBytes(16)
    const key = await deriveKey(next, salt, this.params)
    if (this.state !== prev) {
      key.fill(0)
      throw new VaultLockedError()
    }
    this.state = { key, salt, params: this.params, data: prev.data }
    try {
      await this.save()
    } catch (e) {
      // The file still holds the old encryption, so keep using the old key.
      this.state = prev
      key.fill(0)
      throw e
    }
    prev.key.fill(0)
  }

  lock(): void {
    this.state?.key.fill(0)
    this.state = null
  }

  get isUnlocked(): boolean {
    return this.state !== null
  }

  getPassword(profileId: string): string | undefined {
    const { passwords } = this.unlocked.data
    return Object.hasOwn(passwords, profileId) ? passwords[profileId] : undefined
  }

  async setPassword(profileId: string, password: string | undefined): Promise<void> {
    const { passwords } = this.unlocked.data
    if (password === undefined) delete passwords[profileId]
    else passwords[profileId] = password
    await this.save()
  }

  getKey(keyId: string): KeySecret | undefined {
    const { keys } = this.unlocked.data
    return Object.hasOwn(keys, keyId) ? keys[keyId] : undefined
  }

  async setKey(keyId: string, secret: KeySecret | undefined): Promise<void> {
    const { keys } = this.unlocked.data
    if (secret === undefined) delete keys[keyId]
    else keys[keyId] = secret
    await this.save()
  }

  getSyncKeys(): SyncKeys | undefined {
    const s = this.unlocked.data.sync
    return s && { authKey: Buffer.from(s.authKey, 'base64'), encKey: Buffer.from(s.encKey, 'base64') }
  }

  async setSyncKeys(keys: SyncKeys | undefined): Promise<void> {
    const data = this.unlocked.data
    if (keys) data.sync = { authKey: keys.authKey.toString('base64'), encKey: keys.encKey.toString('base64') }
    else delete data.sync
    await this.save()
  }

  /** Replaces every saved password and key secret in one write. Used when applying data from sync. */
  async replaceSecrets(passwords: Record<string, string>, keys: Record<string, KeySecret>): Promise<void> {
    const data = this.unlocked.data
    data.passwords = passwords
    data.keys = keys
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
