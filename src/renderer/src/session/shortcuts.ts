import { api } from '../api'

export const isMac = api.platform === 'darwin'

export type ShortcutAction = 'splitRight' | 'splitDown' | 'closePane'

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = isMac
  ? { splitRight: '⌘D', splitDown: '⇧⌘D', closePane: '⌘W' }
  : { splitRight: 'Ctrl+Shift+D', splitDown: 'Ctrl+Shift+E', closePane: 'Ctrl+Shift+W' }

export function matchShortcut(e: KeyboardEvent): ShortcutAction | null {
  if (e.type !== 'keydown' || e.altKey) return null
  const key = e.key.toLowerCase()
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return null
    if (key === 'd') return e.shiftKey ? 'splitDown' : 'splitRight'
    if (key === 'w' && !e.shiftKey) return 'closePane'
    return null
  }
  if (!e.ctrlKey || !e.shiftKey || e.metaKey) return null
  if (key === 'd') return 'splitRight'
  if (key === 'e') return 'splitDown'
  if (key === 'w') return 'closePane'
  return null
}
