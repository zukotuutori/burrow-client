import { JsonDoc } from './jsonDoc'

export class Repo<T extends { id: string }> {
  readonly doc: JsonDoc<T[]>

  constructor(file: string) {
    this.doc = new JsonDoc<T[]>(file, [])
  }

  load(): Promise<void> {
    return this.doc.load()
  }

  list(): T[] {
    return this.doc.value
  }

  get(id: string): T | undefined {
    return this.doc.value.find((x) => x.id === id)
  }

  async upsert(item: T): Promise<void> {
    const next = [...this.doc.value]
    const i = next.findIndex((x) => x.id === item.id)
    if (i >= 0) next[i] = item
    else next.push(item)
    await this.doc.set(next)
  }

  async remove(id: string): Promise<void> {
    await this.doc.set(this.doc.value.filter((x) => x.id !== id))
  }
}
