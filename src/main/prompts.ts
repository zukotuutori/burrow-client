import { randomUUID } from 'node:crypto'
import type { PromptAnswer } from '../shared/types'

/** Prompts sent to the renderer that are waiting for an answer. Kept free of Electron so it can be tested. */
export class PendingPrompts {
  private readonly pending = new Map<string, (answer: PromptAnswer) => void>()

  /** Registers a prompt, hands its id to `send`, and resolves once it is answered or cancelled. */
  ask(send: (id: string) => void): Promise<PromptAnswer> {
    return new Promise((resolve) => {
      const id = randomUUID()
      this.pending.set(id, resolve)
      send(id)
    })
  }

  answer(id: unknown, answer: unknown): void {
    const resolve = typeof id === 'string' ? this.pending.get(id) : undefined
    if (!resolve) return
    this.pending.delete(id as string)
    const a = (answer ?? {}) as PromptAnswer
    resolve({ ok: a.ok === true, value: typeof a.value === 'string' ? a.value : undefined, save: a.save === true })
  }

  /** Answers every pending prompt with "cancel", e.g. when the vault locks or the window closes. */
  cancelAll(): void {
    const resolvers = [...this.pending.values()]
    this.pending.clear()
    for (const resolve of resolvers) resolve({ ok: false })
  }

  get size(): number {
    return this.pending.size
  }
}
