import type { ReactNode } from 'react'

export function Modal({ children, warning }: { children: ReactNode; warning?: boolean }) {
  return (
    <div className="modal-backdrop">
      <div className={`modal ${warning ? 'warning' : ''}`} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  )
}
