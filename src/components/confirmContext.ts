import { createContext, useContext } from 'react'

/** What a caller asks for. `confirmLabel` defaults to "Continue" because most
 * of these gate a step in a flow rather than a deletion. */
export interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
}

export type Ask = (request: ConfirmRequest) => Promise<boolean>

// Separate from `ConfirmProvider.tsx` so that file exports only a component
// (for fast refresh).
export const ConfirmContext = createContext<Ask | null>(null)

/** `const confirm = useConfirm()`, then `if (!(await confirm({...}))) return`. */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext)
  if (!ask) throw new Error('useConfirm must be used inside a ConfirmProvider')
  return ask
}
