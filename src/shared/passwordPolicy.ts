export const MIN_MASTER_PASSWORD_LENGTH = 12

export type PasswordRule = 'length' | 'digit' | 'special'

export const PASSWORD_RULE_TEXT: Record<PasswordRule, string> = {
  length: `At least ${MIN_MASTER_PASSWORD_LENGTH} characters`,
  digit: 'At least one number',
  special: 'At least one special character (like ! ? - # €)'
}

/** Rules the password does not meet yet, in display order. Empty means the password is acceptable. */
export function masterPasswordProblems(password: string): PasswordRule[] {
  const problems: PasswordRule[] = []
  if ([...password].length < MIN_MASTER_PASSWORD_LENGTH) problems.push('length')
  if (!/\p{N}/u.test(password)) problems.push('digit')
  // Anything that is not a letter, a number or whitespace counts as special, so umlauts do not.
  if (!/[^\p{L}\p{N}\s]/u.test(password)) problems.push('special')
  return problems
}
