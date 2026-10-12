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
import { titleBadge } from '../lib/titleBadge'
import { getCurrentWindow } from '@tauri-apps/api/window'

interface Props {
  tabs: Tab[]
  activeTabId: string | null
  statusByPane: Record<string, string>
  /** Per-pane shell-integration state; a pane's marker runs while a command
   * runs. */
  activityByPane: Record<string, CommandActivity>
  /** Per-pane progress a program reported itself (OSC 9;4). Drives the same
   * running marker as `activityByPane` (the shell goes quiet when a full-screen
   * program takes over). Every progress state counts, including `error` and
   * `paused`. */
  progressByPane: Record<string, AppProgress>
  /** Panes with something unseen (a bell, a finished command); keyed by pane so
   * the marker sits on that pane's segment. */
  attentionPanes: Record<string, true>
  /** Titles the far ends set (OSC 0/2). Tooltip only: the label stays the
   * connection's, so a remote program can't rename or reflow the tab. See
   * lib/remoteIdentity.ts. */
  titleByPane: Record<string, string>
  /** The terminal's background color. The active tab takes it exactly, so tab
   * and pane read as one surface. Passed in because it depends on the theme and
   * window opacity. */
  paneBackground: string
  /** The wash a hovered quiet tab lays over `paneBackground`, landing between
   * the strip and the active tab. Computed from the theme. */
  tabHoverWash: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** The new-tab button's tooltip, naming its shortcut as currently bound. */
  newTabTitle?: string
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

/** Thickness of one segment; every leaf gets exactly this. */
const PANE_MAP_SEGMENT_PX = 2

/** Ceiling on how tall the bar may grow (matches MAX_PANE_ROWS). Only a
 * workspace from before the split limits can exceed it; its segments then
 * divide the capped height evenly. */
const PANE_MAP_MAX_ROWS = 4

/** Masks a corner fillet down to the quarter nearest the tab. `centre` is the
 * corner of the 8px box the arc is struck from. */
function filletMask(centre: string): { WebkitMaskImage: string; maskImage: string } {
  const mask = `radial-gradient(circle at ${centre}, transparent 7.5px, #000 8.5px)`
  return { WebkitMaskImage: mask, maskImage: mask }
}

/** Gap between the top of a tab and its pane map, so the map sits on the tab
 * rather than stuck to its edge. */
const PANE_MAP_TOP_PX = 2

/** Taken off the clearance below the pane map so the tab's contents look
 * balanced (a thin map makes strict centering look low). An unsplit tab then
 * centers as if there were no map. */
const PANE_MAP_CONTENT_LIFT_PX = 4

/** Height a branch of `rows` stacked rows needs: a segment each plus the gaps,
 * so every leaf is exactly one segment thick at any depth. */
function paneMapExtent(rows: number): number {
  return rows * PANE_MAP_SEGMENT_PX + (rows - 1) * PANE_MAP_GAP_PX
}

/** Mirrors a tab's pane tree as nested flex rows and columns. Segments are
 * equal rather than scaled to real split sizes (ratios aren't readable at this
 * size). A null `activePaneId` means the tab isn't focused, so every leaf is
 * dim. */
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
  /** Whether the bar got its full height, so stacked children can be sized in
   * whole segments. False past PANE_MAP_MAX_ROWS. */
  exact: boolean
}) {
  if (node.type === 'leaf') {
    const focused = activePaneId === node.id
    const running = runningPaneIds.has(node.id)
    // Running wins over attention.
    const attention = !running && attentionPaneIds.has(node.id)
    return (
      <span
        className={`relative block h-full w-full overflow-hidden ${
          focused ? 'bg-sky-400' : 'bg-sky-400/30'
        }`}
      >
        {running && (
          // Travels across this leaf's segment so a split shows which pane is
          // working. Red reads on both bar tones; a fixed 28px width so it looks
          // the same in any layout; a gradient so it reads as a passing light.
          <span className="animate-pane-run absolute inset-y-0 left-0 w-7 max-w-full bg-gradient-to-r from-transparent via-red-500 to-transparent" />
        )}
        {attention && (
          // The same marker at rest: parked mid-segment, amber, breathing.
          <span className="animate-pane-glow absolute inset-y-0 left-1/2 w-7 max-w-full -translate-x-1/2 bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
        )}
      </span>
    )
  }
  const horizontal = node.direction === 'horizontal'
  return (
    // overflow-hidden: the gap adds width beyond the children's 100% basis,
    // which would otherwise bleed out and trip the strip's overflow check.
    <span
      // No fill: the gaps show the tab's own background as lines.
      className={`flex h-full w-full overflow-hidden ${
        horizontal ? 'flex-row' : 'flex-col'
      }`}
      style={{ gap: `${PANE_MAP_GAP_PX}px` }}
    >
      {node.children.map((child) => (
        <span
          key={child.id}
          // Stacked children are sized by how many rows they contain, so every
          // leaf is exactly one segment thick. Side-by-side children share width
          // evenly.
          style={
            horizontal || !exact
              ? undefined
              : {
                  flexBasis: `${paneMapExtent(verticalRows(child))}px`,
                  flexGrow: 0,
                  flexShrink: 0,
                }
          }
          // Explicit cross-axis size; stretch can leave visible mismatches here.
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

/** The badge on a tab's protocol icon, or null. A connected local shell gets
 * none (it has no link, and the icon already says local); failed states still
 * show red. */
function statusDotColor(status: string | undefined, isLocal = false): string | null {
  if (!status) return null
  if (status === 'connected') return isLocal ? null : 'bg-emerald-400'
  // `lost` is red (the session is down); a following reconnect is amber.
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
  newTabTitle = 'New connection',
  onDuplicate,
  onReconnect,
  onReorder,
  onDropPaneAsNewTab,
}: Props) {
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  // The hovered tab, so the separators on either side of it can hide (CSS
  // can't reach a tab's left neighbor).
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

  // Fade the right edge only when the strip actually scrolls. A
  // ResizeObserver also catches window resizes.
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el) return
    // >1: independent rounding can report a 1px overflow that isn't real.
    const checkOverflow = () => setOverflowing(el.scrollWidth - el.clientWidth > 1)
    checkOverflow()
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabs])

  // Tab contents sit below the pane map. One clearance for the tallest map
  // on screen keeps every tab's title on the same baseline.
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
      // Accepts a pane dragged out of a split (see Pane.tsx); anywhere on the
      // strip creates a new tab.
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
      {/* A window drag handle (the one non-tab at this end), which also keeps
       * the strip clear of the window's rounded corner. `deep` so the glyph
       * itself counts. */}
      <div
        data-tauri-drag-region="deep"
        onDoubleClick={() => getCurrentWindow().toggleMaximize()}
        className="flex shrink-0 items-center pl-2.5 pr-1.5 text-[#b7410e]"
      >
        <TerminalSquare size={16} strokeWidth={2} />
      </div>
      {/* The fade mask keeps a partially scrolled tab from ending in a hard
       * clip (e.g. through its close button). Only while overflowing. */}
      <div
        ref={tabsContainerRef}
        // The native scrollbar is hidden (the fade is the affordance; wheel
        // scrolling still works). `px-2` leaves room for the first and last
        // tabs' fillets: otherwise the last one counts as overflow and the first
        // is clipped square.
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
          // A hairline between two adjacent quiet tabs only; not beside the
          // active or hovered tab, which draw their own shape.
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
          // Local panes are named by their shell's icon.
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
          // Only the leading symbol of a remote title, never the title. Prefer the
          // active pane's; otherwise any badged pane in a split.
          const badgeTitle =
            (titleBadge(remoteTitle) !== null ? remoteTitle : undefined) ??
            leaves.map((l) => titleByPane[l.id]).find((t) => titleBadge(t) !== null)
          const badge = titleBadge(badgeTitle)
          return (
            <div
              key={tab.id}
              // The badge has no words, so the tooltip explains it (including the
              // badged pane's title when it isn't the active one).
              title={[tab.title, remoteTitle, badgeTitle !== remoteTitle ? badgeTitle : undefined]
                .filter(Boolean)
                .join(' — ')}
              // A lone tab drags the window instead, like Chrome.
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
                // Lets an empty pane elsewhere accept this tab; see DRAG_TAB_MIME.
                e.dataTransfer.setData(DRAG_TAB_MIME, tab.id)
              }}
              onDragEnd={() => {
                setDraggedId(null)
                setDropTargetId(null)
              }}
              onDragOver={(e) => {
                // Accept a pane dragged out of a split here too, or the cursor shows
                // "not allowed" over a tab.
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
                // Skipped while this is the drop target. Hover uses `hoveredId` since
                // the color comes from the theme.
                ...(dropTargetId === tab.id
                  ? {}
                  : active
                    ? { backgroundColor: paneBackground }
                    : hoveredId === tab.id
                      ? { backgroundColor: paneBackground, backgroundImage: tabHoverWash }
                      : {}),
              }}
              // Only the active tab is a shape: the window's corner radius
              // (`rounded-t-lg`) and the terminal's own background, so it reads as the
              // top of the pane (as in Chrome and Edge). Quiet tabs take the strip's
              // tone. A hovered tab gets the shape and a fill partway toward the active
              // one. `mt-1` keeps every tab clear of the window's top edge.
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
              {/* The active tab's bottom corners flare into the strip, joining it
                  to the pane below (not shown on hover). CSS can't round a convex
                  corner, so each is a square of pane color with the quarter disc
                  nearest the tab masked out; masking (not overpainting) leaves a
                  neighbor's hover fill untouched. The 2px ramp antialiases the
                  arc. */}
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
              {/* The pane map: shown on the active tab, on any split tab (dimmed when
                  unfocused), and on any tab carrying a running or attention marker.
                  Its height comes from the number of stacked rows, so every segment
                  is the same 2px line. */}
              {(active || leaves.length > 1 || running || attention) && (
                // Inset by the corner radius so the rounded corners don't slice the
                // bar; the same inset on every tab keeps the maps the same width.
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
              {/* The protocol icon, with the connection dot on it. Always rendered
                  (a placeholder when unconnected) so the tab doesn't resize as focus
                  moves between panes. */}
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
              {/* The administrator tab is always marked, in amber
                  (docs/ELEVATED_TABS_PLAN.md, decision 5). */}
              {elevated && (
                <span title="Administrator" className="-ml-0.5 shrink-0 text-amber-400">
                  <ShieldCheck size={12} aria-label="Administrator" />
                </span>
              )}
              {/* The mark a program put at the front of its title, in the emoji
                  font's own colors. `aria-hidden`: the tooltip has the full title. */}
              {badge && (
                // A fixed-width box so the badge swapping between glyphs (emoji at rest,
                // spinner frames while busy) doesn't resize the tab.
                <span
                  aria-hidden
                  className="inline-flex w-[14px] shrink-0 justify-center text-[11px] leading-none"
                >
                  {badge}
                </span>
              )}
              <span className="truncate">{tab.title}</span>
              {/* Always visible on the active tab, hover-revealed on the rest (as in
               * Edge and Windows Terminal): `:hover` isn't re-evaluated until the
               * pointer moves, so after closing a dialog an invisible ✕ is hard to
               * hit. */}
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
        title={newTabTitle}
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
