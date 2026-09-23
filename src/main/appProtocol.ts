import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { protocol } from 'electron'
import { APP_SCHEME, resolveAppPath } from './appPath'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

/** Registers app:// as a secure standard scheme. Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }])
}

/** Serves the built UI from `root` over app://burrow/, and nothing outside it. */
export function serveAppFiles(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(root, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(new Uint8Array(body), {
        headers: { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
