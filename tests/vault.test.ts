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

  it('stays locked when it is locked while a password change is running', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    const change = v.changePassword('master', 'next-one')
    v.lock()
    await expect(change).rejects.toBeInstanceOf(VaultLockedError)
    expect(v.isUnlocked).toBe(false)
    await new Vault(file, FAST).unlock('master')
  })

  it('refuses to create over an existing vault', async () => {
    const v = new Vault(file, FAST)
    await v.create('master')
    v.lock()
    await expect(v.create('other')).rejects.toThrow(/already exists/)
  })
})
