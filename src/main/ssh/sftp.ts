import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import type { RemoteEntry } from '../../shared/types'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

type Done = (err?: Error | null) => void

function run(fn: (done: Done) => void): Promise<void> {
  return new Promise((resolve, reject) => fn((err) => (err ? reject(err) : resolve())))
}

export class SftpClient {
  constructor(private readonly sftp: SFTPWrapper) {}

  home(): Promise<string> {
    return new Promise((resolve, reject) => this.sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))))
  }

  async list(dir: string): Promise<RemoteEntry[]> {
    const items = await new Promise<FileEntryWithStats[]>((resolve, reject) =>
      this.sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list)))
    )
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => ({
        name: i.filename,
        isDir: (i.attrs.mode & S_IFMT) === S_IFDIR,
        size: i.attrs.size,
        mtime: i.attrs.mtime
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  }

  upload(localPath: string, remotePath: string): Promise<void> {
    return run((done) => this.sftp.fastPut(localPath, remotePath, done))
  }

  download(remotePath: string, localPath: string): Promise<void> {
    return run((done) => this.sftp.fastGet(remotePath, localPath, done))
  }

  rename(from: string, to: string): Promise<void> {
    return run((done) => this.sftp.rename(from, to, done))
  }

  remove(path: string, isDir: boolean): Promise<void> {
    return run((done) => (isDir ? this.sftp.rmdir(path, done) : this.sftp.unlink(path, done)))
  }

  mkdir(path: string): Promise<void> {
    return run((done) => this.sftp.mkdir(path, done))
  }
}
