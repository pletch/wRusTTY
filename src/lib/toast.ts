export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
}

type Listener = (toasts: ToastItem[]) => void

let toasts: ToastItem[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l([...toasts])
}

function push(kind: ToastKind, message: string) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  toasts = [...toasts, { id, kind, message }]
  emit()
  setTimeout(() => dismiss(id), kind === 'error' ? 5000 : 3000)
}

export function dismiss(id: string) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  listener([...toasts])
  return () => listeners.delete(listener)
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
}
