/** Input fan-out: type once, send to every connected pane in a group.
 *
 * This is SuperPuTTY's headline capability over plain PuTTY — *Send Commands
 * to all sessions* — and the reason people with a rack of switches stayed on
 * it. The architecture here already suits it: `usePanePortals` keeps every
 * pane's `Terminal` mounted whether or not it is visible, so a pane that isn't
 * on screen still has a live session and a live writer.
 *
 * A module-level registry rather than React state because the consumer is
 * `Terminal`'s `onData` handler, which lives inside the connection effect and
 * must not re-run when an unrelated pane joins or leaves — re-running it tears
 * down the session. Panes register themselves and read the group through refs;
 * nothing here re-renders anything.
 *
 * The group id is the tab id. A pane dragged to another tab re-registers under
 * the new one (see `Terminal`'s membership effect), so "all panes in this tab"
 * keeps meaning what it says as panes move.
 */

/** Sends bytes to one pane's session. Returns nothing: a failed write on one
 * pane must not stop the others, so errors are swallowed at the source. */
export type Send = (data: Uint8Array) => void

interface Member {
  groupId: string
  send: Send
}

const members = new Map<string, Member>()

/** Registers `paneId` as a broadcast target in `groupId`. Returns the
 * unregister function — call it when the pane disconnects or unmounts.
 *
 * Re-registering the same pane replaces its entry, which is how a pane moved
 * between tabs changes group. */
export function join(paneId: string, groupId: string, write: Send): () => void {
  members.set(paneId, { groupId, send: write })
  return () => {
    // Guarded so a stale teardown — the pane already re-registered under a new
    // group — can't remove the live entry.
    if (members.get(paneId)?.send === write) members.delete(paneId)
  }
}

/** Pane ids currently registered in `groupId`, in registration order. */
export function membersOf(groupId: string): string[] {
  const ids: string[] = []
  for (const [paneId, member] of members) {
    if (member.groupId === groupId) ids.push(paneId)
  }
  return ids
}

/** How many panes would receive a broadcast to `groupId`. Drives the
 * indicator's "sending to N panes" — the affordance has to be loud, because
 * accidentally broadcasting a `reload` is a bad afternoon. */
export function size(groupId: string): number {
  return membersOf(groupId).length
}

/** Sends `data` to every pane in `groupId`, including the one it was typed
 * into. Returns how many panes received it.
 *
 * `exceptPaneId` omits one member — the caller writing to its own session
 * directly, which is how `Terminal` does it: the pane being typed into takes
 * the ordinary single-pane path for everything it produces, and broadcast
 * only ever *adds* recipients. Sending to the origin here as well would send
 * its input twice.
 *
 * Snapshotted before sending: a `send` that disconnects its own pane would
 * otherwise mutate the map mid-iteration. */
export function send(groupId: string, data: Uint8Array, exceptPaneId?: string): number {
  const targets: Send[] = []
  for (const [paneId, member] of members) {
    if (member.groupId === groupId && paneId !== exceptPaneId) targets.push(member.send)
  }
  for (const target of targets) target(data)
  return targets.length
}

/** Test seam only — the registry is module state, so a test that registers
 * panes has to be able to clear them again. */
export function reset(): void {
  members.clear()
}
