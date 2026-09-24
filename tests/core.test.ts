import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
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
  vi.restoreAllMocks()
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

describe('Core vault creation', () => {
  it('rejects a weak master password and accepts a strong one', async () => {
    const fresh = new Core(join(dir, 'fresh'), () => undefined, FAST)
    await fresh.init()
    await expect(fresh.createVault('password1234')).rejects.toThrow(/special character/)
    await expect(fresh.createVault('short-1')).rejects.toThrow(/12 characters/)
    expect(await fresh.vault.status()).toBe('missing')
    await fresh.createVault('Correct-Horse-9')
    expect(await fresh.vault.status()).toBe('unlocked')
  })
})

describe('Core change master password', () => {
  it('re-encrypts the vault under the new password and keeps all secrets', async () => {
    await core.saveProfile(profile(22), 'host-secret')
    await core.changeMasterPassword('master', 'New-Password-77')
    const before = JSON.parse(await readFile(join(dir, 'vault.enc'), 'utf8'))
    core.lock()
    await expect(core.vault.unlock('master')).rejects.toThrow('Wrong password')
    await core.vault.unlock('New-Password-77')
    expect(core.vault.getPassword('p1')).toBe('host-secret')
    expect(before.salt).toBeTruthy()
  })

  it('uses a fresh salt for the new password', async () => {
    const oldSalt = JSON.parse(await readFile(join(dir, 'vault.enc'), 'utf8')).salt
    await core.changeMasterPassword('master', 'New-Password-77')
    expect(JSON.parse(await readFile(join(dir, 'vault.enc'), 'utf8')).salt).not.toBe(oldSalt)
  })

  it('rejects a wrong current password and leaves the vault as it was', async () => {
    await expect(core.changeMasterPassword('nope', 'New-Password-77')).rejects.toThrow('The current password is wrong')
    core.lock()
    await core.vault.unlock('master')
  })

  it('applies the password rules to the new password', async () => {
    await expect(core.changeMasterPassword('master', 'weakpassword')).rejects.toThrow(/Master password needs/)
  })

  it('needs an unlocked vault', async () => {
    core.lock()
    await expect(core.changeMasterPassword('master', 'New-Password-77')).rejects.toThrow('Vault is locked')
  })
})

describe('Core vault reset', () => {
  it('refuses to reset a healthy vault', async () => {
    await expect(core.resetVault()).rejects.toThrow(/only be reset when it cannot be read/)
    expect(core.vault.isUnlocked).toBe(true)
  })

  it('locks and closes sessions before resetting a broken vault', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    await core.connect('s1', 'p1', 80, 24, asker({ hostkey: { ok: true } }).ask)
    await writeFile(join(dir, 'vault.enc'), 'garbage')
    await core.resetVault()
    await waitFor(() => events.some((e) => e[0] === 'session:closed' && e[1] === 's1'))
    expect(await core.vault.status()).toBe('missing')
    expect((await readdir(dir)).some((f) => f.startsWith('vault.enc.broken-'))).toBe(true)
  })
})

describe('Core snippet export and import', () => {
  const entries = (data: unknown) => (data as { snippets: unknown[] }).snippets

  it('exports name, command, tags and host labels, nothing else', async () => {
    await core.saveProfile(profile(22, { name: 'Web server' }))
    await core.saveSnippet({ id: 's1', name: 'logs', command: 'tail -f app.log', tags: ['ops'], profileIds: ['p1'] })
    await core.saveSnippet({ id: 's2', name: 'disk', command: 'df -h' })
    const data = core.exportSnippets()
    expect(data).toEqual({
      format: 'burrow-snippets',
      version: 1,
      snippets: [
        { name: 'logs', command: 'tail -f app.log', tags: ['ops'], hosts: ['Web server'] },
        { name: 'disk', command: 'df -h' }
      ]
    })
    expect(JSON.stringify(data)).not.toMatch(/p1|127\.0\.0\.1|alice/)
  })

  it('imports into another vault, matching hosts by label and making the rest global', async () => {
    const other = new Core(join(dir, 'other'), () => undefined, FAST)
    await other.init()
    await other.createVault('Other-Vault-99')
    await other.saveProfile(profile(22, { id: 'x1', name: 'Web server' }))
    const result = await other.importSnippets({
      format: 'burrow-snippets',
      version: 1,
      snippets: [
        { name: 'logs', command: 'tail -f app.log', tags: ['ops'], hosts: ['Web server'] },
        { name: 'db', command: 'psql', hosts: ['Database'] },
        { name: 'disk', command: 'df -h' }
      ]
    })
    expect(result).toEqual({ imported: 3, skipped: 0 })
    const byName = Object.fromEntries(other.snippets.list().map((s) => [s.name, s]))
    expect(byName.logs).toMatchObject({ command: 'tail -f app.log', tags: ['ops'], profileIds: ['x1'] })
    expect(byName.db.profileIds).toBeUndefined()
    expect(byName.disk.profileIds).toBeUndefined()
    expect(new Set(other.snippets.list().map((s) => s.id)).size).toBe(3)
  })

  it('skips snippets that already exist or repeat within the file', async () => {
    await core.saveSnippet({ id: 's1', name: 'disk', command: 'df -h' })
    const result = await core.importSnippets({
      format: 'burrow-snippets',
      version: 1,
      snippets: [
        { name: 'disk', command: 'df -h' },
        { name: 'up', command: 'uptime' },
        { name: 'up', command: 'uptime' }
      ]
    })
    expect(result).toEqual({ imported: 1, skipped: 2 })
    expect(core.snippets.list().map((s) => s.name)).toEqual(['disk', 'up'])
  })

  it('ignores ids and unknown fields from the file', async () => {
    await core.importSnippets(
      JSON.parse('{"format":"burrow-snippets","version":1,"snippets":[{"id":"constructor","name":"a","command":"b","__proto__":{"x":1},"profileIds":["p1"],"extra":true}]}')
    )
    const [s] = core.snippets.list()
    expect(s.id).not.toBe('constructor')
    expect(Object.keys(s).sort()).toEqual(['command', 'id', 'name'])
  })

  it('rejects broken files as a whole and imports nothing', async () => {
    const bad: unknown[] = [
      null,
      [],
      { format: 'something-else', version: 1, snippets: [] },
      { format: 'burrow-snippets', version: 2, snippets: [] },
      { format: 'burrow-snippets', version: 1, snippets: {} },
      { format: 'burrow-snippets', version: 1, snippets: [{ name: 'ok', command: 'ls' }, { name: 'x', command: '' }] },
      { format: 'burrow-snippets', version: 1, snippets: [{ name: 'x', command: 'y'.repeat(20001) }] },
      { format: 'burrow-snippets', version: 1, snippets: [{ name: 'x', command: 'y', hosts: 'Web' }] },
      { format: 'burrow-snippets', version: 1, snippets: Array.from({ length: 5001 }, (_, i) => ({ name: `n${i}`, command: 'c' })) }
    ]
    for (const data of bad) await expect(core.importSnippets(data)).rejects.toThrow()
    expect(core.snippets.list()).toEqual([])
    expect(entries(core.exportSnippets())).toEqual([])
  })
})

describe('Core file reset', () => {
  it('refuses to reset a file that can be read', async () => {
    await core.saveProfile(profile(22))
    await expect(core.resetFile('profiles.json')).rejects.toThrow(/can be read/)
    expect(core.profiles.list()).toHaveLength(1)
  })
})

describe('Core ids', () => {
  it('rejects ids that clash with built-in object keys or contain odd characters', async () => {
    for (const id of ['constructor', '__proto__', 'toString', 'a/b', 'x'.repeat(65)]) {
      await expect(core.saveProfile(profile(22, { id }))).rejects.toThrow('Invalid host id')
      await expect(core.saveSnippet({ id, name: 'n', command: 'c' })).rejects.toThrow('Invalid snippet id')
    }
  })

  it('never reports built-in object keys as saved passwords or keys', () => {
    expect(core.hasPassword('constructor')).toBe(false)
    expect(core.hasPassword('__proto__')).toBe(false)
    expect(core.vault.getKey('toString')).toBeUndefined()
  })
})

describe('Core host notes and status', () => {
  it('stores a trimmed note and drops an empty one', async () => {
    await core.saveProfile(profile(22, { note: '  rack 4, ask Tom before reboot  ' }))
    expect(core.profiles.get('p1')?.note).toBe('rack 4, ask Tom before reboot')
    await core.saveProfile(profile(22, { note: '   ' }))
    expect(core.profiles.get('p1')).not.toHaveProperty('note')
    await expect(core.saveProfile(profile(22, { note: 'x'.repeat(5001) }))).rejects.toThrow(/Note/)
  })

  it('reports whether a saved host accepts connections', async () => {
    const listener = createServer((s) => s.destroy())
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r))
    const port = (listener.address() as AddressInfo).port
    await core.saveProfile(profile(port))
    expect(await core.isReachable('p1')).toBe(true)
    await new Promise((r) => listener.close(r))
    expect(await core.isReachable('p1')).toBe(false)
    await expect(core.isReachable('nope')).rejects.toThrow(/not found/)
  })
})

describe('Core settings', () => {
  it('fills in the auto-lock default for settings saved before it existed', async () => {
    await core.settings.set({ fontFamily: 'Menlo', fontSize: 13, theme: 'dark' } as never)
    expect(core.getSettings().autoLockMinutes).toBe(15)
  })

  it('keeps host status off for settings saved before it existed', async () => {
    await core.settings.set({ fontFamily: 'Menlo', fontSize: 13, theme: 'dark', autoLockMinutes: 15 } as never)
    expect(core.getSettings().showHostStatus).toBe(false)
  })

  it('validates the host status setting', async () => {
    const base = { fontFamily: 'Menlo', fontSize: 13, theme: 'dark', autoLockMinutes: 15 }
    await core.saveSettings({ ...base, showHostStatus: true })
    expect(core.getSettings().showHostStatus).toBe(true)
    await expect(core.saveSettings({ ...base, showHostStatus: 'yes' })).rejects.toThrow(/host status/)
  })

  it('validates the auto-lock minutes', async () => {
    const base = { fontFamily: 'Menlo', fontSize: 13, theme: 'dark', showHostStatus: false }
    await core.saveSettings({ ...base, autoLockMinutes: 0 })
    expect(core.getSettings().autoLockMinutes).toBe(0)
    await expect(core.saveSettings({ ...base, autoLockMinutes: -1 })).rejects.toThrow(/Auto-lock/)
    await expect(core.saveSettings({ ...base, autoLockMinutes: 1.5 })).rejects.toThrow(/Auto-lock/)
  })
})

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

  it('stores host-specific snippets and rejects unknown hosts', async () => {
    await core.saveProfile(profile(22))
    await core.saveSnippet({ id: 's1', name: 'logs', command: 'tail -f log', profileIds: ['p1', 'p1', ''] })
    expect(core.snippets.get('s1')).toEqual({ id: 's1', name: 'logs', command: 'tail -f log', profileIds: ['p1'] })
    await core.saveSnippet({ id: 's2', name: 'ls', command: 'ls', profileIds: [] })
    expect(core.snippets.get('s2')).toEqual({ id: 's2', name: 'ls', command: 'ls' })
    await expect(core.saveSnippet({ id: 's3', name: 'x', command: 'x', profileIds: ['nope'] })).rejects.toThrow(
      'Host not found'
    )
  })

  it('removes a deleted host from snippets, making host-less snippets global', async () => {
    await core.saveProfile(profile(22))
    await core.saveProfile(profile(22, { id: 'p2', name: 'Other' }))
    await core.saveSnippet({ id: 's1', name: 'a', command: 'a', profileIds: ['p1', 'p2'] })
    await core.saveSnippet({ id: 's2', name: 'b', command: 'b', profileIds: ['p1'] })
    await core.deleteProfile('p1')
    expect(core.snippets.get('s1')?.profileIds).toEqual(['p2'])
    expect(core.snippets.get('s2')).toEqual({ id: 's2', name: 'b', command: 'b' })
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

  it('does not trust a host key answered after the connection failed', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    const ask: Ask = async (p) => {
      if (p.kind !== 'hostkey') return { ok: false }
      server!.dropClients()
      await new Promise((r) => setTimeout(r, 200))
      return { ok: true }
    }
    await expect(core.connect('s1', 'p1', 80, 24, ask)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 400)) // let the late "Trust" answer arrive
    expect(core.knownHosts.value).toEqual({})
  })

  it('closes a session that finishes connecting after a lock', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port), 'pw')
    const ask: Ask = async (p) => {
      if (p.kind !== 'hostkey') return { ok: false }
      core.lock()
      return { ok: true }
    }
    await expect(core.connect('s1', 'p1', 80, 24, ask)).rejects.toThrow('Cancelled')
    await waitFor(() => server!.connections() === 0)
    await core.vault.unlock('master')
    core.write('s1', 'x') // no session registered under s1
    expect((core as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  it('closes the session when the vault locks while a password prompt is answered with save', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port))
    const ask: Ask = async (p) => {
      if (p.kind === 'password') {
        core.lock()
        return { ok: true, value: 'pw', save: true }
      }
      return { ok: true }
    }
    await expect(core.connect('s1', 'p1', 80, 24, ask)).rejects.toThrow('Cancelled')
    await waitFor(() => server!.connections() === 0)
    expect((core as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  it('does not leak a session when saving the prompted password fails', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await core.saveProfile(profile(server.port))
    vi.spyOn(core.vault, 'setPassword').mockRejectedValue(new Error('disk full'))
    const a = asker({ hostkey: { ok: true }, password: { ok: true, value: 'pw', save: true } })
    await expect(core.connect('s1', 'p1', 80, 24, a.ask)).rejects.toThrow('disk full')
    await waitFor(() => server!.connections() === 0)
    expect((core as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })
})
