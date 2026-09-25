import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorruptFileError, readJson, writeJsonAtomic } from '../src/main/store/jsonFile'
import { JsonDoc } from '../src/main/store/jsonDoc'
import { Repo } from '../src/main/store/repo'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'burrow-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('jsonFile', () => {
  it('returns the fallback when the file is missing', async () => {
    expect(await readJson(join(dir, 'x.json'), { a: 1 })).toEqual({ a: 1 })
  })

  it('writes atomically and reads back', async () => {
    const file = join(dir, 'x.json')
    await writeJsonAtomic(file, { hello: 'world' })
    expect(await readJson(file, {})).toEqual({ hello: 'world' })
    expect(await readdir(dir)).toEqual(['x.json'])
  })

  it('throws CorruptFileError for invalid JSON', async () => {
    const file = join(dir, 'x.json')
    await writeFile(file, '{nope')
    await expect(readJson(file, {})).rejects.toBeInstanceOf(CorruptFileError)
  })
})

describe('file permissions', () => {
  it('creates missing folders private to the user and files readable only by the user', async () => {
    const file = join(dir, 'nested', 'deeper', 'x.json')
    await writeJsonAtomic(file, { a: 1 })
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'nested', 'deeper'))).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })
})

describe('JsonDoc', () => {
  it('blocks writes to a broken file until reset, and keeps a backup', async () => {
    const file = join(dir, 'settings.json')
    await writeFile(file, '{nope')
    const doc = new JsonDoc(file, { n: 0 })
    await expect(doc.load()).rejects.toBeInstanceOf(CorruptFileError)
    expect(doc.isBroken).toBe(true)
    await expect(doc.set({ n: 1 })).rejects.toThrow(/Reset it first/)
    expect(await readFile(file, 'utf8')).toBe('{nope')

    const backup = await doc.reset()
    expect(backup).toMatch(/settings\.json\.broken-/)
    expect(await readFile(backup!, 'utf8')).toBe('{nope')
    expect(await readJson(file, null)).toEqual({ n: 0 })
    await doc.set({ n: 2 })
    expect(doc.value).toEqual({ n: 2 })
  })

  it('serializes concurrent writes', async () => {
    const file = join(dir, 'd.json')
    const doc = new JsonDoc(file, 0)
    await Promise.all([doc.set(1), doc.set(2), doc.set(3)])
    expect(await readJson(file, null)).toBe(3)
  })
})

describe('Repo', () => {
  it('inserts, updates in place, removes and persists', async () => {
    const file = join(dir, 'items.json')
    const repo = new Repo<{ id: string; v: number }>(file)
    await repo.load()
    await repo.upsert({ id: 'a', v: 1 })
    await repo.upsert({ id: 'b', v: 2 })
    await repo.upsert({ id: 'a', v: 3 })
    expect(repo.list()).toEqual([
      { id: 'a', v: 3, updatedAt: expect.any(Number) },
      { id: 'b', v: 2, updatedAt: expect.any(Number) }
    ])
    await repo.remove('a')

    const again = new Repo<{ id: string; v: number }>(file)
    await again.load()
    expect(again.list()).toEqual([{ id: 'b', v: 2, updatedAt: expect.any(Number) }])
    expect(again.get('b')).toMatchObject({ id: 'b', v: 2 })
    expect(again.get('a')).toBeUndefined()
  })

  it('keeps a removed item as a tombstone with only id and time', async () => {
    const repo = new Repo<{ id: string; v: number }>(join(dir, 'items.json'))
    await repo.upsert({ id: 'a', v: 1 })
    await repo.remove('a')
    expect(repo.all()).toEqual([{ id: 'a', updatedAt: expect.any(Number), deleted: true }])
    expect(repo.list()).toEqual([])
  })
})
