import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { ConfirmContext, type Ask, type ConfirmRequest } from './confirmContext'

/** Renders the app's own `ConfirmDialog` for an imperative `await ask(...)`.
 * In WebView2, `window.confirm` draws a browser box captioned with the
 * origin, which undercuts prompts like the vault export disclosure. A
 * provider keeps each call site a one-line await. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  // A ref: it's an await's continuation, not render state.
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const ask = useCallback<Ask>((next) => {
    return new Promise<boolean>((resolve) => {
      // A second prompt answers the first "no" (the safe direction) so it isn't
      // stranded.
      resolveRef.current?.(false)
      resolveRef.current = resolve
      setRequest(next)
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setRequest(null)
    resolve?.(ok)
  }, [])

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {request && (
        <ConfirmDialog
          title={request.title}
          body={request.body}
          confirmLabel={request.confirmLabel ?? 'Continue'}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}
