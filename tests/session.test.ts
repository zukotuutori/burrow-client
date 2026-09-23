import { afterEach, describe, expect, it } from 'vitest'
import type { EventEmitter } from 'node:events'
import ssh2 from 'ssh2'
import type { ParsedKey } from 'ssh2'
import { describeError, SshSession, type ConnectOptions } from '../src/main/ssh/session'
import { fingerprint, generateKey } from '../src/main/keys/keys'
import { startTestServer, type TestServer } from './helpers/sshServer'
import { makeKeyPair } from './helpers/keys'
import { waitFor } from './helpers/waitFor'

let server: TestServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

function collector() {
  const state = { out: '', closed: null as string | null }
  return {
    state,
    handlers: {
      onData: (d: string) => {
        state.out += d
      },
      onClose: (r?: string) => {
        state.closed = r ?? ''
      }
    }
  }
}

const base = (port: number, extra: Partial<ConnectOptions>): ConnectOptions => ({
  host: '127.0.0.1',
  port,
  username: 'alice',
  cols: 80,
  rows: 24,
  verifyHostKey: async () => true,
  ...extra
})

describe('SshSession', () => {
  it('connects with a password, streams output and sends input', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const c = collector()
    const s = await SshSession.open(base(server.port, { password: 'pw' }), c.handlers)
    await waitFor(() => c.state.out.includes('welcome'))
    s.write('hi')
    await waitFor(() => c.state.out.includes('$ hi'))
    s.close()
    await waitFor(() => c.state.closed !== null)
  })

  it('reports a wrong password as an authentication failure', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await expect(SshSession.open(base(server.port, { password: 'nope' }), collector().handlers)).rejects.toThrow(
      'Authentication failed'
    )
  })

  it('connects with a key', async () => {
    const key = await generateKey('ed25519', 'test')
    server = await startTestServer({ user: 'alice', publicKey: key.publicKey })
    const s = await SshSession.open(base(server.port, { privateKey: key.privateKey }), collector().handlers)
    s.close()
  })

  it('connects with an encrypted key and its passphrase', async () => {
    const pair = makeKeyPair('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr', rounds: 16 })
    server = await startTestServer({ user: 'alice', publicKey: pair.public })
    const s = await SshSession.open(
      base(server.port, { privateKey: pair.private, passphrase: 'secret' }),
      collector().handlers
    )
    s.close()
  })

  it('passes the host key type and fingerprint to the verifier', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const seen: [string, string][] = []
    const s = await SshSession.open(
      base(server.port, {
        password: 'pw',
        verifyHostKey: async (algo, fp) => {
          seen.push([algo, fp])
          return true
        }
      }),
      collector().handlers
    )
    const hostPub = ssh2.utils.parseKey(server.hostKey) as ParsedKey
    expect(seen).toEqual([['ssh-ed25519', fingerprint(hostPub.getPublicSSH())]])
    s.close()
  })

  it('aborts when the host key is not trusted', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    await expect(
      SshSession.open(base(server.port, { password: 'pw', verifyHostKey: async () => false }), collector().handlers)
    ).rejects.toThrow('Host key rejected')
  })

  it('does not count time spent in the host key prompt against the ready timeout', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const s = await SshSession.open(
      base(server.port, {
        password: 'pw',
        readyTimeout: 300,
        verifyHostKey: async () => {
          await new Promise((r) => setTimeout(r, 600))
          return true
        }
      }),
      collector().handlers
    )
    s.close()
  })

  it('still times out a handshake that never gets going', async () => {
    const net = await import('node:net')
    const silent = net.createServer(() => undefined)
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    const port = (silent.address() as { port: number }).port
    try {
      await expect(
        SshSession.open(base(port, { password: 'pw', readyTimeout: 300 }), collector().handlers)
      ).rejects.toThrow('Connection timed out')
    } finally {
      silent.close()
    }
  })

  it('tells the verifier when the connection failed while it was waiting', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    let signal: AbortSignal | undefined
    const opening = SshSession.open(
      base(server.port, {
        password: 'pw',
        verifyHostKey: async (_algo, _fp, s) => {
          signal = s
          server!.dropClients()
          await new Promise((r) => setTimeout(r, 200))
          return true
        }
      }),
      collector().handlers
    )
    await expect(opening).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  it('forwards terminal resizes', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const s = await SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)
    s.resize(100, 40)
    await waitFor(() => server!.resizes.some((r) => r.cols === 100 && r.rows === 40))
    s.close()
  })

  it('reports a refused connection', async () => {
    const tmp = await startTestServer({ user: 'alice', password: 'pw' })
    const port = tmp.port
    await tmp.close()
    await expect(SshSession.open(base(port, { password: 'pw' }), collector().handlers)).rejects.toThrow(
      'Connection refused'
    )
  })

  it('calls onClose when the server drops the connection', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const c = collector()
    await SshSession.open(base(server.port, { password: 'pw' }), c.handlers)
    server.dropClients()
    await waitFor(() => c.state.closed !== null)
  })

  it('reports a channel error via onClose instead of throwing', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw' })
    const c = collector()
    const s = await SshSession.open(base(server.port, { password: 'pw' }), c.handlers)
    const channel = (s as unknown as { channel: EventEmitter }).channel
    channel.emit('error', new Error('boom'))
    await waitFor(() => c.state.closed !== null)
    expect(c.state.closed).toBe(describeError(new Error('boom')))
  })

  it('refuses servers that only offer SHA-1 host key signatures (ssh-rsa)', async () => {
    server = await startTestServer({
      user: 'alice',
      password: 'pw',
      hostKeyType: 'rsa',
      algorithms: { serverHostKey: ['ssh-rsa'] }
    })
    await expect(SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)).rejects.toThrow(
      'The server only supports outdated, insecure algorithms'
    )
  })

  it('still connects to RSA host keys signed with SHA-2', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw', hostKeyType: 'rsa' })
    const s = await SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)
    s.close()
  })

  it('refuses servers that only offer SHA-1 integrity checks (hmac-sha1)', async () => {
    server = await startTestServer({
      user: 'alice',
      password: 'pw',
      algorithms: { cipher: ['aes128-ctr'], hmac: ['hmac-sha1', 'hmac-sha1-etm@openssh.com'] }
    })
    await expect(SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)).rejects.toThrow(
      'The server only supports outdated, insecure algorithms'
    )
  })

  it('still connects when the server uses SHA-2 integrity checks with a non-AEAD cipher', async () => {
    server = await startTestServer({
      user: 'alice',
      password: 'pw',
      algorithms: { cipher: ['aes128-ctr'], hmac: ['hmac-sha2-256'] }
    })
    const s = await SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)
    s.close()
  })

  it('refuses servers that only offer SHA-1 key exchange', async () => {
    server = await startTestServer({ user: 'alice', password: 'pw', algorithms: { kex: ['diffie-hellman-group14-sha1'] } })
    await expect(SshSession.open(base(server.port, { password: 'pw' }), collector().handlers)).rejects.toThrow(
      'The server only supports outdated, insecure algorithms'
    )
  })

  it('maps common errors to readable messages', () => {
    expect(describeError({ code: 'ENOTFOUND' })).toBe('Host not found')
    expect(describeError({ code: 'ECONNREFUSED' })).toBe('Connection refused')
    expect(describeError(new Error('Timed out while waiting for handshake'))).toBe('Connection timed out')
    expect(describeError({ level: 'client-authentication', message: 'x' })).toBe('Authentication failed')
  })
})
