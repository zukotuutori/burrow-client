import { promises as fs, type Stats } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, posix } from 'node:path'
import ssh2 from 'ssh2'
import type { Connection, ParsedKey, SFTPWrapper } from 'ssh2'
import { makeKeyPair } from './keys'

const { Server, utils } = ssh2
const { STATUS_CODE, flagsToString } = utils.sftp

export interface TestServerOptions {
  user: string
  password?: string
  /** OpenSSH public key line allowed to log in. */
  publicKey?: string
  /** Directory served over SFTP. SFTP is refused when unset. */
  sftpRoot?: string
  port?: number
  /** Host key type; defaults to ed25519. */
  hostKeyType?: 'ed25519' | 'rsa'
  /** Restrict the algorithms the server offers, to simulate old servers. */
  algorithms?: ConstructorParameters<typeof Server>[0]['algorithms']
}

export interface TestServer {
  port: number
  hostKey: string
  resizes: { cols: number; rows: number }[]
  /** Number of client connections currently open. */
  connections(): number
  dropClients(): void
  close(): Promise<void>
}

export async function startTestServer(opts: TestServerOptions): Promise<TestServer> {
  const hostKey = (opts.hostKeyType === 'rsa' ? makeKeyPair('rsa', { bits: 2048 }) : makeKeyPair('ed25519')).private
  const allowed = opts.publicKey ? (utils.parseKey(opts.publicKey) as ParsedKey) : undefined
  const clients = new Set<Connection>()
  const resizes: { cols: number; rows: number }[] = []

  const server = new Server({ hostKeys: [hostKey], algorithms: opts.algorithms }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => undefined)
    client.on('authentication', (ctx) => {
      if (ctx.username !== opts.user) return ctx.reject()
      if (ctx.method === 'password' && opts.password !== undefined && ctx.password === opts.password) {
        return ctx.accept()
      }
      if (
        ctx.method === 'publickey' &&
        allowed &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.equals(allowed.getPublicSSH())
      ) {
        if (!ctx.signature) return ctx.accept()
        if (allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) return ctx.accept()
      }
      ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept, _reject, info) => {
          resizes.push({ cols: info.cols, rows: info.rows })
          accept?.()
        })
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('welcome\r\n$ ')
          stream.on('data', (d: Buffer) => stream.write(d.toString('utf8').replace(/\r/g, '\r\n$ ')))
        })
        session.on('sftp', (accept, reject) => {
          if (!opts.sftpRoot) return reject?.()
          serveSftp(accept(), opts.sftpRoot)
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    hostKey,
    resizes,
    connections: () => clients.size,
    dropClients: () => clients.forEach((c) => c.end()),
    close: () =>
      new Promise<void>((resolve) => {
        clients.forEach((c) => c.end())
        server.close(() => resolve())
      })
  }
}

interface Handle {
  path: string
  file?: fs.FileHandle
  names?: string[]
}

function serveSftp(sftp: SFTPWrapper, root: string): void {
  const handles = new Map<number, Handle>()
  let nextHandle = 0
  const real = (p: string) => join(root, posix.normalize('/' + p))
  const makeHandle = (h: Handle) => {
    const id = nextHandle++
    handles.set(id, h)
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id)
    return buf
  }
  const getHandle = (buf: Buffer) => handles.get(buf.readUInt32BE(0))
  const attrs = (s: Stats) => ({
    mode: s.mode,
    uid: s.uid,
    gid: s.gid,
    size: s.size,
    atime: Math.floor(s.atimeMs / 1000),
    mtime: Math.floor(s.mtimeMs / 1000)
  })
  const guard = (reqid: number, fn: () => Promise<unknown>) => {
    fn().catch(() => sftp.status(reqid, STATUS_CODE.FAILURE))
  }
  const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK)

  sftp.on('REALPATH', (reqid, p) => {
    const n = posix.normalize('/' + p)
    sftp.name(reqid, [{ filename: n, longname: n, attrs: {} as never }])
  })
  const stat = (reqid: number, p: string) => guard(reqid, async () => sftp.attrs(reqid, attrs(await fs.stat(real(p)))))
  sftp.on('STAT', stat)
  sftp.on('LSTAT', stat)
  sftp.on('OPENDIR', (reqid, p) =>
    guard(reqid, async () => {
      const names = await fs.readdir(real(p))
      sftp.handle(reqid, makeHandle({ path: real(p), names }))
    })
  )
  sftp.on('READDIR', (reqid, hbuf) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.names) throw new Error('bad handle')
      if (h.names.length === 0) return sftp.status(reqid, STATUS_CODE.EOF)
      const names = h.names.splice(0)
      const entries = await Promise.all(
        names.map(async (n) => ({ filename: n, longname: n, attrs: attrs(await fs.stat(join(h.path, n))) }))
      )
      sftp.name(reqid, entries)
    })
  )
  sftp.on('OPEN', (reqid, p, flags) =>
    guard(reqid, async () => {
      const file = await fs.open(real(p), flagsToString(flags) ?? 'r')
      sftp.handle(reqid, makeHandle({ path: real(p), file }))
    })
  )
  sftp.on('READ', (reqid, hbuf, offset, length) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      const buf = Buffer.alloc(length)
      const { bytesRead } = await h.file.read(buf, 0, length, offset)
      if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, buf.subarray(0, bytesRead))
    })
  )
  sftp.on('WRITE', (reqid, hbuf, offset, data) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      await h.file.write(data, 0, data.length, offset)
      ok(reqid)
    })
  )
  sftp.on('FSTAT', (reqid, hbuf) =>
    guard(reqid, async () => {
      const h = getHandle(hbuf)
      if (!h?.file) throw new Error('bad handle')
      sftp.attrs(reqid, attrs(await h.file.stat()))
    })
  )
  sftp.on('FSETSTAT', (reqid) => ok(reqid))
  sftp.on('SETSTAT', (reqid) => ok(reqid))
  sftp.on('CLOSE', (reqid, hbuf) =>
    guard(reqid, async () => {
      const id = hbuf.readUInt32BE(0)
      const h = handles.get(id)
      handles.delete(id)
      await h?.file?.close()
      ok(reqid)
    })
  )
  sftp.on('REMOVE', (reqid, p) => guard(reqid, async () => (await fs.unlink(real(p)), ok(reqid))))
  sftp.on('RMDIR', (reqid, p) => guard(reqid, async () => (await fs.rmdir(real(p)), ok(reqid))))
  sftp.on('MKDIR', (reqid, p) => guard(reqid, async () => (await fs.mkdir(real(p)), ok(reqid))))
  sftp.on('RENAME', (reqid, a, b) => guard(reqid, async () => (await fs.rename(real(a), real(b)), ok(reqid))))
}
