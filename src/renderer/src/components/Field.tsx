import type { ReactNode } from 'react'

export function Field({ label, hint, width, children }: { label: string; hint?: ReactNode; width?: number; children: ReactNode }) {
  return (
    <div className="field" style={width ? { width, flex: 'none' } : undefined}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
