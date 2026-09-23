import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshSession } from '../src/main/ssh/session'
import { SftpClient } from '../src/main/ssh/sftp'
import { startTestServer, type TestServer } from './helpers/sshServer'

let root: string
let local: string
let server: TestServer
let session: SshSession
let client: SftpClient

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'burrow-sftp-root-'))
  local = await mkdtemp(join(tmpdir(), 'burrow-sftp-local-'))
  await writeFile(join(root, 'a.txt'), 'alpha')
  await mkdir(join(root, 'sub'))
  server = await startTestServer({ user: 'alice', password: 'pw', sftpRoot: root })
  session = await SshSession.open(
    {
      host: '127.0.0.1',
      port: server.port,
      username: 'alice',
      password: 'pw',
      cols: 80,
      rows: 24,
      verifyHostKey: async () => true
    },
    { onData: () => undefined, onClose: () => undefined }
  )
  client = new SftpClient(await session.sftp())
})

afterEach(async () => {
  session.close()
  await server.close()
  await rm(root, { recursive: true, force: true })
  await rm(local, { recursive: true, force: true })
})

describe('SftpClient', () => {
  it('resolves the home directory', async () => {
    expect(await client.home()).toBe('/')
  })

  it('lists folders first, then files', async () => {
    const list = await client.list('/')
    expect(list.map((e) => [e.name, e.isDir])).toEqual([
      ['sub', true],
      ['a.txt', false]
    ])
    expect(list[1].size).toBe(5)
  })

  it('uploads and downloads files', async () => {
    const src = join(local, 'up.txt')
    await writeFile(src, 'uploaded')
    await client.upload(src, '/sub/up.txt')
    expect(await readFile(join(root, 'sub', 'up.txt'), 'utf8')).toBe('uploaded')

    const dst = join(local, 'down.txt')
    await client.download('/a.txt', dst)
    expect(await readFile(dst, 'utf8')).toBe('alpha')
  })

  it('renames, creates and removes', async () => {
    await client.rename('/a.txt', '/b.txt')
    await client.mkdir('/new')
    expect((await stat(join(root, 'new'))).isDirectory()).toBe(true)
    await client.remove('/b.txt', false)
    await client.remove('/new', true)
    expect((await client.list('/')).map((e) => e.name)).toEqual(['sub'])
  })
})
