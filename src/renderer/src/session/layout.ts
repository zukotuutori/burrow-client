export type SplitDir = 'row' | 'col'

export type PaneNode =
  | { type: 'pane'; id: string }
  | { type: 'split'; id: string; dir: SplitDir; children: PaneNode[]; sizes: number[] }

export function pane(id: string): PaneNode {
  return { type: 'pane', id }
}

export function paneIds(node: PaneNode): string[] {
  return node.type === 'pane' ? [node.id] : node.children.flatMap(paneIds)
}

export function splitPane(node: PaneNode, targetId: string, dir: SplitDir, newId: string): PaneNode {
  if (node.type === 'pane') {
    if (node.id !== targetId) return node
    return { type: 'split', id: `split-${newId}`, dir, children: [node, pane(newId)], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.type === 'pane' && c.id === targetId)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    children.splice(i + 1, 0, pane(newId))
    const sizes = [...node.sizes]
    const half = sizes[i] / 2
    sizes.splice(i, 1, half, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => splitPane(c, targetId, dir, newId)) }
}

export function removePane(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === 'pane') return node.id === targetId ? null : node
  const children: PaneNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const kept = removePane(c, targetId)
    if (kept) {
      children.push(kept)
      sizes.push(node.sizes[i])
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...node, children, sizes: sizes.map((s) => s / total) }
}

export function resizeSplit(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === 'pane') return node
  if (node.id === splitId) return { ...node, sizes }
  return { ...node, children: node.children.map((c) => resizeSplit(c, splitId, sizes)) }
}
