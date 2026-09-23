import { isAbsolute, join, relative, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'burrow'
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** Maps an app://burrow/... URL to a file inside `root`, or null if it points anywhere else. */
export function resolveAppPath(root: string, url: string): string | null {
  let parsed: URL
  let pathname: string
  try {
    parsed = new URL(url)
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null
  const full = join(root, pathname)
  const rel = relative(root, full)
  // Empty means the folder itself; '..' or an absolute path means it points outside the folder.
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return full
}
