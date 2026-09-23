import { describe, expect, it } from 'vitest'
import { shouldIdleLock } from '../src/main/idleLock'

describe('shouldIdleLock', () => {
  it('locks once the system has been idle for the configured minutes', () => {
    expect(shouldIdleLock({ idleSeconds: 899, minutes: 15, unlocked: true })).toBe(false)
    expect(shouldIdleLock({ idleSeconds: 900, minutes: 15, unlocked: true })).toBe(true)
  })

  it('never locks when auto-lock is off or the vault is already locked', () => {
    expect(shouldIdleLock({ idleSeconds: 99999, minutes: 0, unlocked: true })).toBe(false)
    expect(shouldIdleLock({ idleSeconds: 99999, minutes: 15, unlocked: false })).toBe(false)
  })
})
