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

function generateOnce(type: KeyType, comment: string): Promise<KeyMaterial> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, keys: { private: string; public: string }) => {
      if (err) return reject(err)
      try {
        resolve(importKey(keys.private, undefined, comment))
      } catch (e) {
        reject(e)
      }
    }
    if (type === 'rsa') utils.generateKeyPair('rsa', { bits: 4096, comment }, done)
    else utils.generateKeyPair('ed25519', { comment }, done)
  })
}

/** ssh2 1.17.0 strips every leading 0x00 from an ed25519 public key, so about 1 in 256 keys is malformed. */
const ED25519_ATTEMPTS = 5

export async function generateKey(type: KeyType, comment: string): Promise<KeyMaterial> {
  if (type === 'rsa') return generateOnce(type, comment)
  for (let attempt = 1; ; attempt++) {
    try {
      return await generateOnce(type, comment)
    } catch (e) {
      if (!(e instanceof KeyParseError) || attempt >= ED25519_ATTEMPTS) throw e
    }
  }
}
