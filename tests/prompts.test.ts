import { describe, expect, it } from 'vitest'
import { PendingPrompts } from '../src/main/prompts'

describe('PendingPrompts', () => {
  it('resolves a prompt with the sanitized answer', async () => {
    const prompts = new PendingPrompts()
    let id = ''
    const answer = prompts.ask((i) => (id = i))
    prompts.answer(id, { ok: true, value: 'pw', save: 1, extra: 'x' })
    expect(await answer).toEqual({ ok: true, value: 'pw', save: false })
  })

  it('ignores unknown ids and repeated answers', async () => {
    const prompts = new PendingPrompts()
    let id = ''
    const answer = prompts.ask((i) => (id = i))
    prompts.answer('nope', { ok: true })
    prompts.answer(42, { ok: true })
    prompts.answer(id, { ok: false })
    prompts.answer(id, { ok: true })
    expect(await answer).toEqual({ ok: false, value: undefined, save: false })
  })

  it('cancels every pending prompt', async () => {
    const prompts = new PendingPrompts()
    const a = prompts.ask(() => undefined)
    const b = prompts.ask(() => undefined)
    prompts.cancelAll()
    expect(await a).toEqual({ ok: false })
    expect(await b).toEqual({ ok: false })
    expect(prompts.size).toBe(0)
  })
})
