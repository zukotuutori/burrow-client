/** Whether the vault should lock because nobody has touched keyboard or mouse for `minutes` (0 = never). */
export function shouldIdleLock({ idleSeconds, minutes, unlocked }: { idleSeconds: number; minutes: number; unlocked: boolean }): boolean {
  return unlocked && minutes > 0 && idleSeconds >= minutes * 60
}
