import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { errMsg } from './util'

type Kind = 'info' | 'error'
type Push = (text: string, kind?: Kind) => void

const ToastContext = createContext<Push>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: Kind }[]>([])
  const push = useCallback<Push>((text, kind = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/** Runs an async action, shows errors as toasts and resolves to whether it succeeded. */
export function useAction() {
  const toast = useToast()
  return useCallback(
    async (fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
      try {
        await fn()
        if (success) toast(success)
        return true
      } catch (e) {
        toast(errMsg(e), 'error')
        return false
      }
    },
    [toast]
  )
}
