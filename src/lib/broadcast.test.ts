import { describe, it, expect, beforeEach } from 'vitest'
import * as broadcast from './broadcast'

function recorder() {
  const received: string[] = []
  const send = (data: Uint8Array) => {
    received.push(new TextDecoder().decode(data))
  }
  return { received, send }
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('broadcast', () => {
  beforeEach(() => broadcast.reset())

  it('sends to every pane in the group, including the origin', () => {
    const a = recorder()
    const b = recorder()
    broadcast.join('pane-a', 'tab-1', a.send)
    broadcast.join('pane-b', 'tab-1', b.send)

    expect(broadcast.send('tab-1', bytes('uptime\r'))).toBe(2)
    expect(a.received).toEqual(['uptime\r'])
    expect(b.received).toEqual(['uptime\r'])
  })

  /** How `Terminal` actually sends: the origin pane writes to its own session
   * on the ordinary single-pane path, so including it here too would send
   * everything typed into it twice. */
  it('omits the origin pane when asked', () => {
    const origin = recorder()
    const other = recorder()
    broadcast.join('pane-a', 'tab-1', origin.send)
    broadcast.join('pane-b', 'tab-1', other.send)

    expect(broadcast.send('tab-1', bytes('uptime\r'), 'pane-a')).toBe(1)
    expect(origin.received).toEqual([])
    expect(other.received).toEqual(['uptime\r'])
  })

  /** A pane on its own broadcasts to nobody — the fan-out is additive, so the
   * single-pane case has to come out as zero extra sends rather than one. */
  it('sends to nobody when the origin is the only member', () => {
    const only = recorder()
    broadcast.join('pane-a', 'tab-1', only.send)

    expect(broadcast.send('tab-1', bytes('x'), 'pane-a')).toBe(0)
    expect(only.received).toEqual([])
  })

  /** The containment property the whole feature rests on. Broadcasting a
   * `reload` into a tab of switches is intended; leaking it into the tab where
   * someone has a production database open is not. */
  it('never reaches a pane in another group', () => {
    const inTab = recorder()
    const elsewhere = recorder()
    broadcast.join('pane-a', 'tab-1', inTab.send)
    broadcast.join('pane-b', 'tab-2', elsewhere.send)

    broadcast.send('tab-1', bytes('reload\r'))

    expect(inTab.received).toEqual(['reload\r'])
    expect(elsewhere.received).toEqual([])
  })

  it('stops sending to a pane that has left', () => {
    const a = recorder()
    const b = recorder()
    broadcast.join('pane-a', 'tab-1', a.send)
    const leave = broadcast.join('pane-b', 'tab-1', b.send)

    leave()

    expect(broadcast.send('tab-1', bytes('x'))).toBe(1)
    expect(b.received).toEqual([])
  })

  /** A pane dragged to another tab has to change group, or "all panes in this
   * tab" stops meaning what it says the moment anything moves. */
  it('re-registering moves a pane to the new group', () => {
    const moved = recorder()
    broadcast.join('pane-a', 'tab-1', moved.send)
    broadcast.join('pane-a', 'tab-2', moved.send)

    expect(broadcast.membersOf('tab-1')).toEqual([])
    expect(broadcast.membersOf('tab-2')).toEqual(['pane-a'])
    expect(broadcast.send('tab-1', bytes('x'))).toBe(0)
  })

  /** The unregister returned by the *old* registration must not remove the
   * new one — React runs the previous effect's cleanup after the next effect
   * has already run when deps change under StrictMode. */
  it('a stale unregister does not remove a re-registered pane', () => {
    const first = recorder()
    const second = recorder()
    const staleLeave = broadcast.join('pane-a', 'tab-1', first.send)
    broadcast.join('pane-a', 'tab-2', second.send)

    staleLeave()

    expect(broadcast.membersOf('tab-2')).toEqual(['pane-a'])
  })

  /** Drives the indicator, which is the thing standing between the user and
   * an accidental broadcast — it has to be right. */
  it('reports how many panes would receive a broadcast', () => {
    broadcast.join('pane-a', 'tab-1', recorder().send)
    broadcast.join('pane-b', 'tab-1', recorder().send)
    broadcast.join('pane-c', 'tab-2', recorder().send)

    expect(broadcast.size('tab-1')).toBe(2)
    expect(broadcast.size('tab-2')).toBe(1)
    expect(broadcast.size('tab-empty')).toBe(0)
  })

  /** A pane that disconnects in response to what it was sent (`exit\r`)
   * removes itself mid-send; iterating the live map would skip a sibling. */
  it('survives a pane leaving from inside its own send', () => {
    const survivor = recorder()
    let leaveSelf: (() => void) | null = null
    leaveSelf = broadcast.join('pane-a', 'tab-1', () => leaveSelf?.())
    broadcast.join('pane-b', 'tab-1', survivor.send)

    expect(broadcast.send('tab-1', bytes('exit\r'))).toBe(2)
    expect(survivor.received).toEqual(['exit\r'])
    expect(broadcast.membersOf('tab-1')).toEqual(['pane-b'])
  })
})
