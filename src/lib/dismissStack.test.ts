import { describe, it, expect, beforeEach } from 'vitest'
import {
  pushDismissable,
  removeDismissable,
  isTopDismissable,
  resetDismissStack,
} from './dismissStack'

describe('dismissStack', () => {
  beforeEach(() => resetDismissStack())

  it('treats the most recently registered surface as the top', () => {
    const panel = Symbol('panel')
    const confirm = Symbol('confirm')
    pushDismissable(panel)
    pushDismissable(confirm)

    expect(isTopDismissable(confirm)).toBe(true)
    expect(isTopDismissable(panel)).toBe(false)
  })

  /** The case the whole thing exists for: cancelling a confirmation raised
   * from a panel must not also close the panel underneath. */
  it('hands the surface below back to the top once the one above leaves', () => {
    const panel = Symbol('panel')
    const confirm = Symbol('confirm')
    pushDismissable(panel)
    pushDismissable(confirm)

    removeDismissable(confirm)

    expect(isTopDismissable(panel)).toBe(true)
  })

  /** StrictMode invokes effects twice, so a surface can register while already
   * registered. That must not leave a duplicate behind that keeps claiming to
   * be top after the surface has gone. */
  it('re-registering moves a surface rather than duplicating it', () => {
    const panel = Symbol('panel')
    const confirm = Symbol('confirm')
    pushDismissable(panel)
    pushDismissable(confirm)

    pushDismissable(panel) // now the top

    expect(isTopDismissable(panel)).toBe(true)
    removeDismissable(panel)
    expect(isTopDismissable(confirm)).toBe(true)
    expect(isTopDismissable(panel)).toBe(false)
  })

  it('an unregistered surface is never top', () => {
    const stray = Symbol('stray')
    expect(isTopDismissable(stray)).toBe(false)

    pushDismissable(Symbol('other'))
    expect(isTopDismissable(stray)).toBe(false)
  })

  it('removing something absent is harmless', () => {
    const panel = Symbol('panel')
    pushDismissable(panel)
    removeDismissable(Symbol('never-registered'))
    expect(isTopDismissable(panel)).toBe(true)
  })

  /** Surfaces don't always close in the order they opened — a panel can be
   * closed by its own button while a confirmation is still up. */
  it('handles removal from the middle of the stack', () => {
    const a = Symbol('a')
    const b = Symbol('b')
    const c = Symbol('c')
    pushDismissable(a)
    pushDismissable(b)
    pushDismissable(c)

    removeDismissable(b)

    expect(isTopDismissable(c)).toBe(true)
    removeDismissable(c)
    expect(isTopDismissable(a)).toBe(true)
  })
})
