import { JsonDoc } from './jsonDoc'

type Item = { id: string; updatedAt?: number; deleted?: boolean }

/** Keeps only what a tombstone needs. The cast is safe because list() and get() never return deleted items. */
export function tombstone<T extends Item>(x: T): T {
  return { id: x.id, updatedAt: x.updatedAt, deleted: true } as T
}

export class Repo<T extends Item> {
  readonly doc: JsonDoc<T[]>

  constructor(file: string) {
    this.doc = new JsonDoc<T[]>(file, [])
  }

  load(): Promise<void> {
    return this.doc.load()
  }

  /** Items that are not deleted. */
  list(): T[] {
    return this.doc.value.filter((x) => !x.deleted)
  }

  /** Every item including tombstones, for sync. */
  all(): T[] {
    return this.doc.value
  }

  get(id: string): T | undefined {
    return this.doc.value.find((x) => x.id === id && !x.deleted)
  }

  /** Saves the item and stamps it with the current time, so sync knows it is the newest version. */
  async upsert(item: T): Promise<void> {
    const stamped = { ...item, updatedAt: Date.now() }
    const next = [...this.doc.value]
    const i = next.findIndex((x) => x.id === item.id)
    if (i >= 0) next[i] = stamped
    else next.push(stamped)
    await this.doc.set(next)
  }

  /** Replaces the item with a tombstone, so the delete reaches other devices. */
  async remove(id: string): Promise<void> {
    const item = this.get(id)
    if (item) await this.upsert(tombstone(item))
  }
}
