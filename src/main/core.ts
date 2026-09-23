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
  Snippet,
  SnippetExport,
  SnippetImportResult
} from '../shared/types'
import { masterPasswordProblems, PASSWORD_RULE_TEXT } from '../shared/passwordPolicy'
import { generateKey, importKey, isEncrypted, type KeyMaterial } from './keys/keys'
import { checkHostKey, hostId } from './ssh/hostkeys'
import { SshSession } from './ssh/session'
import { SftpClient } from './ssh/sftp'
import { CorruptFileError } from './store/jsonFile'
import { JsonDoc } from './store/jsonDoc'
import { Repo } from './store/repo'
import { DEFAULT_SETTINGS, validateProfile, validateSettings, validateSnippet, validateSnippetExport } from './validate'
import { DEFAULT_KDF, WrongPasswordError, type KdfParams } from './vault/crypto'
import { Vault } from './vault/vault'

function assertStrongMasterPassword(password: string): void {
  const problems = masterPasswordProblems(password)
  if (problems.length) {
    throw new Error(`Master password needs: ${problems.map((p) => PASSWORD_RULE_TEXT[p].toLowerCase()).join(', ')}`)
  }
}

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
  /** Bumped on every lock, so a connect that started before the lock can tell. */
  private lockGeneration = 0

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
    if (!doc.isBroken) throw new Error(`${file} can be read, so it cannot be reset`)
    await doc.reset()
    this.loadErrors = this.loadErrors.filter((e) => e.file !== file)
  }

  /** Creates a new vault; the master password must meet the password policy. */
  async createVault(password: string): Promise<void> {
    assertStrongMasterPassword(password)
    await this.vault.create(password)
  }

  /** Re-encrypts the vault under a new master password; the new one must meet the password policy. */
  async changeMasterPassword(current: string, next: string): Promise<void> {
    assertStrongMasterPassword(next)
    try {
      await this.vault.changePassword(current, next)
    } catch (e) {
      if (e instanceof WrongPasswordError) throw new Error('The current password is wrong')
      throw e
    }
  }

  /** Backs up and removes vault.enc. Only allowed when the file cannot be read, so a healthy vault is never wiped. */
  async resetVault(): Promise<void> {
    if ((await this.vault.fileStatus()) !== 'broken') throw new Error('The vault can only be reset when it cannot be read')
    this.lock()
    await this.vault.reset()
  }

  lock(): void {
    this.lockGeneration++
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
    // Snippets left without any host become global again instead of disappearing.
    if (!this.snippets.list().some((s) => s.profileIds?.includes(id))) return
    const snippets = this.snippets.list().map((s) => {
      if (!s.profileIds?.includes(id)) return s
      const { profileIds, ...rest } = s
      const remaining = profileIds.filter((p) => p !== id)
      return remaining.length ? { ...rest, profileIds: remaining } : rest
    })
    await this.snippets.doc.set(snippets)
  }

  hasPassword(id: string): boolean {
    return this.vault.getPassword(id) !== undefined
  }

  async forgetPassword(id: string): Promise<void> {
    await this.vault.setPassword(id, undefined)
  }

  // Snippets and settings

  async saveSnippet(input: unknown): Promise<void> {
    const s = validateSnippet(input)
    if (s.profileIds?.some((id) => !this.profiles.get(id))) throw new Error('Host not found')
    await this.snippets.upsert(s)
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.snippets.remove(id)
  }

  /** All snippets without ids; host links are written as host labels so they can be matched on another machine. */
  exportSnippets(): SnippetExport {
    return {
      format: 'burrow-snippets',
      version: 1,
      snippets: this.snippets.list().map((s) => {
        const hosts = (s.profileIds ?? []).map((id) => this.profiles.get(id)?.name).filter((n): n is string => !!n)
        return {
          name: s.name,
          command: s.command,
          ...(s.tags?.length ? { tags: s.tags } : {}),
          ...(hosts.length ? { hosts } : {})
        }
      })
    }
  }

  /**
   * Adds the snippets from an export file. Hosts are matched by label (case-insensitive); snippets whose hosts
   * are all unknown here become global. Snippets with the same name and command as an existing one are skipped.
   */
  async importSnippets(data: unknown): Promise<SnippetImportResult> {
    const entries = validateSnippetExport(data)
    const key = (name: string, command: string) => JSON.stringify([name.trim(), command])
    const seen = new Set(this.snippets.list().map((s) => key(s.name, s.command)))
    const byLabel = (label: string) =>
      this.profiles.list().filter((p) => p.name.toLowerCase() === label.toLowerCase()).map((p) => p.id)
    const added: Snippet[] = []
    let skipped = 0
    for (const e of entries) {
      const k = key(e.name, e.command)
      if (seen.has(k)) {
        skipped++
        continue
      }
      seen.add(k)
      const profileIds = [...new Set((e.hosts ?? []).flatMap(byLabel))]
      added.push(validateSnippet({ id: randomUUID(), name: e.name, command: e.command, tags: e.tags, profileIds }))
    }
    if (added.length) await this.snippets.doc.set([...this.snippets.list(), ...added])
    return { imported: added.length, skipped }
  }

  /** Settings with defaults filled in for fields added after the file was written. */
  getSettings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.settings.value }
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
    const generation = this.lockGeneration

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

    let registered = false
    const session = await SshSession.open(
      {
        host: p.host,
        port: p.port,
        username: p.user,
        ...auth,
        cols,
        rows,
        verifyHostKey: async (algo, fingerprint, signal) => {
          const check = checkHostKey(this.knownHosts.value, p.host, p.port, algo, fingerprint)
          if (check.state === 'match') return true
          const ans = await ask({ kind: 'hostkey', host: p.host, port: p.port, check })
          if (!ans.ok || signal.aborted) return false
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
          if (!registered) return
          this.sessions.delete(sessionId)
          this.sftps.delete(sessionId)
          this.emit('session:closed', sessionId, reason ?? 'Connection closed')
        }
      }
    )
    if (!this.vault.isUnlocked || generation !== this.lockGeneration) {
      session.close()
      throw new Error('Cancelled')
    }
    this.sessions.set(sessionId, session)
    registered = true
    try {
      await persist?.()
    } catch (e) {
      session.close()
      throw e
    }
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
