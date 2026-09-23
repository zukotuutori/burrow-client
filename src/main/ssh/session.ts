import { StringDecoder } from 'node:string_decoder'
import ssh2 from 'ssh2'
import type { Algorithms, Client as SshClient, ClientChannel, SFTPWrapper } from 'ssh2'
import { fingerprint } from '../keys/keys'

const { Client, utils } = ssh2

export interface ConnectOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  cols: number
  rows: number
  /** `signal` aborts when the connection fails while the answer is pending. */
  verifyHostKey(algo: string, fingerprint: string, signal: AbortSignal): Promise<boolean>
  /** Handshake timeout in ms, not counting time spent in verifyHostKey. Default 20000. */
  readyTimeout?: number
}

export interface SessionHandlers {
  onData(data: string): void
  onClose(reason?: string): void
}

/**
 * Everything based on SHA-1 is removed from what we offer the server. KEX and host keys fall back to
 * modern choices; if a server only speaks SHA-1, the handshake fails instead of connecting insecurely.
 */
const without = <T>(names: T[]) => ({ append: [] as T[], prepend: [] as T[], remove: names })
const NO_SHA1_ALGORITHMS: Algorithms = {
  kex: without(['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1']),
  serverHostKey: without(['ssh-rsa', 'ssh-dss']),
  hmac: without(['hmac-sha1', 'hmac-sha1-etm@openssh.com', 'hmac-sha1-96', 'hmac-md5', 'hmac-md5-96'])
}

export function describeError(err: unknown): string {
  const e = (err ?? {}) as { code?: string; level?: string; message?: string }
  const msg = e.message ?? ''
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'Host not found'
  if (e.code === 'ECONNREFUSED') return 'Connection refused'
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return 'Host unreachable'
  if (e.code === 'ETIMEDOUT' || /timed out/i.test(msg)) return 'Connection timed out'
  if (/^Host denied/i.test(msg)) return 'Host key rejected'
  if (/^Handshake failed: no matching/i.test(msg)) return 'The server only supports outdated, insecure algorithms'
  if (e.level === 'client-authentication') return 'Authentication failed'
  return msg || String(err)
}

function hostKeyType(key: Buffer): string {
  const parsed = utils.parseKey(key)
  if (parsed instanceof Error) return 'unknown'
  return (Array.isArray(parsed) ? parsed[0] : parsed).type
}

export class SshSession {
  private closed = false
  private sftpPromise?: Promise<SFTPWrapper>

  private constructor(
    private readonly conn: SshClient,
    private readonly channel: ClientChannel,
    private readonly handlers: SessionHandlers
  ) {
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    channel.on('data', (d: Buffer) => handlers.onData(out.write(d)))
    channel.stderr.on('data', (d: Buffer) => handlers.onData(err.write(d)))
    channel.on('error', (e: Error) => this.finish(describeError(e)))
    channel.stderr.on('error', (e: Error) => this.finish(describeError(e)))
    channel.on('close', () => this.finish())
    conn.on('error', (e) => this.finish(describeError(e)))
    conn.on('close', () => this.finish())
  }

  static open(opts: ConnectOptions, handlers: SessionHandlers): Promise<SshSession> {
    return new Promise((resolve, reject) => {
      const conn = new Client()
      const aborted = new AbortController()
      let settled = false
      // Our own handshake timeout. ssh2's readyTimeout would keep running while the user reads the
      // host key prompt, so it is disabled and this one is paused while verifyHostKey is pending.
      let remaining = opts.readyTimeout ?? 20000
      let timer: NodeJS.Timeout | undefined
      let startedAt = 0
      const resume = () => {
        startedAt = Date.now()
        timer = setTimeout(() => fail(new Error('Timed out while waiting for handshake')), remaining)
      }
      const pause = () => {
        clearTimeout(timer)
        remaining = Math.max(0, remaining - (Date.now() - startedAt))
      }
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        aborted.abort()
        conn.end()
        reject(new Error(describeError(err)))
      }
      conn.on('error', fail)
      conn.on('close', () => fail(new Error('Connection closed')))
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, channel) => {
          if (err) return fail(err)
          if (settled) return channel.close()
          settled = true
          clearTimeout(timer)
          conn.removeListener('error', fail)
          resolve(new SshSession(conn, channel, handlers))
        })
      })
      resume()
      conn.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase,
        readyTimeout: 0,
        keepaliveInterval: 15000,
        algorithms: NO_SHA1_ALGORITHMS,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          pause()
          const answer = (ok: boolean) => {
            if (settled) return
            resume()
            verify(ok)
          }
          opts.verifyHostKey(hostKeyType(key), fingerprint(key), aborted.signal).then(answer, () => answer(false))
        }
      })
    })
  }

  write(data: string): void {
    if (!this.closed) this.channel.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.channel.setWindow(rows, cols, 0, 0)
  }

  sftp(): Promise<SFTPWrapper> {
    this.sftpPromise ??= new Promise<SFTPWrapper>((resolve, reject) => {
      this.conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    }).catch((e) => {
      this.sftpPromise = undefined
      throw e
    })
    return this.sftpPromise
  }

  close(): void {
    this.finish()
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.conn.end()
    this.handlers.onClose(reason)
  }
}
