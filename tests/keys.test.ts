import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { generateKey, importKey, isEncrypted, KeyParseError, NeedsPassphraseError } from '../src/main/keys/keys'
import { makeKeyPair } from './helpers/keys'

const FP = /^SHA256:[A-Za-z0-9+/]{43}$/

type KeygenCallback = (err: Error | null, keys: { private: string; public: string }) => void

afterEach(() => {
  vi.restoreAllMocks()
})

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
    const pair = makeKeyPair('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 16 })
    expect(isEncrypted(pair.private)).toBe(true)
    expect(() => importKey(pair.private)).toThrow(NeedsPassphraseError)
    expect(importKey(pair.private, 'secret').type).toBe('ssh-ed25519')
    expect(() => importKey(pair.private, 'wrong')).toThrow(KeyParseError)
  })

  it('rejects garbage', () => {
    expect(() => importKey('not a key')).toThrow(KeyParseError)
  })

  it('retries ed25519 generation when ssh2 produces an unreadable key', async () => {
    const real = ssh2.utils.generateKeyPair.bind(ssh2.utils)
    let calls = 0
    vi.spyOn(ssh2.utils, 'generateKeyPair').mockImplementation(((type: 'ed25519', opts: object, cb: KeygenCallback) => {
      calls++
      if (calls === 1) return cb(null, { private: 'garbage', public: 'garbage' })
      return real(type, opts, cb)
    }) as never)
    const k = await generateKey('ed25519', 'x')
    expect(calls).toBe(2)
    expect(k.fingerprint).toMatch(FP)
  })

  it('rejects instead of hanging when every ed25519 attempt is unreadable', async () => {
    let calls = 0
    vi.spyOn(ssh2.utils, 'generateKeyPair').mockImplementation(((_t: string, _o: object, cb: KeygenCallback) => {
      calls++
      cb(null, { private: 'garbage', public: 'garbage' })
    }) as never)
    await expect(generateKey('ed25519', 'x')).rejects.toThrow(KeyParseError)
    expect(calls).toBe(5)
  })

  it('rejects when ssh2 reports a keygen error', async () => {
    vi.spyOn(ssh2.utils, 'generateKeyPair').mockImplementation(((_t: string, _o: object, cb: KeygenCallback) =>
      cb(new Error('boom'), undefined as never)) as never)
    await expect(generateKey('rsa', 'x')).rejects.toThrow('boom')
  })

  it('settles every one of 1000 ed25519 generations to a valid key', async () => {
    // ssh2 1.17.0 corrupts about 1 in 256 ed25519 keys, so 1000 runs hit that case a few times.
    const keys = await Promise.all(Array.from({ length: 1000 }, () => generateKey('ed25519', '')))
    for (const k of keys) expect(importKey(k.privateKey).fingerprint).toBe(k.fingerprint)
  })
})
