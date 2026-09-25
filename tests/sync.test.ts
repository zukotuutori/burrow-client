import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core } from '../src/main/core'
import { mergeById, mergeRecord, mergeState, emptyState } from '../src/main/sync/merge'
import { decryptBlob, deriveSyncKeys, encryptBlob } from '../src/main/sync/syncCrypto'
import { DEFAULT_SETTINGS } from '../src/main/validate'
import type { Profile } from '../src/shared/types'

const FAST = { N: 1024, r: 8, p: 1 }
const PASSWORD = 'Correct-Horse-9'
const CODE = 'invite-123'

const profile = (id: string, extra: Partial<Profile> = {}): Profile => ({
  id,
  name: `Host ${id}`,
  group: '',
  host: '10.0.0.1',
  port: 22,
  user: 'alice',
  authType: 'password',
  ...extra
})

describe('merge', () => {
  it('keeps the newer version and local wins a tie', () => {
    expect(mergeById([{ id: 'a', v: 1, updatedAt: 1 }], [{ id: 'a', v: 2, updatedAt: 2 }])).toEqual([{ id: 'a', v: 2, updatedAt: 2 }])
    expect(mergeById([{ id: 'a', v: 'L', updatedAt: 5 }], [{ id: 'a', v: 'R', updatedAt: 5 }])[0].v).toBe('L')
  })

  it('a newer tombstone beats an older edit, and items from both sides are kept', () => {
    const merged = mergeById(
      [{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }],
      [{ id: 'a', updatedAt: 2, deleted: true }, { id: 'c', updatedAt: 1 }]
    )
    expect(merged.find((x) => x.id === 'a')?.deleted).toBe(true)
    expect(merged.map((x) => x.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('merges records by key without changing the inputs', () => {
    const local = { 'h:22': { fp: 'old', updatedAt: 1 }, 'x:22': { fp: 'x', updatedAt: 1 } }
    const remote = { 'h:22': { fp: 'new', updatedAt: 2 }, 'y:22': { fp: 'y', updatedAt: 1 } }
    const before = structuredClone({ local, remote })
    expect(mergeRecord(local, remote)).toEqual({ 'h:22': remote['h:22'], 'x:22': local['x:22'], 'y:22': remote['y:22'] })
    expect({ local, remote }).toEqual(before)
  })

  it('is idempotent', () => {
    const a = { ...emptyState(DEFAULT_SETTINGS), profiles: [{ ...profile('a'), updatedAt: 1 }] }
    const b = { ...emptyState(DEFAULT_SETTINGS), profiles: [{ ...profile('a'), name: 'B', updatedAt: 2 }] }
    expect(mergeState(mergeState(a, b), b)).toEqual(mergeState(a, b))
  })
})

describe('sync crypto', () => {
  it('encrypts and decrypts, and rejects a wrong key or changed data', () => {
    const key = randomBytes(32)
    const blob = encryptBlob({ hello: 'world' }, key)
    expect(decryptBlob(blob, key)).toEqual({ hello: 'world' })
    expect(() => decryptBlob(blob, randomBytes(32))).toThrow(/could not be decrypted/)
    const data = Buffer.from(blob.data, 'base64')
    data[0] ^= 1
    expect(() => decryptBlob({ ...blob, data: data.toString('base64') }, key)).toThrow(/could not be decrypted/)
    expect(encryptBlob({ hello: 'world' }, key).data).not.toBe(blob.data)
  })

  it('derives the same keys for the same user name in any case, with separate auth and encryption keys', async () => {
    const a = await deriveSyncKeys('Ben', 'pw', FAST)
    const b = await deriveSyncKeys(' ben ', 'pw', FAST)
    const c = await deriveSyncKeys('ben', 'other', FAST)
    expect(a.authKey.equals(b.authKey) && a.encKey.equals(b.encKey)).toBe(true)
    expect(a.authKey.equals(a.encKey)).toBe(false)
    expect(a.authKey.equals(c.authKey)).toBe(false)
  })
})

// ---------- Two devices against the real server ----------

let serverProc: ChildProcess
let serverUrl: string
let serverDir: string

beforeAll(async () => {
  serverDir = await mkdtemp(join(tmpdir(), 'burrow-sync-server-'))
  serverProc = spawn(process.execPath, ['--no-warnings', join(__dirname, '../server/server.js')], {
    env: { ...process.env, PORT: '0', DB_PATH: join(serverDir, 'sync.db'), REGISTRATION_CODE: CODE },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    serverProc.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = /listening on port (\d+)/.exec(out)
      if (m) resolve(Number(m[1]))
    })
    serverProc.on('exit', (code) => reject(new Error(`server exited with ${code}`)))
  })
  serverUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  serverProc?.kill()
  await rm(serverDir, { recursive: true, force: true })
})

describe('sync between two devices', () => {
  let dirs: string[] = []
  let a: Core
  let b: Core
  let user: string

  const device = async (): Promise<Core> => {
    const dir = await mkdtemp(join(tmpdir(), 'burrow-sync-device-'))
    dirs.push(dir)
    const core = new Core(dir, () => undefined, FAST, FAST)
    await core.init()
    await core.vault.create('master')
    return core
  }

  beforeEach(async () => {
    a = await device()
    b = await device()
    user = `user${randomBytes(4).toString('hex')}`
  })

  afterEach(async () => {
    a.lock()
    b.lock()
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
    dirs = []
  })

  it('moves hosts with passwords, keys, snippets, known hosts and settings to the other device', async () => {
    await a.saveProfile(profile('p1'), 'secret-pw')
    const key = await a.generateKey('laptop', 'ed25519')
    await a.saveProfile(profile('p2', { authType: 'key', keyId: key.id }))
    await a.saveSnippet({ id: 's1', name: 'uptime', command: 'uptime' })
    await a.knownHosts.set({ '10.0.0.1:22': { algo: 'ssh-ed25519', fingerprint: 'SHA256:x', addedAt: 'now', updatedAt: 1 } })
    await a.saveSettings({ ...a.getSettings(), fontSize: 17 })

    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await b.sync.login(serverUrl, user, PASSWORD)

    expect(b.profiles.list().map((p) => p.id).sort()).toEqual(['p1', 'p2'])
    expect(b.vault.getPassword('p1')).toBe('secret-pw')
    expect(b.vault.getKey(key.id)?.privateKey).toBe(a.vault.getKey(key.id)?.privateKey)
    expect(b.snippets.list().map((s) => s.name)).toEqual(['uptime'])
    expect(b.listKnownHosts()['10.0.0.1:22']?.fingerprint).toBe('SHA256:x')
    expect(b.getSettings().fontSize).toBe(17)
  })

  it('merges data that exists on both devices and carries deletes over', async () => {
    await a.saveProfile(profile('a1'))
    await b.saveProfile(profile('b1'))
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await b.sync.login(serverUrl, user, PASSWORD)
    await a.sync.syncNow()
    expect(a.profiles.list().map((p) => p.id).sort()).toEqual(['a1', 'b1'])

    await b.deleteProfile('a1')
    await b.sync.syncNow()
    await a.sync.syncNow()
    expect(a.profiles.list().map((p) => p.id)).toEqual(['b1'])
  })

  it('loses nothing when both devices upload at the same time', async () => {
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await b.sync.login(serverUrl, user, PASSWORD)
    await a.saveProfile(profile('fromA'))
    await b.saveProfile(profile('fromB'))
    await Promise.all([a.sync.syncNow(), b.sync.syncNow()])
    await Promise.all([a.sync.syncNow(), b.sync.syncNow()])
    expect(a.profiles.list().map((p) => p.id).sort()).toEqual(['fromA', 'fromB'])
    expect(b.profiles.list().map((p) => p.id).sort()).toEqual(['fromA', 'fromB'])
  })

  it('does not upload when nothing changed', async () => {
    await a.saveProfile(profile('p1'))
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    const version = a.sync.config.value.version
    await a.sync.syncNow()
    expect(a.sync.config.value.version).toBe(version)
  })

  it('rejects a wrong password, a wrong invite code and plain http to other hosts', async () => {
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await expect(b.sync.login(serverUrl, user, 'Wrong-Horse-99')).rejects.toThrow(/Wrong user name or password/)
    await expect(b.sync.register(serverUrl, 'someone', PASSWORD, 'nope')).rejects.toThrow(/Wrong invite code/)
    await expect(b.sync.login('http://sync.example.com', user, PASSWORD)).rejects.toThrow(/https/)
    expect(b.sync.status().loggedIn).toBe(false)
  })

  it('after a password change the old device is logged out and can log in with the new password', async () => {
    await a.saveProfile(profile('p1'), 'pw1')
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await b.sync.login(serverUrl, user, PASSWORD)
    await a.sync.changePassword(PASSWORD, 'New-Horse-Battery-7')

    await expect(b.sync.syncNow()).rejects.toThrow()
    expect(b.sync.status()).toMatchObject({ loggedIn: false, lastError: expect.stringMatching(/Log in again/) })

    await b.sync.login(serverUrl, user, 'New-Horse-Battery-7')
    expect(b.vault.getPassword('p1')).toBe('pw1')
  })

  it('deletes the account on the server but keeps local data', async () => {
    await a.saveProfile(profile('p1'))
    await a.sync.register(serverUrl, user, PASSWORD, CODE)
    await a.sync.deleteAccount(PASSWORD)
    expect(a.sync.status().loggedIn).toBe(false)
    expect(a.profiles.list()).toHaveLength(1)
    await expect(b.sync.login(serverUrl, user, PASSWORD)).rejects.toThrow(/Wrong user name or password/)
  })
})
