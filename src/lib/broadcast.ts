/** Input fan-out: type once, send to every connected pane in a group (like
 * SuperPuTTY's "Send Commands to all sessions"). `usePanePortals` keeps every
 * pane's `Terminal` mounted, so hidden panes still have live writers.
 *
 * A module-level registry rather than React state: the consumer is
 * `Terminal`'s `onData` handler inside the connection effect, which mustn't
 * re-run (tearing down the session) when another pane joins or leaves.
 *
 * The group id is the tab id; a pane dragged to another tab re-registers. */

/** Sends bytes to one pane's session. Errors are swallowed at the source, so
 * one failed pane doesn't stop the others. */
export type Send = (data: Uint8Array) => void

interface Member {
  groupId: string
  send: Send
}

const members = new Map<string, Member>()

/** Registers `paneId` in `groupId` and returns the unregister function.
 * Re-registering replaces the entry, which is how a moved pane changes
 * group. */
export function join(paneId: string, groupId: string, write: Send): () => void {
  members.set(paneId, { groupId, send: write })
  return () => {
    // Guarded so a stale teardown can't remove a re-registered entry.
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

/** How many panes a broadcast to `groupId` reaches, for the loud "sending to
 * N panes" indicator. */
export function size(groupId: string): number {
  return membersOf(groupId).length
}

/** Sends `data` to every pane in `groupId`; returns how many received it.
 *
 * `exceptPaneId` omits the origin, which `Terminal` writes to directly, so
 * broadcast only adds recipients. Members are snapshotted first, in case a
 * send disconnects its own pane. */
export function send(groupId: string, data: Uint8Array, exceptPaneId?: string): number {
  const targets: Send[] = []
  for (const [paneId, member] of members) {
    if (member.groupId === groupId && paneId !== exceptPaneId) targets.push(member.send)
  }
  for (const target of targets) target(data)
  return targets.length
}

/** Test seam: clears the module-level registry. */
export function reset(): void {
  members.clear()
}
