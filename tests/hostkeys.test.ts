import { describe, expect, it } from 'vitest'
import { checkHostKey, hostId } from '../src/main/ssh/hostkeys'

const known = { 'example.com:22': { algo: 'ssh-ed25519', fingerprint: 'SHA256:aaa', addedAt: '2026-01-01' } }

describe('checkHostKey', () => {
  it('builds ids from host and port', () => {
    expect(hostId('example.com', 2222)).toBe('example.com:2222')
  })
  it('reports unknown hosts', () => {
    expect(checkHostKey(known, 'other', 22, 'ssh-ed25519', 'SHA256:bbb')).toEqual({
      state: 'unknown',
      algo: 'ssh-ed25519',
      fingerprint: 'SHA256:bbb'
    })
  })
  it('matches known fingerprints', () => {
    expect(checkHostKey(known, 'example.com', 22, 'ssh-ed25519', 'SHA256:aaa')).toEqual({ state: 'match' })
  })
  it('reports changed fingerprints with the old value', () => {
    expect(checkHostKey(known, 'example.com', 22, 'ssh-ed25519', 'SHA256:ccc')).toEqual({
      state: 'changed',
      algo: 'ssh-ed25519',
      fingerprint: 'SHA256:ccc',
      oldFingerprint: 'SHA256:aaa'
    })
  })
  it('treats a different port as a different host', () => {
    expect(checkHostKey(known, 'example.com', 2222, 'ssh-ed25519', 'SHA256:aaa').state).toBe('unknown')
  })
})
