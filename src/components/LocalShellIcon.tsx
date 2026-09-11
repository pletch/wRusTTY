import { useEffect, useState } from 'react'

import { cachedShellIconUrl, shellIconUrl } from '../lib/local'
import type { ShellGlyph } from './shellIconFor'

interface Props {
  glyph: ShellGlyph
  size?: number
}

/**
 * A local shell's icon in the tab strip.
 *
 * A bundled glyph draws immediately. An installed one — the Microsoft shells,
 * read from their own executables — draws its neutral fallback until the
 * backend answers, then the real icon; after the first tab has fetched it,
 * every later tab of the same shell starts with the real one.
 */
export function LocalShellIcon({ glyph, size = 12 }: Props) {
  const shellId = glyph.kind === 'installed' ? glyph.shellId : null
  const [url, setUrl] = useState<string | null | undefined>(() =>
    shellId ? cachedShellIconUrl(shellId) : undefined,
  )

  useEffect(() => {
    if (!shellId) return
    let cancelled = false
    void shellIconUrl(shellId).then((found) => {
      if (!cancelled) setUrl(found)
    })
    return () => {
      cancelled = true
    }
  }, [shellId])

  if (glyph.kind === 'bundled') {
    const Icon = glyph.icon
    return <Icon size={size} />
  }
  if (url) {
    // Decorative: the tab's own title already names the session, so a screen
    // reader announcing "PowerShell" twice would add nothing.
    return <img src={url} width={size} height={size} alt="" draggable={false} />
  }
  const Fallback = glyph.fallback
  return <Fallback size={size} />
}
