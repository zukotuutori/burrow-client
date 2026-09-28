import type { AppUpdater } from 'electron-updater'
import type { UpdateInfo } from '../shared/types'

const REPO = 'zukotuutori/burrow-client'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASE_PAGES = `https://github.com/${REPO}/releases/`
const DOWNLOADS = `${RELEASE_PAGES}download/`
const REQUEST_TIMEOUT_MS = 15_000

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

export interface System {
  platform: string
  arch: string
  /** Running from an AppImage, which is the only build that can replace itself. */
  isAppImage: boolean
}

/** Compares x.y.z versions number by number. A leading "v" is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

const ARCH_NAMES: Record<string, RegExp> = { arm64: /arm64|aarch64/i, x64: /x64|x86_64|amd64/i }

/**
 * The release file for this system: the dmg on macOS, the AppImage or rpm on Linux, depending on how Burrow
 * was installed. electron-builder leaves the architecture out of x64 Linux file names, so a file without any
 * architecture counts as x64.
 */
export function pickAsset(assets: ReleaseAsset[], platform: string, arch: string, isAppImage: boolean): ReleaseAsset | undefined {
  const ext = platform === 'darwin' ? '.dmg' : platform === 'linux' ? (isAppImage ? '.appimage' : '.rpm') : undefined
  const own = ARCH_NAMES[arch]
  if (!ext || !own) return undefined
  const files = assets.filter((a) => a.name.toLowerCase().endsWith(ext) && a.browser_download_url.startsWith(DOWNLOADS))
  const other = Object.entries(ARCH_NAMES).filter(([name]) => name !== arch).map(([, re]) => re)
  return (
    files.find((a) => own.test(a.name)) ??
    files.find((a) => /universal/i.test(a.name)) ??
    (arch === 'x64' ? files.find((a) => !other.some((re) => re.test(a.name))) : undefined)
  )
}

/** Asks GitHub for the latest release and compares it with the running version. */
export async function checkForUpdate(current: string, system: System, fetchFn: typeof fetch = fetch): Promise<UpdateInfo> {
  let res: Response
  try {
    res = await fetchFn(LATEST_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Burrow-Client' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection.')
  }
  if (res.status === 404) throw new Error('No release has been published yet')
  if (res.status === 403 || res.status === 429) throw new Error("GitHub's rate limit was reached. Try again in an hour.")
  if (!res.ok) throw new Error(`GitHub answered with status ${res.status}`)

  const release = (await res.json().catch(() => null)) as { tag_name?: unknown; html_url?: unknown; assets?: unknown } | null
  if (
    !release ||
    typeof release.tag_name !== 'string' ||
    typeof release.html_url !== 'string' ||
    !release.html_url.startsWith(RELEASE_PAGES) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('GitHub sent an unexpected answer')
  }
  const assets = (release.assets as ReleaseAsset[]).filter(
    (a) => typeof a?.name === 'string' && typeof a?.browser_download_url === 'string'
  )
  const file = pickAsset(assets, system.platform, system.arch, system.isAppImage)
  return {
    current,
    latest: release.tag_name.replace(/^v/, ''),
    available: isNewer(release.tag_name, current),
    downloadUrl: file?.browser_download_url ?? release.html_url,
    canInstall: system.isAppImage && !!file
  }
}

/**
 * electron-updater is CommonJS and creates autoUpdater in a getter, which Node does not offer as a named
 * export through import(). It is only loaded when needed, because it picks the updater for the platform.
 */
async function loadUpdater(): Promise<AppUpdater> {
  const mod = await import('electron-updater')
  return (mod as unknown as { default: typeof mod }).default.autoUpdater
}

/**
 * Downloads the update through electron-updater. It reads latest-linux.yml from the release and checks the
 * download against the SHA-512 hash in it. The update is installed on restart or the next time the app quits.
 */
export async function downloadUpdate(): Promise<void> {
  const autoUpdater = await loadUpdater()
  autoUpdater.autoDownload = false
  const result = await autoUpdater.checkForUpdates()
  if (!result?.isUpdateAvailable) throw new Error('The update could not be found. Download it from GitHub instead.')
  await autoUpdater.downloadUpdate()
}

export async function restartToUpdate(): Promise<void> {
  const autoUpdater = await loadUpdater()
  autoUpdater.quitAndInstall()
}
