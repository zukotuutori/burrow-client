import ssh2 from 'ssh2'

const { utils } = ssh2

type KeyPairOptions = { bits?: number; passphrase?: string; cipher?: string; rounds?: number; comment?: string }

/**
 * ssh2's keygen strips every leading 0x00 from an ed25519 public key, so about 1 in 256 generated
 * keys cannot be parsed. Regenerate until both halves parse.
 */
export function makeKeyPair(type: 'ed25519' | 'rsa' = 'ed25519', opts: KeyPairOptions = {}): { private: string; public: string } {
  for (let attempt = 0; attempt < 10; attempt++) {
    const pair = utils.generateKeyPairSync(type as 'ed25519', opts as never)
    const priv = utils.parseKey(pair.private, (opts as { passphrase?: string }).passphrase)
    const pub = utils.parseKey(pair.public)
    if (!(priv instanceof Error) && !(pub instanceof Error)) return pair
  }
  throw new Error('Could not generate a parseable test key')
}
