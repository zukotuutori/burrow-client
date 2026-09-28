import { describe, expect, it } from 'vitest'
import { checkForUpdate, isNewer, pickAsset } from '../src/main/updates'

const DL = 'https://github.com/zukotuutori/burrow-client/releases/download/v1.1.0/'
const asset = (name: string) => ({ name, browser_download_url: DL + name })
const ASSETS = [
  asset('Burrow.Client-1.1.0-arm64.dmg'),
  asset('Burrow.Client-1.1.0.AppImage'),
  asset('Burrow.Client-1.1.0-arm64.AppImage'),
  asset('burrow-client-1.1.0.x86_64.rpm'),
  asset('latest-linux.yml')
]

describe('isNewer', () => {
  it('compares versions number by number', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.9.0', '1.0.0')).toBe(false)
  })

  it('ignores a leading v', () => {
    expect(isNewer('v1.1.0', '1.0.0')).toBe(true)
    expect(isNewer('v1.0.0', '1.0.0')).toBe(false)
  })
})

describe('pickAsset', () => {
  it('picks the dmg for the Mac architecture', () => {
    expect(pickAsset(ASSETS, 'darwin', 'arm64', false)?.name).toBe('Burrow.Client-1.1.0-arm64.dmg')
  })

  it('does not hand an Intel Mac an Apple Silicon build', () => {
    expect(pickAsset(ASSETS, 'darwin', 'x64', false)).toBeUndefined()
  })

  it('picks the AppImage when running as an AppImage', () => {
    expect(pickAsset(ASSETS, 'linux', 'x64', true)?.name).toBe('Burrow.Client-1.1.0.AppImage')
    expect(pickAsset(ASSETS, 'linux', 'arm64', true)?.name).toBe('Burrow.Client-1.1.0-arm64.AppImage')
  })

  it('picks the rpm when installed from the rpm', () => {
    expect(pickAsset(ASSETS, 'linux', 'x64', false)?.name).toBe('burrow-client-1.1.0.x86_64.rpm')
  })

  it('ignores links that do not point to this repository', () => {
    const evil = { name: 'Burrow.Client-1.1.0-arm64.dmg', browser_download_url: 'https://example.com/Burrow.dmg' }
    expect(pickAsset([evil], 'darwin', 'arm64', false)).toBeUndefined()
  })
})

describe('checkForUpdate', () => {
  const release = {
    tag_name: 'v1.1.0',
    html_url: 'https://github.com/zukotuutori/burrow-client/releases/tag/v1.1.0',
    assets: ASSETS
  }
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status })
  const system = { platform: 'darwin', arch: 'arm64', isAppImage: false }

  it('reports a newer release with the download for this system', async () => {
    const info = await checkForUpdate('1.0.0', system, respond(200, release))
    expect(info).toEqual({
      current: '1.0.0',
      latest: '1.1.0',
      available: true,
      downloadUrl: DL + 'Burrow.Client-1.1.0-arm64.dmg',
      canInstall: false
    })
  })

  it('reports no update when the release is not newer', async () => {
    const info = await checkForUpdate('1.1.0', system, respond(200, release))
    expect(info.available).toBe(false)
  })

  it('lets an AppImage install the update itself', async () => {
    const info = await checkForUpdate('1.0.0', { platform: 'linux', arch: 'x64', isAppImage: true }, respond(200, release))
    expect(info.canInstall).toBe(true)
    expect(info.downloadUrl).toBe(DL + 'Burrow.Client-1.1.0.AppImage')
  })

  it('falls back to the release page when there is no file for this system', async () => {
    const info = await checkForUpdate('1.0.0', { ...system, arch: 'x64' }, respond(200, release))
    expect(info.downloadUrl).toBe(release.html_url)
  })

  it('explains a missing release and a rate limit', async () => {
    await expect(checkForUpdate('1.0.0', system, respond(404, {}))).rejects.toThrow(/No release/)
    await expect(checkForUpdate('1.0.0', system, respond(403, {}))).rejects.toThrow(/rate limit/)
  })

  it('rejects a response that does not look like a release of this repository', async () => {
    const bad = { ...release, html_url: 'https://example.com/release' }
    await expect(checkForUpdate('1.0.0', system, respond(200, bad))).rejects.toThrow(/unexpected/)
  })

  it('explains when GitHub cannot be reached', async () => {
    const offline = async (): Promise<Response> => {
      throw new TypeError('fetch failed')
    }
    await expect(checkForUpdate('1.0.0', system, offline)).rejects.toThrow(/Could not reach GitHub/)
  })
})
