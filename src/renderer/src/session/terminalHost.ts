import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useCallback, useSyncExternalStore } from 'react'
import type { Settings } from '../../../shared/types'
import { api } from '../api'
import { errMsg } from '../util'
import { isMac, matchShortcut } from './shortcuts'

export type PaneStatus = { state: 'connecting' } | { state: 'connected' } | { state: 'closed'; reason: string }

const THEMES: Record<Settings['theme'], ITheme> = {
  dark: { background: '#15171c', foreground: '#d8dee9', cursor: '#7aa2f7', selectionBackground: '#3b4261' },
  light: { background: '#f4f5f8', foreground: '#1f2328', cursor: '#3d6df2', selectionBackground: '#c9d4f5' }
}

/**
 * One terminal pane and its SSH session or local shell. Lives outside React so it survives split-layout changes:
 * React only moves `el` between slot elements.
 */
export class TerminalHost {
  readonly el = document.createElement('div')
  status: PaneStatus = { state: 'connecting' }
  sessionId: string | null = null
  onFocus?: () => void
  private readonly term: Terminal
  private readonly fit = new FitAddon()
  private readonly listeners = new Set<() => void>()
  private readonly resizeObserver = new ResizeObserver(() => this.fitNow())
  private unsubscribe: (() => void)[] = []
  private opened = false
  private disposed = false

  constructor(
    /** Null for a local shell. */
    readonly profileId: string | null,
    settings: Settings
  ) {
    this.el.className = 'terminal-host'
    this.term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      theme: THEMES[settings.theme],
      cursorBlink: true,
      scrollback: 5000
    })
    this.term.loadAddon(this.fit)
    this.term.loadAddon(new WebLinksAddon((_event, uri) => void api.openExternal(uri)))
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e))
    this.term.onData((data) => this.send(data))
    this.term.onResize(({ cols, rows }) => {
      if (this.sessionId && this.status.state === 'connected') api.session.resize(this.sessionId, cols, rows)
    })
  }

  attach(slot: HTMLElement): void {
    slot.appendChild(this.el)
    if (this.opened) return this.fitNow()
    this.opened = true
    this.term.open(this.el)
    this.term.textarea?.addEventListener('focus', () => this.onFocus?.())
    this.resizeObserver.observe(this.el)
    this.fitNow()
    void this.connect()
  }

  detach(): void {
    this.el.remove()
  }

  async connect(): Promise<void> {
    if (this.disposed) return
    this.unsubscribe.forEach((u) => u())
    const id = crypto.randomUUID()
    this.sessionId = id
    this.setStatus({ state: 'connecting' })
    this.unsubscribe = [
      api.session.onData((sid, data) => {
        if (sid === id) this.term.write(data)
      }),
      api.session.onClosed((sid, reason) => {
        if (sid === id) this.setStatus({ state: 'closed', reason })
      })
    ]
    try {
      if (this.profileId) await api.session.connect(id, this.profileId, this.term.cols, this.term.rows)
      else await api.session.openLocal(id, this.term.cols, this.term.rows)
      if (this.disposed) return void api.session.close(id)
      if (this.sessionId !== id || this.status.state !== 'connecting') return
      this.setStatus({ state: 'connected' })
      api.session.resize(id, this.term.cols, this.term.rows)
      this.term.focus()
    } catch (e) {
      if (this.sessionId === id) this.setStatus({ state: 'closed', reason: errMsg(e) })
    }
  }

  send(text: string): void {
    if (this.sessionId && this.status.state === 'connected') api.session.write(this.sessionId, text)
  }

  focus(): void {
    this.term.focus()
  }

  applySettings(s: Settings): void {
    this.term.options.fontFamily = s.fontFamily
    this.term.options.fontSize = s.fontSize
    this.term.options.theme = THEMES[s.theme]
    this.fitNow()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe.forEach((u) => u())
    this.resizeObserver.disconnect()
    if (this.sessionId) void api.session.close(this.sessionId)
    this.term.dispose()
    this.el.remove()
    this.listeners.clear()
  }

  private setStatus(status: PaneStatus): void {
    this.status = status
    this.listeners.forEach((fn) => fn())
  }

  private fitNow(): void {
    if (this.opened && this.el.offsetWidth > 0 && this.el.offsetHeight > 0) this.fit.fit()
  }

  /** Returning false stops xterm from handling the key (it still bubbles to window listeners). */
  private handleKey(e: KeyboardEvent): boolean {
    if (matchShortcut(e)) return false
    if (!isMac && e.type === 'keydown' && e.ctrlKey && e.shiftKey && !e.altKey) {
      const key = e.key.toLowerCase()
      if (key === 'c') {
        const selection = this.term.getSelection()
        if (selection) void navigator.clipboard.writeText(selection)
        e.preventDefault()
        return false
      }
      if (key === 'v') {
        void navigator.clipboard.readText().then((text) => this.term.paste(text))
        e.preventDefault()
        return false
      }
    }
    return true
  }
}

export function useHostStatus(host: TerminalHost): PaneStatus {
  const subscribe = useCallback((fn: () => void) => host.subscribe(fn), [host])
  return useSyncExternalStore(subscribe, () => host.status)
}
