import { masterPasswordProblems, PASSWORD_RULE_TEXT, type PasswordRule } from '../../../shared/passwordPolicy'

/** Live checklist of the master password rules. */
export function PasswordRules({ password }: { password: string }) {
  const problems = masterPasswordProblems(password)
  return (
    <ul className="pw-rules">
      {(Object.keys(PASSWORD_RULE_TEXT) as PasswordRule[]).map((rule) => (
        <li key={rule} className={problems.includes(rule) ? '' : 'met'}>
          {problems.includes(rule) ? '○' : '✓'} {PASSWORD_RULE_TEXT[rule]}
        </li>
      ))}
    </ul>
  )
}
