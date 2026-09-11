import { useEffect, useRef, useState } from 'react'
import {
  Plus,
  X,
  RotateCw,
  Copy,
  Terminal as TerminalIcon,
  Radio,
  Cable,
  TerminalSquare,
  CircleDashed,
  Laptop,
  ShieldCheck,
} from 'lucide-react'
import { glyphForShell, glyphForShellId } from './shellIconFor'
import { LocalShellIcon } from './LocalShellIcon'
import type { PaneNode, Tab } from '../types'
import type { AppProgress } from '../lib/appProgress'
import type { CommandActivity } from '../lib/shellIntegration'
import { allLeaves, verticalRows } from '../lib/paneTree'
import { DRAG_TAB_MIME, DRAG_PANE_MIME } from '../lib/dragTypes'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  statusByPane: Record<string, string>
  /** Per-pane command state from shell integration — a tab spins while any
   * of its panes has a command running. */
  activityByPane: Record<string, CommandActivity>
  /** Per-pane progress a *program* reported for itself (OSC 9;4), for panes
   * that have any. Drives the same running marker as `activityByPane`, and
   * deliberately so: to the user "something is working in that pane" is one
   * fact, whoever happened to say it. The two informants cover disjoint cases
   * — the shell goes quiet exactly when a full-screen program takes over —
   * so in practice they rarely both speak at once, and either alone is enough
   * to spin the marker. All three progress states count, including `error`
   * and `paused`: each still means a program is there and hasn't finished. */
  progressByPane: Record<string, AppProgress>
  /** Panes holding something the user hasn't seen yet: a bell rang, or a long
   * command finished, while the tab was in the background. Keyed by pane, not
   * tab, so the marker can sit on the segment of the pane it happened in. */
  attentionPanes: Record<string, true>
  /** Titles the far ends set for themselves (OSC 0/2), for panes that have
   * one. Used only for the tab's tooltip: the visible label stays the
   * connection's, so a shell that retitles itself on every prompt can't
   * rename what you are looking at — or reflow the strip, since tab width is
   * content-driven. See lib/remoteIdentity.ts. */
  titleByPane: Record<string, string>
  /** The colour the terminal beneath is painted, ready to use as a CSS
   * background. The active tab takes it exactly, so the tab and the pane it
   * opens onto are one surface and the strip is the only thing separating
   * them — which is the whole point of a tab. Passed in rather than resolved
   * here because it follows the chosen theme and the window's background
   * opacity, neither of which the strip otherwise knows about. */
  paneBackground: string
  /** The layer a quiet tab lays over `paneBackground` under the pointer, to
   * land midway between the strip and the active tab. Comes from the same
   * place `paneBackground` does, and for the same reason: it is measured
   * from the theme, which the strip has no way to see. */
  tabHoverWash: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onDuplicate: (id: string) => void
  onReconnect: (id: string) => void
  onReorder: (draggedId: string, targetId: string) => void
  onDropPaneAsNewTab: (tabId: string, paneId: string) => void
}

const protocolIcons = {
  ssh: TerminalIcon,
  sshProfile: TerminalIcon,
  telnet: Radio,
  serial: Cable,
  serialProfile: Cable,
  local: Laptop,
  localProfile: Laptop,
  elevated: Laptop,
}

/** Separation between segments in the tab strip's pane map, in px. */
const PANE_MAP_GAP_PX = 2

/** Thickness of one segment. Every leaf gets exactly this whatever the
 * layout, so the bar reads as one consistent object — a lone pane and each
 * row of a four-way stack are all the same 2px line. */
const PANE_MAP_SEGMENT_PX = 2

/** Ceiling on how tall the bar may grow. Four rows is already 14px of a
 * 40px tab strip; past that the map stops being a glanceable hint and starts
 * eating the tab.
 *
 * MAX_PANE_ROWS is set to match, so it only binds for a workspace saved by a
 * build that predates the split limits. Such a tree divides
 * the capped height evenly instead, giving segments thinner than
 * PANE_MAP_SEGMENT_PX — the right failure for a case that can no longer be
 * created. */
const PANE_MAP_MAX_ROWS = 4

/** Keeps the quarter of a corner fillet that is nearest the tab and drops
 * the rest — see where it is used. `centre` is the corner of the 8px box
 * the arc is struck from: the top-left for the fillet on the tab's left,
 * the top-right for the one on its right. */
function filletMask(centre: string): { WebkitMaskImage: string; maskImage: string } {
  const mask = `radial-gradient(circle at ${centre}, transparent 7.5px, #000 8.5px)`
  return { WebkitMaskImage: mask, maskImage: mask }
}

/** Gap between the top of the tab and the pane map, in px. The map used to
 * sit flush against the edge, which on a square corner was simply where the
 * tab began — but a rounded tab reads as an object with a lip, and a line
 * pinned to the very edge of one looks stuck to it rather than placed on it.
 * Small on purpose: two pixels is enough for the tab's own fill to show above
 * the bar and give it a top edge to sit against, without it starting to look
 * like a detached rule floating in the tab. */
const PANE_MAP_TOP_PX = 2

/** Shaved off the clearance the tab's contents keep below the pane map.
 * Centring them strictly under the map is safe but sits them low — the space
 * beneath reads as bigger than the gap above, because the map is a thin line
 * rather than a solid block. Lifting them raises the row by half this (the
 * remaining height is centred, so it splits the difference), which is enough
 * to look balanced while staying clear of the map. Also returns an unsplit
 * tab to exactly the centring it had before any of this, since its 2px map
 * needs no clearance at all. */
const PANE_MAP_CONTENT_LIFT_PX = 4

/** Height a branch of `rows` stacked rows needs: one segment each plus the
 * gaps between them. Used for the bar itself and, recursively, for each
 * stacked child of a split — which is what makes every leaf land on exactly
 * one segment's thickness however deeply it's nested. */
function paneMapExtent(rows: number): number {
  return rows * PANE_MAP_SEGMENT_PX + (rows - 1) * PANE_MAP_GAP_PX
}

/** Mirrors a tab's pane tree as nested flex rows/columns (row for a
 * horizontal split, column for a vertical one) — so a stacked split renders
 * as stacked segments here too, instead of every split flattening into
 * left-right slices regardless of its real direction.
 *
 * Arrangement only: segments are equal, not scaled to each split's real
 * `sizes`. This is a glanceable "how many panes, grouped how", and at a
 * couple of pixels there isn't the resolution for ratios to say anything a
 * viewer could read — they only made lopsided splits render a sibling as an
 * invisible sliver. `activePaneId` of `null` means this tab itself isn't
 * focused: every leaf renders the same dim tone rather than highlighting
 * one, since there's no meaningful "focused pane" to call out from outside
 * the tab that's actually showing it. */
function PaneIndicator({
  node,
  activePaneId,
  runningPaneIds,
  attentionPaneIds,
  exact,
}: {
  node: PaneNode
  activePaneId: string | null
  runningPaneIds: Set<string>
  attentionPaneIds: Set<string>
  /** Whether the bar was given the full height this tree asks for, and so
   * whether stacked children can be sized in whole segments. False only for
   * a tree past PANE_MAP_MAX_ROWS, where they fall back to dividing the
   * capped height evenly — thin, but it stays inside the bar. */
  exact: boolean
}) {
  if (node.type === 'leaf') {
    const focused = activePaneId === node.id
    const running = runningPaneIds.has(node.id)
    // Running wins if a pane somehow has both — it's the live state, and a
    // bell that rang mid-command is stale news by comparison.
    const attention = !running && attentionPaneIds.has(node.id)
    return (
      <span
        className={`relative block h-full w-full overflow-hidden ${
          focused ? 'bg-sky-400' : 'bg-sky-400/30'
        }`}
      >
        {running && (
          // Travels across this leaf's own segment, so in a split the map
          // shows *which* pane is working rather than just that the tab is.
          // Red on the sky-toned bar is the highest-contrast pairing
          // available here, and it stays equally legible over the focused
          // (full sky) and unfocused (30%) tones — a lighter tint of the
          // bar's own colour washed out against the focused one.
          //
          // Fixed 28px rather than a fraction of the segment: proportional
          // meant the marker changed size with the split layout and the tab
          // title's length, which read as a different indicator each time.
          // max-w-full keeps it inside segments narrower than that (a
          // four-way split on a minimum-width tab), where it simply stops
          // travelling rather than overflowing.
          //
          // Gradient rather than a solid fill so the edges fall off and it
          // reads as a light passing behind the bar instead of a brick
          // sliding along it. A glow would be nicer still, but the segment
          // clips its own overflow, so any box-shadow dies at the edge.
          <span className="animate-pane-run absolute inset-y-0 left-0 w-7 max-w-full bg-gradient-to-r from-transparent via-red-500 to-transparent" />
        )}
        {attention && (
          // The same marker at rest: parked mid-segment, amber, breathing.
          // Deliberately the same shape and size as the running one so the
          // two read as one indicator changing state rather than two
          // unrelated marks — it stops travelling, settles in the middle and
          // changes colour, which is legible at a glance without needing a
          // separate widget elsewhere on the tab.
          <span className="animate-pane-glow absolute inset-y-0 left-1/2 w-7 max-w-full -translate-x-1/2 bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
        )}
      </span>
    )
  }
  const horizontal = node.direction === 'horizontal'
  return (
    // overflow-hidden: children's flexBasis percentages sum to 100% of this
    // row on their own, on top of which the gap below adds further width
    // that flexGrow/flexShrink:0 can't absorb — so each split level
    // genuinely overflows its own box by (children - 1) * 2px. Left
    // unclipped, that bleeds outward through every ancestor (invisibly,
    // since it's solid same-toned overflow) and was inflating the real tab
    // strip's scrollWidth enough, after a second nested split, to trip the
    // overflow-fade check below even with nothing actually clipped.
    <span
      // No fill: the gaps show the tab's own background, which is dark on
      // every tab now — the strip's tone on a quiet one, the terminal's on
      // the active one — so the space between two segments reads as a line
      // either way. This carried a hardcoded dark fill back when the active
      // tab was a lightened tint and the gaps would otherwise have vanished
      // into it, leaving the segments as one continuous bar.
      className={`flex h-full w-full overflow-hidden ${
        horizontal ? 'flex-row' : 'flex-col'
      }`}
      style={{ gap: `${PANE_MAP_GAP_PX}px` }}
    >
      {node.children.map((child) => (
        <span
          key={child.id}
          // Stacked children are sized by the number of rows they actually
          // contain, not split evenly. Even division is only right when both
          // branches hold the same number of rows: for `vertical{ A,
          // vertical{ B, C } }` it hands the lone pane and the nested pair
          // half the height each, so A draws at full thickness while B and C
          // share what's left and come out at 1px.
          //
          // The arithmetic is exact rather than proportional. A branch of n
          // rows needs n segments plus the n-1 gaps between them, and
          // summed over the children that equals the parent's own height by
          // construction — so every leaf lands on exactly one segment's
          // thickness at any nesting depth, with nothing left over to clip.
          //
          // Side-by-side children need none of this: they divide width,
          // which carries no row information, so they just share it evenly.
          style={
            horizontal || !exact
              ? undefined
              : {
                  flexBasis: `${paneMapExtent(verticalRows(child))}px`,
                  flexGrow: 0,
                  flexShrink: 0,
                }
          }
          // The cross-axis size is explicit rather than left to flexbox's
          // default stretch: without it two segments meant to match on that
          // axis can come out very slightly, but visibly, mismatched at
          // this scale.
          className={`min-h-0 min-w-0 ${
            horizontal ? 'h-full flex-1' : `w-full ${exact ? '' : 'flex-1'}`
          }`}
        >
          <PaneIndicator
            node={child}
            activePaneId={activePaneId}
            runningPaneIds={runningPaneIds}
            attentionPaneIds={attentionPaneIds}
            exact={exact}
          />
        </span>
      ))}
    </span>
  )
}

/** The badge on the corner of a tab's protocol icon, or null for no badge.
 *
 * `isLocal` suppresses the connected state. Green means "the link is up", and
 * a local shell has no link: the process is either running — in which case the
 * pane exists at all — or gone, in which case the pane closes itself. A green
 * dot there restates the tab's own existence, and the Laptop protocol icon it
 * would be badged onto already says the session is local.
 *
 * The other states still earn a badge, and are the reason this is not simply
 * "no dot for local": a shell that fails to start leaves its pane open with
 * the reason on screen (see `isCleanDisconnect`), and a red corner is exactly
 * how that should read from another tab. */
function statusDotColor(status: string | undefined, isLocal = false): string | null {
  if (!status) return null
  if (status === 'connected') return isLocal ? null : 'bg-emerald-400'
  // `lost` joins the red states rather than the amber in-flight ones: the
  // session is down. A reconnect following it goes amber like any other
  // not-connected-yet state, which is what it is.
  if (status.startsWith('failed') || status === 'disconnected' || status === 'lost') {
    return 'bg-red-400'
  }
  return 'bg-amber-400'
}

export function TabBar({
  tabs,
  activeTabId,
  statusByPane,
  activityByPane,
  progressByPane,
  attentionPanes,
  titleByPane,
  paneBackground,
  tabHoverWash,
  onSelect,
  onClose,
  onNew,
  onDuplicate,
  onReconnect,
  onReorder,
  onDropPaneAsNewTab,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // Which tab the pointer is over. `:hover` alone can't express the rule the
  // separators need — a divider has to vanish when *either* tab it sits
  // between is hovered, and CSS gives a tab no way to reach its own left-hand
  // neighbour. Knowing the hovered id outright states the rule directly.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [paneDragOver, setPaneDragOver] = useState(false)
  const tabsContainerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // Only fade the tabs container's right edge once it's actually
  // scrollable — otherwise every tab fits and there's nothing partially
  // clipped for the fade to hide, so it'd just needlessly dim the last tab.
  // A ResizeObserver (rather than just watching `tabs`) also catches the
  // window itself being resized narrower/wider with the same tab count.
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el) return
    // >1 (not >0): scrollWidth rounds up and clientWidth rounds down from
    // the same fractional layout independently, so a container that's
    // genuinely fully visible can still come out exactly 1px "over" —
    // e.g. revealing the split-pane action icons shifts things by a
    // fraction of a pixel with nothing actually clipped. That's not
    // scrollable, just rounding noise; only a real gap should fade it.
    const checkOverflow = () => setOverflowing(el.scrollWidth - el.clientWidth > 1)
    checkOverflow()
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs])

  // The pane map is a header inside each tab, so the tab's own contents sit
  // below it and centre in whatever height is left. Without this a four-row
  // map (14px of a 40px strip) runs straight into the protocol glyph and the
  // title, which are otherwise centred in the full height.
  //
  // Measured once across the whole strip rather than per tab: map height
  // varies with each tab's layout, and letting every tab place its own title
  // accordingly would leave neighbouring titles on visibly different
  // baselines. One clearance for the tallest map on screen keeps the row of
  // titles an actual row. The logo and "+" button aren't tabs and have no map
  // above them, so they stay centred in the full strip.
  const stripRows = Math.min(
    tabs.reduce((most, t) => Math.max(most, verticalRows(t.root)), 1),
    PANE_MAP_MAX_ROWS,
  )
  const tabContentTopPx = Math.max(
    0,
    PANE_MAP_TOP_PX + paneMapExtent(stripRows) - PANE_MAP_CONTENT_LIFT_PX,
  )

  return (
    <div
      className={`relative flex min-w-0 shrink items-stretch transition-colors duration-100 ${
        paneDragOver ? 'bg-sky-400/10' : ''
      }`}
      // Drop target for a pane dragged out of a split (see the grip in
      // Pane.tsx) — anywhere on the tab strip works, not just onto an
      // existing tab, since the point is to create a *new* one.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_PANE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setPaneDragOver(true)
      }}
      onDragLeave={() => setPaneDragOver(false)}
      onDrop={(e) => {
        setPaneDragOver(false)
        const raw = e.dataTransfer.getData(DRAG_PANE_MIME)
        if (!raw) return
        e.preventDefault()
        const { tabId, paneId } = JSON.parse(raw) as { tabId: string; paneId: string }
        onDropPaneAsNewTab(tabId, paneId)
      }}
    >
      {/* Also gives the tab strip natural clearance from the window's
       * rounded corner, replacing what used to just be an empty sliver of
       * padding. */}
      {/* A handle for the window, like the spacer after the tabs: the icon is
       * the one thing at this end of the strip that is not a tab. `deep` so a
       * press on the glyph itself counts, not only on the padding around it. */}
      <div
        data-tauri-drag-region="deep"
        onDoubleClick={() => getCurrentWindow().toggleMaximize()}
        className="flex shrink-0 items-center pl-2.5 pr-1.5 text-[#b7410e]"
      >
        <TerminalSquare size={16} strokeWidth={2} />
      </div>
      {/* The gap above the tabs (their `mt-1`) is a handle too, across the
       * whole strip — what Chrome leaves above its tabs for the same reason.
       * It covers only that gap, so it takes no clicks from the tabs. */}
      <div
        aria-hidden
        data-tauri-drag-region
        onDoubleClick={() => getCurrentWindow().toggleMaximize()}
        className="absolute inset-x-0 top-0 z-20 h-1"
      />
      {/* The fade mask (not just a visual flourish) keeps a tab that's only
       * partially scrolled into view from ending in a harsh mid-content
       * clip — one that, at just the wrong container width, would slice
       * straight through that tab's close button and leave half of it
       * rendered. Only applied once `overflowing` is actually true — with
       * every tab fully visible there's nothing partially clipped for it
       * to hide, so it'd just needlessly dim the last tab. */}
      <div
        ref={tabsContainerRef}
        // The fade above is the intended overflow affordance — the native
        // scrollbar this row would otherwise grow underneath it (styled
        // 10px tall in index.css) doesn't fit a 40px tab strip, and shows
        // up even for the ~1px subpixel-rounding gaps that aren't real
        // overflow at all. Wheel/trackpad scrolling still works with it
        // hidden; only the visible bar is gone.
        // `px-2` reserves the width the first and last tabs' fillets hang
        // into, which they need for opposite reasons. The fillets are
        // absolutely positioned outside their tab, and at the end an
        // out-of-flow descendant still counts towards a scroll container's
        // scrollable overflow — so on the last tab it added 8px the
        // container could not show, and the check below called a strip that
        // fits exactly overflowing and faded its own last tab. At the start
        // there is no scrollable overflow to be had at all: content before
        // the content edge is simply clipped, so the first tab's left
        // shoulder was cut off square. Padding answers both, being inside
        // clientWidth at one end and inside the content box at the other.
        className="tab-strip-scroll flex min-w-0 shrink items-stretch overflow-x-auto px-2"
        style={
          overflowing
            ? {
                WebkitMaskImage:
                  'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
                maskImage: 'linear-gradient(to right, black calc(100% - 24px), transparent 100%)',
              }
            : undefined
        }
      >
        {tabs.map((tab, i) => {
          const soleTab = tabs.length === 1
          const active = tab.id === activeTabId
          // A hairline between two adjacent *quiet* tabs, and nowhere else.
          // Both the active tab and a hovered one draw their own shape, and a
          // line running into the side of one of those is exactly the defect
          // the rounding was meant to avoid — so the two dividers touching
          // such a tab are the ones that go. Drawn on the left edge, so it
          // belongs to the boundary before this tab and the first tab has
          // none.
          const separator =
            i > 0 &&
            !active &&
            tabs[i - 1].id !== activeTabId &&
            hoveredId !== tab.id &&
            hoveredId !== tabs[i - 1].id
          const leaves = allLeaves(tab.root)
          const trueRows = verticalRows(tab.root)
          const rows = Math.min(trueRows, PANE_MAP_MAX_ROWS)
          const leaf = leaves.find((l) => l.id === tab.activePaneId)
          // A local pane is named by its *shell*, not by its transport. Five
          // local sessions all showing the same laptop is the case this
          // exists for; the generic icon stays as the fallback for a shell
          // nothing recognises.
          const src = leaf?.source
          const shellGlyph =
            src?.protocol === 'local'
              ? glyphForShell(src.config)
              : src?.protocol === 'localProfile' || src?.protocol === 'elevated'
                ? glyphForShellId(src.shellId)
                : null
          const ProtocolIcon = src ? protocolIcons[src.protocol] : null
          const elevated = src?.protocol === 'elevated'
          const isLocal =
            src?.protocol === 'local' || src?.protocol === 'localProfile' || elevated
          const dotColor = leaf ? statusDotColor(statusByPane[leaf.id], isLocal) : null
          const runningPaneIds = new Set(
            leaves
              .filter((l) => activityByPane[l.id]?.state === 'running' || progressByPane[l.id])
              .map((l) => l.id),
          )
          const attentionPaneIds = new Set(leaves.filter((l) => attentionPanes[l.id]).map((l) => l.id))
          const running = runningPaneIds.size > 0
          const attention = attentionPaneIds.size > 0
          const remoteTitle = leaf ? titleByPane[leaf.id] : undefined
          return (
            <div
              key={tab.id}
              title={remoteTitle ? `${tab.title} — ${remoteTitle}` : tab.title}
              // With one tab there is nothing to reorder it past and no other
              // tab to drop it into, so dragging it moves the window instead —
              // what Chrome does with a lone tab. Its close button still
              // closes it, and right-click still opens its menu.
              draggable={!soleTab}
              onMouseDown={(e) => {
                if (!soleTab || e.button !== 0) return
                if (e.target instanceof Element && e.target.closest('button')) return
                void getCurrentWindow().startDragging()
              }}
              onDoubleClick={(e) => {
                if (!soleTab) return
                if (e.target instanceof Element && e.target.closest('button')) return
                void getCurrentWindow().toggleMaximize()
              }}
              onClick={() => onSelect(tab.id)}
              onMouseEnter={() => setHoveredId(tab.id)}
              onMouseLeave={() => setHoveredId((id) => (id === tab.id ? null : id))}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })
              }}
              onDragStart={(e) => {
                setDraggedId(tab.id)
                e.dataTransfer.effectAllowed = 'move'
                // Lets an empty pane elsewhere in the window (a totally
                // separate drop target from the other tabs here) recognize
                // this as "a tab being dragged," to attach its connection
                // there — see DRAG_TAB_MIME.
                e.dataTransfer.setData(DRAG_TAB_MIME, tab.id)
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setDropTargetId(null)
              }}
              onDragOver={(e) => {
                // A pane being dragged out of a split (see the grip in
                // Pane.tsx) has no `draggedId` of its own — that's only
                // tracked for *tab* reordering — so without this check,
                // hovering directly over an existing tab (rather than the
                // strip's empty space) never calls preventDefault() here
                // and the browser shows a "not allowed" cursor despite the
                // container's own handler being able to accept it.
                if (e.dataTransfer.types.includes(DRAG_PANE_MIME)) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  return
                }
                if (!draggedId || draggedId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTargetId(tab.id)
              }}
              onDragLeave={() => setDropTargetId((id) => (id === tab.id ? null : id))}
              onDrop={(e) => {
                const rawPane = e.dataTransfer.getData(DRAG_PANE_MIME)
                if (rawPane) {
                  e.preventDefault()
                  const { tabId, paneId } = JSON.parse(rawPane) as { tabId: string; paneId: string }
                  onDropPaneAsNewTab(tabId, paneId)
                  return
                }
                e.preventDefault()
                if (draggedId) onReorder(draggedId, tab.id)
                setDraggedId(null)
                setDropTargetId(null)
              }}
              style={{
                paddingTop: `${tabContentTopPx}px`,
                // Both skipped while this tab is the drop target, so the sky
                // wash marking it as such isn't painted over by an inline
                // fill. Hover is driven from `hoveredId` rather than a
                // `hover:` class because what it paints is a colour computed
                // from the theme, not one Tailwind can name.
                ...(dropTargetId === tab.id
                  ? {}
                  : active
                    ? { backgroundColor: paneBackground }
                    : hoveredId === tab.id
                      ? { backgroundColor: paneBackground, backgroundImage: tabHoverWash }
                      : {}),
              }}
              // Only one tab is a shape: the active one. It takes the
              // window's own corner radius (`rounded-t-lg` — see the root
              // element in App.tsx) so the tab and the frame it sits in read
              // as the same object, and the terminal's own background as its
              // fill, so its lower edge doesn't exist: the tab is the top of
              // the pane, drawn up into the strip. A lighter tint stood it off
              // the strip just as well but made it a third surface, neither
              // strip nor pane. The rest carry no fill at all, which leaves
              // them the strip's own tone, and no radius — a row of
              // identically rounded tabs spends the shape on every tab and so
              // says nothing with it, whereas rounding exactly one is what
              // makes that one look like the sheet in front. Chrome and Edge
              // both settled here.
              //
              // Hovering an inactive tab lends it the same shape and a fill
              // partway to the active one's, so the thing under the pointer is
              // legible as a target without being mistaken for the selection.
              // Partway *towards* it: this was a white wash, which on a dark
              // theme moved a hovered tab lighter than the strip while the
              // tab it was reaching for is darker — the wrong direction, and
              // the reason it needs a computed colour rather than a class.
              //
              // `mt-1` drops every tab clear of the window's top edge: a tab
              // whose corner starts in the same pixel row as the frame's has
              // its rounding read as part of the frame, and the gap is what
              // makes it a separate object sitting in the strip. Kept on the
              // square tabs too, so activating one raises a shape in place
              // rather than also shifting the row.
              className={`group relative mt-1 flex min-w-[130px] max-w-[200px] cursor-pointer items-center gap-2 px-3 text-xs transition-colors duration-150 ${
                active
                  ? 'z-10 rounded-t-lg text-chrome'
                  : 'text-chrome/45 hover:rounded-t-lg hover:text-chrome/80'
              } ${draggedId === tab.id ? 'opacity-40' : ''} ${
                dropTargetId === tab.id && draggedId !== tab.id ? 'bg-sky-400/10' : ''
              }`}
            >
              {separator && (
                <span className="pointer-events-none absolute inset-y-2 left-0 w-px bg-chrome/10" />
              )}
              {/* The tab's bottom corners, flared outwards into the strip
                  instead of stopping square — the join a browser tab makes
                  with the page it belongs to, and Windows Terminal with its
                  terminal. Without them the active tab meets the pane in two
                  right angles, which reads as a rectangle overlapping the
                  strip rather than as the top of the surface below.
                  Deliberately absent while a tab is merely hovered: that
                  shape is a floating highlight, not something joined to
                  anything.

                  A corner CSS cannot round directly — the curve is convex
                  from the pane's side, and border-radius only ever cuts
                  inwards. So each is a square of pane colour with the
                  quarter disc nearest the tab's own corner masked out of it,
                  leaving exactly the part that should stay: full height
                  against the tab, nothing at all a radius away.

                  Masked rather than overpainted. Painting the strip back
                  over the rest of the square is the same shape and antialiases
                  a little more crisply, but it is 8px of opaque strip laid on
                  top of whatever is actually there — which on the tab next
                  door, while the pointer is over it, is its hover fill: a
                  small wrong-coloured box beside the shoulder. Masking leaves
                  that ground untouched.

                  The two-pixel ramp either side of the radius is what does
                  the antialiasing; a hard stop leaves the arc visibly
                  stepped. */}
              {active && dropTargetId !== tab.id && (
                <>
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -left-2 bottom-0 h-2 w-2"
                    style={{ background: paneBackground, ...filletMask('0 0') }}
                  />
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -right-2 bottom-0 h-2 w-2"
                    style={{ background: paneBackground, ...filletMask('100% 0') }}
                  />
                </>
              )}
              {/* A single-pane tab only shows this bar when it's the active
                  tab — plain and full-bright, same as before. A split tab
                  always shows it (even unfocused), dimmed, purely to signal
                  "this tab has multiple panes" at a glance; the active
                  tab's own split additionally highlights whichever pane has
                  keyboard focus. */}
              {/* `running`/`attention` are in the condition so a single-pane
                  background tab — which otherwise draws no bar at all — still
                  gets one to carry the marker, since that's now the only
                  place either signal appears. */}
              {/* Sized from the number of stacked rows so every segment is
                  the same 2px line whatever the layout — side-by-side ones
                  each take the bar's full height, stacked ones divide it, so
                  the bar has to grow to fit them plus their gaps. A flat
                  height gave a nested stack two 0.5px lines, i.e. nothing
                  visible at all. */}
              {(active || leaves.length > 1 || running || attention) && (
                // Held clear of the tab's rounded top corners rather than
                // clipped by them. `left/right-2` is the corner radius
                // exactly, which is where the curve meets the top edge — run
                // full width and the curve would slice this 2px bar
                // diagonally right where the radius is widest, tapering its
                // ends away over a few pixels instead of ending them. The
                // wrapper's own small radius then caps what's left, so the bar
                // reads as a deliberate shortened line rather than one that
                // ran out of tab. Kept at the same inset on the square tabs,
                // which need no clearance: matching them to their own corners
                // would grow and shrink the bar as tabs are activated or
                // merely hovered, and the map is meant to be read across the
                // strip, which wants every one of them the same width.
                <span
                  className="absolute left-2 right-2 overflow-hidden rounded-sm"
                  style={{ top: `${PANE_MAP_TOP_PX}px`, height: `${paneMapExtent(rows)}px` }}
                >
                  <PaneIndicator
                    node={tab.root}
                    activePaneId={active ? tab.activePaneId : null}
                    runningPaneIds={runningPaneIds}
                    attentionPaneIds={attentionPaneIds}
                    exact={trueRows <= PANE_MAP_MAX_ROWS}
                  />
                </span>
              )}
              {dropTargetId === tab.id && draggedId !== tab.id && (
                <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-sky-400" />
              )}
              {/* No spinner here any more: the running marker on the pane map
                  above says the same thing and says *where*, so a second
                  indicator in this slot was redundant and cost the icon that
                  tells you the protocol. The connection dot rides on the icon
                  so link state stays readable alongside it.

                  Always rendered, falling back to a placeholder when the
                  focused pane has no connection yet. Splitting a pane focuses
                  the new empty one, and a slot that came and went as you
                  clicked between a connected pane and a fresh one re-flowed
                  the title and resized the tab itself — tab width is
                  content-driven between its min and max, so 12px of icon plus
                  its gap moved the whole thing. */}
              <span
                className={`relative shrink-0 ${ProtocolIcon || shellGlyph ? 'text-chrome/40' : 'text-chrome/20'}`}
              >
                {shellGlyph ? (
                  <LocalShellIcon glyph={shellGlyph} size={12} />
                ) : ProtocolIcon ? (
                  <ProtocolIcon size={12} />
                ) : (
                  <CircleDashed size={12} />
                )}
                {dotColor && (
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-[#1a1b22] transition-colors duration-300 ${dotColor}`}
                  />
                )}
              </span>
              {/* Decision 5 of docs/ELEVATED_TABS_PLAN.md: the tab running
                  as administrator is never in doubt. Beside the shell's own
                  icon rather than instead of it, and in amber rather than the
                  quiet chrome grey, because it is the one tab worth noticing
                  from across the strip. */}
              {elevated && (
                <span title="Administrator" className="-ml-0.5 shrink-0 text-amber-400">
                  <ShieldCheck size={12} aria-label="Administrator" />
                </span>
              )}
              <span className="truncate">{tab.title}</span>
              {/* Always visible on the active tab, hover-revealed on the rest.
               *
               * Hover-gating it everywhere made it unreliable to click, and not
               * because of hit-testing — an `opacity-0` button still takes
               * clicks. The problem is that you cannot aim at what you cannot
               * see. Cancelling a confirmation is the clearest case: while the
               * dialog is up its overlay is what the pointer is over, so the
               * tab beneath is not hovered, and the browser does not re-evaluate
               * `:hover` until the pointer *moves*. Cancel, go straight back to
               * the ✕, and it is invisible — hit it and the tab closes, miss by
               * a few pixels and you land on the tab body, which re-selects an
               * already-active tab and looks like the click did nothing.
               *
               * The active tab is the one most likely to be closed, and showing
               * its ✕ unconditionally is also what Edge and Windows Terminal do.
               * `p-1` over `p-0.5` for the same reason: 13px of icon is a small
               * target to hit twice. */}
              <button
                aria-label={`Close ${tab.title}`}
                data-tab-close
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(tab.id)
                }}
                className={`ml-auto shrink-0 rounded p-1 text-chrome/40 transition-opacity duration-150 hover:bg-chrome/10 hover:text-chrome ${
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        onClick={onNew}
        className="flex shrink-0 items-center justify-center px-3 py-2 text-chrome/45 transition-colors duration-150 hover:bg-chrome/[0.06] hover:text-chrome"
        title="New connection (Ctrl+Shift+T)"
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {menu && (
        <div
          className="animate-in fade-in zoom-in-95 fixed z-50 w-36 origin-top-left rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
            onClick={() => {
              onReconnect(menu.tabId)
              setMenu(null)
            }}
          >
            <RotateCw size={13} /> Reconnect
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10"
            onClick={() => {
              onDuplicate(menu.tabId)
              setMenu(null)
            }}
          >
            <Copy size={13} /> Duplicate
          </button>
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors duration-100 hover:bg-chrome/10"
            onClick={() => {
              onClose(menu.tabId)
              setMenu(null)
            }}
          >
            <X size={13} /> Close
          </button>
        </div>
      )}
    </div>
  )
}
