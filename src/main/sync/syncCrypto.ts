import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { deriveKey, type KdfParams } from '../vault/crypto'
import type { SyncKeys } from '../vault/vault'

/** Never change these: every device must derive the same keys from the same username and password. */
export const SYNC_KDF: KdfParams = { N: 131072, r: 8, p: 1 }

export const USERNAME_RULE = /^[a-z0-9._-]{3,32}$/

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

/** The salt comes from the username, so a new device can compute it before it logs in. */
function saltFor(username: string): Buffer {
  return createHash('sha256').update('burrow-sync-v1:' + normalizeUsername(username)).digest()
}

/**
 * Turns the account password into two independent keys. authKey is sent to the server to log in.
 * encKey encrypts the data and never leaves the device, so the server cannot read anything.
 */
export async function deriveSyncKeys(username: string, password: string, kdf: KdfParams = SYNC_KDF): Promise<SyncKeys> {
  const master = await deriveKey(password, saltFor(username), kdf)
  const authKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'burrow-auth', 32))
  const encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'burrow-enc', 32))
  master.fill(0)
  return { authKey, encKey }
}

export interface SealedBlob {
  v: 1
  iv: string
  tag: string
  data: string
}

export function encryptBlob(plain: unknown, key: Buffer): SealedBlob {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** Throws when the key is wrong or the blob was changed. */
export function decryptBlob(blob: SealedBlob, key: Buffer): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('The synced data could not be decrypted')
  }
}
