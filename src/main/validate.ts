import type { KeyMeta, KnownHosts, Profile, Settings, Snippet, SnippetExport, SnippetExportEntry, Syncable } from '../shared/types'

const isStr = (v: unknown): v is string => typeof v === 'string'
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0
/** Ids are used as object keys in the vault, so they must be plain and never a built-in key like "constructor". */
export const isSafeId = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9-]{1,64}$/.test(v) && !(v in Object.prototype)

/** Keeps the sync fields, so data from another device keeps its timestamps. */
function syncFields(v: { updatedAt?: unknown; deleted?: unknown }): Syncable {
  return {
    ...(Number.isFinite(v.updatedAt) ? { updatedAt: v.updatedAt as number } : {}),
    ...(v.deleted === true ? { deleted: true } : {})
  }
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: "Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
  fontSize: 13,
  theme: 'dark',
  autoLockMinutes: 15,
  showHostStatus: false,
  blockScreenshots: true,
  checkUpdatesOnStartup: false
}

export function validateProfile(v: unknown): Profile {
  const p = (v ?? {}) as Partial<Profile>
  if (!isSafeId(p.id)) throw new Error('Invalid host id')
  if (!nonEmpty(p.name)) throw new Error('Label is required')
  if (!nonEmpty(p.host)) throw new Error('Host is required')
  if (!nonEmpty(p.user)) throw new Error('Username is required')
  if (!Number.isInteger(p.port) || p.port! < 1 || p.port! > 65535) throw new Error('Port must be between 1 and 65535')
  if (p.authType !== 'password' && p.authType !== 'key') throw new Error('Invalid authentication type')
  if (p.authType === 'key' && !nonEmpty(p.keyId)) throw new Error('Choose a key')
  if (p.note !== undefined && (!isStr(p.note) || p.note.length > 5000)) throw new Error('Note must be at most 5000 characters')
  const note = p.note?.trim()
  return {
    ...syncFields(p),
    id: p.id,
    name: p.name.trim(),
    group: isStr(p.group) ? p.group.trim() : '',
    host: p.host.trim(),
    port: p.port!,
    user: p.user.trim(),
    authType: p.authType,
    ...(p.authType === 'key' ? { keyId: p.keyId } : {}),
    ...(note ? { note } : {})
  }
}

export function validateSnippet(v: unknown): Snippet {
  const s = (v ?? {}) as Partial<Snippet>
  if (!isSafeId(s.id)) throw new Error('Invalid snippet id')
  if (!nonEmpty(s.name)) throw new Error('Name is required')
  if (!nonEmpty(s.command)) throw new Error('Command is required')
  const tags = Array.isArray(s.tags) ? s.tags.filter(nonEmpty).map((t) => t.trim()) : []
  const profileIds = Array.isArray(s.profileIds) ? [...new Set(s.profileIds.filter(nonEmpty))] : []
  return {
    ...syncFields(s),
    id: s.id,
    name: s.name.trim(),
    command: s.command,
    ...(tags.length ? { tags } : {}),
    ...(profileIds.length ? { profileIds } : {})
  }
}

const EXPORT_LIMITS = { snippets: 5000, name: 200, command: 20000, list: 100, item: 200 }

function stringList(v: unknown, what: string, where: string): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > EXPORT_LIMITS.list || !v.every((x) => isStr(x) && x.length <= EXPORT_LIMITS.item)) {
    throw new Error(`${where}: ${what} must be a list of short texts`)
  }
  return v.filter(nonEmpty).map((x) => x.trim())
}

/** Checks a snippet export file and returns its entries. Throws on anything unexpected, so nothing half-imports. */
export function validateSnippetExport(v: unknown): SnippetExportEntry[] {
  const file = v as Partial<SnippetExport> | null
  if (!file || typeof file !== 'object' || file.format !== 'burrow-snippets') throw new Error('This is not a Burrow snippets file')
  if (file.version !== 1) throw new Error('This snippets file comes from a newer or unknown version of Burrow')
  if (!Array.isArray(file.snippets)) throw new Error('The snippets file has no snippet list')
  if (file.snippets.length > EXPORT_LIMITS.snippets) throw new Error(`The file has more than ${EXPORT_LIMITS.snippets} snippets`)
  return file.snippets.map((raw, i) => {
    const where = `Snippet ${i + 1}`
    const e = (raw ?? {}) as Partial<SnippetExportEntry>
    if (!nonEmpty(e.name) || e.name.length > EXPORT_LIMITS.name) throw new Error(`${where}: name is missing or too long`)
    if (!nonEmpty(e.command) || e.command.length > EXPORT_LIMITS.command) throw new Error(`${where}: command is missing or too long`)
    const tags = stringList(e.tags, 'tags', where)
    const hosts = stringList(e.hosts, 'hosts', where)
    return { name: e.name.trim(), command: e.command, ...(tags?.length ? { tags } : {}), ...(hosts?.length ? { hosts } : {}) }
  })
}

export function validateSettings(v: unknown): Settings {
  const s = (v ?? {}) as Partial<Settings>
  if (!nonEmpty(s.fontFamily)) throw new Error('Font family is required')
  if (!Number.isInteger(s.fontSize) || s.fontSize! < 8 || s.fontSize! > 32) throw new Error('Font size must be 8 to 32')
  if (s.theme !== 'dark' && s.theme !== 'light') throw new Error('Invalid theme')
  if (!Number.isInteger(s.autoLockMinutes) || s.autoLockMinutes! < 0 || s.autoLockMinutes! > 1440) {
    throw new Error('Auto-lock must be 0 (off) to 1440 minutes')
  }
  if (typeof s.showHostStatus !== 'boolean') throw new Error('Invalid host status setting')
  // Missing on settings synced from devices that predate this option; those keep the default.
  if (s.blockScreenshots !== undefined && typeof s.blockScreenshots !== 'boolean') throw new Error('Invalid screenshot setting')
  if (s.checkUpdatesOnStartup !== undefined && typeof s.checkUpdatesOnStartup !== 'boolean') {
    throw new Error('Invalid update check setting')
  }
  return {
    ...syncFields(s),
    fontFamily: s.fontFamily.trim(),
    fontSize: s.fontSize!,
    theme: s.theme,
    autoLockMinutes: s.autoLockMinutes!,
    showHostStatus: s.showHostStatus,
    blockScreenshots: s.blockScreenshots ?? DEFAULT_SETTINGS.blockScreenshots,
    checkUpdatesOnStartup: s.checkUpdatesOnStartup ?? DEFAULT_SETTINGS.checkUpdatesOnStartup
  }
}

export function validateKeyMeta(v: unknown): KeyMeta {
  const k = (v ?? {}) as Partial<KeyMeta>
  if (!isSafeId(k.id)) throw new Error('Invalid key id')
  if (![k.name, k.type, k.publicKey, k.fingerprint, k.createdAt].every(isStr)) throw new Error('Invalid key')
  return {
    ...syncFields(k),
    id: k.id,
    name: k.name!,
    type: k.type!,
    publicKey: k.publicKey!,
    fingerprint: k.fingerprint!,
    createdAt: k.createdAt!
  }
}

export function validateKnownHosts(v: unknown): KnownHosts {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid known hosts')
  const out: KnownHosts = {}
  for (const [id, raw] of Object.entries(v)) {
    const e = (raw ?? {}) as Partial<KnownHosts[string]>
    if (!/^\S+:\d{1,5}$/.test(id) || id in Object.prototype) throw new Error('Invalid known host')
    if (![e.algo, e.fingerprint, e.addedAt].every(isStr)) throw new Error('Invalid known host')
    out[id] = { ...syncFields(e), algo: e.algo!, fingerprint: e.fingerprint!, addedAt: e.addedAt! }
  }
  return out
}
