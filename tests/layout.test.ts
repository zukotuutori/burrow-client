import { describe, expect, it } from 'vitest'
import { pane, paneIds, removePane, resizeSplit, splitPane, type PaneNode } from '../src/renderer/src/session/layout'

type Split = Extract<PaneNode, { type: 'split' }>

describe('layout', () => {
  it('splits a single pane', () => {
    expect(splitPane(pane('a'), 'a', 'row', 'b')).toEqual({
      type: 'split',
      id: 'split-b',
      dir: 'row',
      children: [pane('a'), pane('b')],
      sizes: [0.5, 0.5]
    })
  })

  it('adds a sibling when splitting in the same direction', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'a', 'row', 'c')
    expect(paneIds(l)).toEqual(['a', 'c', 'b'])
    expect((l as Split).sizes).toEqual([0.25, 0.25, 0.5])
  })

  it('nests when splitting in the other direction', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'b', 'col', 'c')
    expect(l).toMatchObject({
      dir: 'row',
      children: [pane('a'), { type: 'split', dir: 'col', children: [pane('b'), pane('c')] }]
    })
  })

  it('removes panes and collapses single-child splits', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'b', 'col', 'c')
    const r = removePane(l, 'c')!
    expect(r).toMatchObject({ dir: 'row', children: [pane('a'), pane('b')] })
    expect(removePane(r, 'a')).toEqual(pane('b'))
    expect(removePane(pane('b'), 'b')).toBeNull()
  })

  it('renormalizes sizes after removal', () => {
    const l = splitPane(splitPane(pane('a'), 'a', 'row', 'b'), 'a', 'row', 'c')
    expect((removePane(l, 'b') as Split).sizes).toEqual([0.5, 0.5])
  })

  it('resizes a split by id', () => {
    expect(resizeSplit(splitPane(pane('a'), 'a', 'row', 'b'), 'split-b', [0.3, 0.7])).toMatchObject({ sizes: [0.3, 0.7] })
  })
})
