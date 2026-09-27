import { homedir } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import type { SessionHandlers } from './ssh/session'

/** A shell on this machine, running in a pseudo terminal. */
export class LocalShell {
  private closed = false
  private readonly pty: IPty

  constructor(
    cols: number,
    rows: number,
    private readonly handlers: SessionHandlers
  ) {
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    // A login shell, so apps started from Finder or a desktop launcher still get the user's PATH.
    this.pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    })
    this.pty.onData((d) => handlers.onData(d))
    this.pty.onExit(({ exitCode }) => this.finish(exitCode === 0 ? 'Shell exited' : `Shell exited with code ${exitCode}`))
  }

  write(data: string): void {
    if (!this.closed) this.pty.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.pty.resize(cols, rows)
  }

  close(): void {
    if (!this.closed) this.pty.kill()
    this.finish()
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.handlers.onClose(reason)
  }
}
