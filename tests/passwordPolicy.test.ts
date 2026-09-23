import { describe, expect, it } from 'vitest'
import { masterPasswordProblems, MIN_MASTER_PASSWORD_LENGTH } from '../src/shared/passwordPolicy'

describe('master password policy', () => {
  it('requires at least 12 characters', () => {
    expect(MIN_MASTER_PASSWORD_LENGTH).toBe(12)
    expect(masterPasswordProblems('Abc-1234567')).toEqual(['length'])
    expect(masterPasswordProblems('Abc-12345678')).toEqual([])
  })

  it('requires a digit', () => {
    expect(masterPasswordProblems('abcdefghijk-')).toEqual(['digit'])
  })

  it('requires a special character, and letters or digits do not count', () => {
    expect(masterPasswordProblems('abcdefghijk1')).toEqual(['special'])
    expect(masterPasswordProblems('äöüßabcdefg1')).toEqual(['special'])
    expect(masterPasswordProblems('abcdefghij 1')).toEqual(['special'])
  })

  it('counts unicode punctuation and symbols as special characters', () => {
    expect(masterPasswordProblems('abcdefghij1€')).toEqual([])
    expect(masterPasswordProblems('abcdefghij1§')).toEqual([])
  })

  it('reports every missing rule', () => {
    expect(masterPasswordProblems('short')).toEqual(['length', 'digit', 'special'])
  })
})
