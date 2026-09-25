import type { HostKeyCheck, KnownHosts } from '../../shared/types'

export function hostId(host: string, port: number): string {
  return `${host}:${port}`
}

export function checkHostKey(
  known: KnownHosts,
  host: string,
  port: number,
  algo: string,
  fingerprint: string
): HostKeyCheck {
  const entry = known[hostId(host, port)]
  if (!entry || entry.deleted) return { state: 'unknown', algo, fingerprint }
  if (entry.fingerprint === fingerprint) return { state: 'match' }
  return { state: 'changed', algo, fingerprint, oldFingerprint: entry.fingerprint }
}
