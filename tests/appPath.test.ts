import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppPath } from '../src/main/appPath'

const root = join('/', 'app', 'out', 'renderer')

describe('resolveAppPath', () => {
  it('maps app://burrow URLs to files inside the renderer folder', () => {
    expect(resolveAppPath(root, 'app://burrow/index.html')).toBe(join(root, 'index.html'))
    expect(resolveAppPath(root, 'app://burrow/assets/index-abc.js')).toBe(join(root, 'assets', 'index-abc.js'))
  })

  it('keeps dot segments inside the renderer folder (the URL parser collapses them)', () => {
    expect(resolveAppPath(root, 'app://burrow/../main/index.js')).toBe(join(root, 'main', 'index.js'))
    expect(resolveAppPath(root, 'app://burrow/%2e%2e/%2e%2e/secret')).toBe(join(root, 'secret'))
  })

  it('refuses encoded slashes that would escape the renderer folder after decoding', () => {
    expect(resolveAppPath(root, 'app://burrow/assets/..%2F..%2F..%2Fetc%2Fpasswd')).toBeNull()
    expect(resolveAppPath(root, 'app://burrow/..%2f..%2fmain%2findex.js')).toBeNull()
  })

  it('refuses the bare folder itself', () => {
    expect(resolveAppPath(root, 'app://burrow/')).toBeNull()
  })

  it('refuses other hosts, other schemes and malformed URLs', () => {
    expect(resolveAppPath(root, 'app://evil/index.html')).toBeNull()
    expect(resolveAppPath(root, 'file:///etc/passwd')).toBeNull()
    expect(resolveAppPath(root, 'app://burrow/%E0%A4%A')).toBeNull()
    expect(resolveAppPath(root, 'not a url')).toBeNull()
  })
})
