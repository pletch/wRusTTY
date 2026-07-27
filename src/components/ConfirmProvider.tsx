import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from './ConfirmDialog'
import { ConfirmContext, type Ask, type ConfirmRequest } from './confirmContext'

/** Renders the app's own `ConfirmDialog` in answer to an imperative call.
 *
 * The six prompts this replaces used `window.confirm`, which in WebView2 draws
 * browser chrome captioned with the origin — the user sees a grey box titled
 * roughly "tauri.localhost says". Against custom decorations, mica, and a
 * styled dialog already used for pane and tab closes, that reads as a webpage
 * popup rather than part of the app. It is worst on the prompts that matter
 * most: the vault export disclosure is a security decision, and presenting it
 * in something that looks like a browser artifact undercuts it.
 *
 * A provider rather than per-site state because every one of those call sites
 * is imperative — `if (!ok) return` partway through an async handler. Wiring
 * each to a rendered component would mean six copies of the same
 * pending-action state machine; awaiting a promise keeps them one-liners. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  // Held in a ref rather than state: it is the continuation of an await, not
  // anything the render reads.
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  const ask = useCallback<Ask>((next) => {
    return new Promise<boolean>((resolve) => {
      // A second prompt raised while one is up must not strand the first
      // caller awaiting forever — answer it "no", which is the safe direction
      // for every one of these.
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
