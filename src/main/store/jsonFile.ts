import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export class CorruptFileError extends Error {
  constructor(
    readonly file: string,
    cause: unknown
  ) {
    super(`${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CorruptFileError'
  }
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  const text = await readText(file)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new CorruptFileError(file, e)
  }
}

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, contents, { mode: 0o600 })
  await fs.rename(tmp, file)
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n')
}

export async function backupFile(file: string, now = new Date()): Promise<string | undefined> {
  const target = `${file}.broken-${now.toISOString().replace(/[:.]/g, '-')}`
  try {
    await fs.copyFile(file, target)
    return target
  } catch (e) {
    if (isMissing(e)) return undefined
    throw e
  }
}
