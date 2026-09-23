import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestServer } from '../tests/helpers/sshServer'

// A local echo SSH server with SFTP for clicking through the app. Not a real shell.
// A new host key is generated on every start, so reconnecting after a restart shows the "host key changed" warning.
async function main() {
  const root = mkdtempSync(join(tmpdir(), 'burrow-dev-sftp-'))
  writeFileSync(join(root, 'hello.txt'), 'hello from the dev server\n')
  mkdirSync(join(root, 'docs'))
  const server = await startTestServer({ user: 'dev', password: 'dev', sftpRoot: root, port: 2222 })
  console.log(`Dev SSH server on 127.0.0.1:${server.port} (user "dev", password "dev")`)
  console.log(`SFTP root: ${root}`)
}

void main()
