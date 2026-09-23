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
