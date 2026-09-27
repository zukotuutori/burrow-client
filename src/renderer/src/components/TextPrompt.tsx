import { useState } from 'react'
import { Modal } from './Modal'

export function TextPrompt({
  title,
  initial = '',
  confirmLabel = 'Save',
  onSubmit,
  onCancel
}: {
  title: string
  initial?: string
  confirmLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Modal>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) onSubmit(value.trim())
        }}
      >
        <h3>{title}</h3>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
        <div className="actions">
          <button type="button" title="Close without changes" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" title={confirmLabel}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
