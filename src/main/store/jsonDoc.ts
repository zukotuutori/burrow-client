import { basename } from 'node:path'
import { backupFile, CorruptFileError, readJson, writeJsonAtomic } from './jsonFile'

/** One JSON file held in memory. A file that fails to parse is marked broken and never overwritten until reset. */
export class JsonDoc<T> {
  private data: T
  private broken = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly fallback: T
  ) {
    this.data = structuredClone(fallback)
  }

  async load(): Promise<void> {
    try {
      this.data = await readJson(this.file, structuredClone(this.fallback))
      this.broken = false
    } catch (e) {
      if (e instanceof CorruptFileError) {
        this.broken = true
        this.data = structuredClone(this.fallback)
      }
      throw e
    }
  }

  get value(): T {
    return this.data
  }

  get isBroken(): boolean {
    return this.broken
  }

  set(value: T): Promise<void> {
    if (this.broken) {
      return Promise.reject(new Error(`${basename(this.file)} could not be read. Reset it first.`))
    }
    this.data = value
    const write = this.queue.catch(() => undefined).then(() => writeJsonAtomic(this.file, value))
    this.queue = write
    return write
  }

  /** Copies the current file to a backup, then writes the fallback value. */
  async reset(): Promise<string | undefined> {
    const backup = await backupFile(this.file)
    this.broken = false
    await this.set(structuredClone(this.fallback))
    return backup
  }
}
