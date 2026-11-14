import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from 'lucide-react'
import { glyphForShell, glyphForShellId } from './shellIconFor'
import { LocalShellIcon } from './LocalShellIcon'
import type { PaneNode, Tab } from '../types'
import type { AppProgress } from '../lib/appProgress'
import type { CommandActivity } from '../lib/shellIntegration'
import { allLeaves, verticalRows } from '../lib/paneTree'
import { DRAG_TAB_MIME, DRAG_PANE_MIME } from '../lib/dragTypes'
import { isAndroid } from '../lib/platform'
import {
  activeTabHole,
  clampOffset,
  type MaskHole,
  maxOffset,
  offsetToReveal,
  pinnedX,
  stripEdges,
  stripMask,
  type StripEdges,
} from '../lib/tabStripEdges'
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

/** The strip's overflow buttons (scroll arrows, tab list), styled like the +. */
const stripButtonClass =
  'flex shrink-0 items-center justify-center px-1.5 py-2 text-chrome/45 transition-colors duration-150 hover:bg-chrome/[0.06] hover:text-chrome disabled:pointer-events-none disabled:text-chrome/15'

/** Keeps keyboard focus in the terminal when a strip button is clicked. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

/** How long the desktop strip takes to glide to a new position. */
const STRIP_SCROLL_MS = 180

/** Width of the strip's edge fades. On the desktop the active tab also pins
 * this far in from an edge; once it does, the strip beyond it is cut clear
 * (see activeTabHole), so nothing of the tabs it has passed shows there. */
const STRIP_FADE_PX = isAndroid ? 24 : 16

/** The strip's side padding: room for the end tabs' fillets, and on the desktop
 * as wide as the fade, so the first and last tabs rest exactly where a pinned
 * tab stops and never nudge when they pin. */
const STRIP_PAD_PX = isAndroid ? 8 : STRIP_FADE_PX

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
  // Which sides have more tabs off screen; drives the fades and the arrows.
  const [edges, setEdges] = useState<StripEdges>({ left: false, right: false })
  const overflowing = edges.left || edges.right
  // The all-tabs list, anchored under its button (fixed, so the strip can't clip it).
  const [tabList, setTabList] = useState<{ right: number; top: number } | null>(null)
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const setEdgesIfChanged = (next: StripEdges) =>
    setEdges((now) => (now.left === next.left && now.right === next.right ? now : next))

  // Desktop scrolling is ours rather than the browser's: the tabs ride a track
  // moved by a transform, and the active tab is drawn over the strip by an
  // overlay (its slot on the track holds an invisible copy, so the others keep
  // their places). Every write — track, overlay, mask — happens together in
  // `layout`, in the same frame as the input or resize that caused it, so the
  // active tab never lags, jumps or pops. Native scrolling can't give that: it
  // runs off the main thread, a frame ahead of anything positioned to match it.
  // Android keeps native scrolling, for its touch momentum, and no overlay.
  const trackRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const animationRef = useRef<number | null>(null)
  const goalRef = useRef(0)

  /** The tabs on the track (or, on Android, in the scroller). */
  const tabEls = (): HTMLElement[] => {
    const parent = isAndroid ? tabsContainerRef.current : trackRef.current
    if (!parent) return []
    return Array.from(parent.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.tabId !== undefined,
    )
  }

  /** The view's width and how far the track can scroll. */
  const measure = () => {
    const els = tabEls()
    const last = els[els.length - 1]
    const content = last ? last.offsetLeft + last.offsetWidth + STRIP_PAD_PX : 0
    const view = tabsContainerRef.current?.clientWidth ?? 0
    return { els, view, max: maxOffset(content, view) }
  }

  const layout = () => {
    const viewport = tabsContainerRef.current
    if (!viewport) return
    if (isAndroid) {
      const sides = stripEdges(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth)
      setEdgesIfChanged(sides)
      const mask = stripMask(sides, STRIP_FADE_PX) ?? ''
      viewport.style.maskImage = mask
      viewport.style.webkitMaskImage = mask
      return
    }
    const track = trackRef.current
    if (!track) return
    const { els, view, max } = measure()
    const offset = clampOffset(offsetRef.current, max)
    offsetRef.current = offset
    track.style.transform = offset ? `translateX(${-offset}px)` : ''
    const sides = { left: offset > 1, right: max - offset > 1 }
    setEdgesIfChanged(sides)

    let hole: MaskHole | null = null
    const slot = els.find((el) => el.dataset.tabId === activeTabIdRef.current)
    const overlay = overlayRef.current
    if (slot && overlay) {
      const width = slot.offsetWidth
      const slotX = slot.offsetLeft - offset
      const x = max > 0 ? pinnedX(slotX, width, view, STRIP_PAD_PX) : slotX
      overlay.style.transform = `translateX(${x}px)`
      overlay.style.width = `${width}px`
      hole = activeTabHole(slotX, x, width)
    }
    const mask = stripMask(sides, STRIP_FADE_PX, hole) ?? ''
    viewport.style.maskImage = mask
    viewport.style.webkitMaskImage = mask
  }

  const stopAnimation = () => {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }

  /** Eases the desktop strip to `target`, laying out every frame. A function
   * target is re-read each frame, so a glide aimed at a tab still lands on it
   * when the strip changes size on the way (the overflow buttons appearing a
   * render after the new tab that caused them). */
  const animateTo = (target: number | (() => number)) => {
    stopAnimation()
    const aim = () => clampOffset(typeof target === 'number' ? target : target(), measure().max)
    goalRef.current = aim()
    const from = offsetRef.current
    if (typeof target === 'number' && Math.abs(goalRef.current - from) < 0.5) return
    const startedAt = performance.now()
    // The clock read here, not rAF's timestamp argument, so both ends agree
    // (jsdom's differs, and some engines' have lagged a frame).
    const step = () => {
      const t = Math.min(1, (performance.now() - startedAt) / STRIP_SCROLL_MS)
      if (typeof target !== 'number') goalRef.current = aim()
      offsetRef.current = from + (goalRef.current - from) * (1 - (1 - t) ** 3)
      layout()
      animationRef.current = t < 1 ? requestAnimationFrame(step) : null
    }
    animationRef.current = requestAnimationFrame(step)
  }
  useEffect(() => stopAnimation, [])

  // Before paint after every render: titles, tab count, the active tab or the
  // overflow buttons may all have moved things.
  useLayoutEffect(layout)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  useEffect(() => {
    if (!tabList) return
    const close = () => setTabList(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [tabList])

  // Nothing left to list once the tabs fit again.
  useEffect(() => {
    if (!overflowing) setTabList(null)
  }, [overflowing])

  // Re-check the edges whenever the tabs change; a ResizeObserver also catches
  // window resizes.
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el) return
    // Resize callbacks run after layout and before paint, so a maximize lands
    // in one frame with everything already in place.
    const observer = new ResizeObserver(() => layout())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Desktop: either wheel axis scrolls the strip (a mouse wheel is vertical,
  // a trackpad or tilt wheel horizontal). Non-passive (React's onWheel can't
  // preventDefault).
  useEffect(() => {
    const el = tabsContainerRef.current
    if (!el || isAndroid) return
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!delta || measure().max <= 0) return
      e.preventDefault()
      stopAnimation()
      // Line-mode deltas (some mice) count lines, not pixels.
      offsetRef.current += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * 40 : delta
      layout()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Brings the tab in use (picked by shortcut or from the list, or newly opened
  // at the end) back to its own slot, with its neighbors around it. On the
  // desktop it is never out of sight (it pins), but sitting at an edge apart
  // from its neighbors it reads as out of place. Measured in content
  // coordinates: the track (or Android's scroller) is `relative`, so it is the
  // tabs' offsetParent.
  const scrollActiveIntoView = () => {
    const viewport = tabsContainerRef.current
    const id = activeTabIdRef.current
    if (!viewport) return
    /** The offset showing the slot, from `offset`, measured now. */
    const reveal = (offset: number): number => {
      const { els, view } = measure()
      const slot = els.find((el) => el.dataset.tabId === id)
      if (!slot) return offset
      return offsetToReveal(slot.offsetLeft, slot.offsetLeft + slot.offsetWidth, offset, view, STRIP_FADE_PX)
    }
    if (isAndroid) {
      const left = reveal(viewport.scrollLeft)
      if (left !== viewport.scrollLeft) viewport.scrollTo?.({ left, behavior: 'smooth' })
      return
    }
    const from = offsetRef.current
    // Already showing: nothing to glide, and nothing to re-aim.
    if (reveal(from) === from) return
    // Re-measured every frame; relative to where the glide began, so the goal
    // doesn't chase the moving strip.
    animateTo(() => reveal(from))
  }
  // Not on overflow starting or stopping (a resize): the strip shouldn't move
  // by itself, and the pinned tab is in sight regardless.
  useEffect(scrollActiveIntoView, [activeTabId, tabs.length])

  // Focus landing in a pane (a click into the terminal, or the window coming
  // back) brings its tab back, after the strip was scrolled away from it with
  // the wheel or arrows. Focus inside the strip itself doesn't count, or using
  // it would snap it back.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      scrollActiveIntoView()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  /** Moves the strip most of a view toward `side`, keeping a tab of context. */
  const scrollStrip = (side: -1 | 1) => {
    const { view } = measure()
    // From the animation's goal if one is running, so quick clicks add up.
    const from = animationRef.current !== null ? goalRef.current : offsetRef.current
    animateTo(from + side * Math.max(view - 130, 130))
  }

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

  /** One tab. On the desktop the active tab is drawn twice: `slot` is its place
   * on the track, invisible and inert, keeping its neighbors where they belong;
   * `overlay` is the one seen and used, positioned by `layout`. */
  const activeIndex = tabs.findIndex((t) => t.id === activeTabId)

  const renderTab = (tab: Tab, i: number, variant: 'tab' | 'slot' | 'overlay' = 'tab') => {
    const soleTab = tabs.length === 1
    const active = tab.id === activeTabId
    const slot = variant === 'slot'
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
        inert={slot}
        aria-hidden={slot || undefined}
        // The badge has no words, so the tooltip explains it (including the
        // badged pane's title when it isn't the active one).
        title={
          slot
            ? undefined
            : [tab.title, remoteTitle, badgeTitle !== remoteTitle ? badgeTitle : undefined]
                .filter(Boolean)
                .join(' — ')
        }
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
          ...(variant === 'slot' ? { visibility: 'hidden' as const } : {}),
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
        // On the track only: what layout and scrolling measure.
        data-tab-id={variant === 'overlay' ? undefined : tab.id}
        data-active-overlay={variant === 'overlay' || undefined}
        // A phone sizes each tab to its title and scrolls, rather than shrinking
        // every tab until no title can be read. The overlay fills the width
        // `layout` measured off the slot.
        className={`group relative mt-1 flex ${
          isAndroid ? 'min-w-[72px] shrink-0' : variant === 'overlay' ? 'min-w-0 flex-1' : 'min-w-[130px]'
        } max-w-[200px] cursor-pointer items-center gap-2 px-3 text-xs transition-colors duration-150 ${
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
          <span title={slot ? undefined : 'Administrator'} className="-ml-0.5 shrink-0 text-amber-400">
            <ShieldCheck size={12} aria-label={slot ? undefined : 'Administrator'} />
          </span>
        )}
        {/* The mark a program put at the front of its title, in the emoji
            font's own colors. `aria-hidden`: the tooltip has the full title. */}
        {badge && (
          // A fixed-width box so the badge swapping between glyphs (emoji at rest,
          // spinner frames while busy) doesn't resize the tab.
          <span
            aria-hidden
            className={`inline-flex w-[14px] shrink-0 justify-center text-[11px] leading-none ${
              slot ? 'tab-slot-text' : ''
            }`}
            data-text={slot ? badge : undefined}
          >
            {slot ? null : badge}
          </span>
        )}
        {/* The slot sizes itself from the same text without holding it, so the
            tab's words exist once in the page (see .tab-slot-text). */}
        {slot ? (
          <span className="tab-slot-text truncate" data-text={tab.title} />
        ) : (
          <span className="truncate">{tab.title}</span>
        )}
        {/* Always visible on the active tab, hover-revealed on the rest (as in
         * Edge and Windows Terminal): `:hover` isn't re-evaluated until the
         * pointer moves, so after closing a dialog an invisible ✕ is hard to
         * hit. */}
        {/* A phone has no hover, so an invisible one would only cost title room. */}
        {(!isAndroid || active) && (
        <button
          aria-label={slot ? undefined : `Close ${tab.title}`}
          data-tab-close={slot ? undefined : true}
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
        )}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
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
       * clip (e.g. through its close button). Only on a side with more tabs. */}
      <div className="relative flex min-w-0 shrink items-stretch">
      {/* The view onto the tabs. Its mask (fades, and the hole under the active
       * tab) is written by `layout`, not here, so a render can't undo it.
       * The side padding leaves room for the first and last tabs' fillets
       * (otherwise the last one counts as overflow and the first is clipped
       * square) and, on the desktop, matches the fade, where the active tab
       * pins. `relative`: the tabs' offsetLeft is measured from the track (or
       * Android's scroller). */}
      {isAndroid ? (
        <div
          ref={tabsContainerRef}
          onScroll={layout}
          // The native scrollbar is hidden (the fades and arrows are the affordance).
          className="tab-strip-scroll relative flex min-w-0 shrink items-stretch overflow-x-auto"
          style={{ paddingLeft: STRIP_PAD_PX, paddingRight: STRIP_PAD_PX }}
        >
          {tabs.map((tab, i) => renderTab(tab, i))}
        </div>
      ) : (
        <div
          ref={tabsContainerRef}
          // `clip`, not `hidden`: a hidden box can still be scrolled (by focus
          // moving into it), which would put it out of step with the track.
          className="flex min-w-0 shrink items-stretch"
          style={{ overflowX: 'clip' }}
        >
          <div
            ref={trackRef}
            className="relative flex w-full items-stretch"
            style={{ paddingLeft: STRIP_PAD_PX, paddingRight: STRIP_PAD_PX }}
          >
            {tabs.map((tab, i) => renderTab(tab, i, tab.id === activeTabId ? 'slot' : 'tab'))}
          </div>
        </div>
      )}
      {!isAndroid && activeIndex >= 0 && (
        <div ref={overlayRef} className="absolute inset-y-0 left-0 z-10 flex">
          {renderTab(tabs[activeIndex], activeIndex, 'overlay')}
        </div>
      )}
      {/* A phone's arrows only signal, laid over the fades (a tap at the edge
       * should reach the tab under it, and a swipe scrolls). The desktop's are
       * real buttons beside the strip; see below. */}
      {isAndroid && edges.left && (
        <ChevronLeft
          aria-hidden
          size={14}
          data-testid="more-tabs-left"
          className="pointer-events-none absolute left-0 top-1/2 z-20 -translate-y-1/2 text-chrome/70"
        />
      )}
      {isAndroid && edges.right && (
        <ChevronRight
          aria-hidden
          size={14}
          data-testid="more-tabs-right"
          className="pointer-events-none absolute right-0 top-1/2 z-20 -translate-y-1/2 text-chrome/70"
        />
      )}
      </div>
      {/* Desktop, once the tabs overflow: arrows that page the strip, then a list
       * of every tab. The arrows stay put (dimmed at that end) rather than
       * vanish, so the strip doesn't jump under the pointer. */}
      {!isAndroid && overflowing && (
        <>
          <button
            aria-label="Scroll tabs left"
            title="Scroll tabs left"
            data-testid="more-tabs-left"
            disabled={!edges.left}
            onMouseDown={keepFocus}
            onClick={() => scrollStrip(-1)}
            className={stripButtonClass}
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <button
            aria-label="Scroll tabs right"
            title="Scroll tabs right"
            data-testid="more-tabs-right"
            disabled={!edges.right}
            onMouseDown={keepFocus}
            onClick={() => scrollStrip(1)}
            className={stripButtonClass}
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
          <button
            aria-label="All tabs"
            title={`All tabs (${tabs.length})`}
            data-testid="tab-list-button"
            aria-haspopup="menu"
            aria-expanded={tabList !== null}
            onMouseDown={keepFocus}
            onClick={(e) => {
              // Or the window listener that closes the list would see this click.
              e.stopPropagation()
              if (tabList) return setTabList(null)
              const r = e.currentTarget.getBoundingClientRect()
              setMenu(null)
              setTabList({ right: window.innerWidth - r.right, top: r.bottom })
            }}
            className={stripButtonClass}
          >
            <ChevronDown size={16} strokeWidth={2} />
          </button>
        </>
      )}
      <button
        onClick={onNew}
        className="flex shrink-0 items-center justify-center px-3 py-2 text-chrome/45 transition-colors duration-150 hover:bg-chrome/[0.06] hover:text-chrome"
        title={newTabTitle}
      >
        <Plus size={16} strokeWidth={2} />
      </button>

      {tabList && (
        <div
          role="menu"
          data-testid="tab-list"
          className="animate-in fade-in zoom-in-95 fixed z-50 max-h-[60vh] w-64 origin-top-right overflow-y-auto rounded-md border border-chrome/10 bg-surface py-1 text-xs text-chrome/80 shadow-xl duration-100"
          style={{ right: tabList.right, top: tabList.top }}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTabId
            const leaves = allLeaves(tab.root)
            const attention = leaves.some((l) => attentionPanes[l.id])
            return (
              <button
                key={tab.id}
                role="menuitem"
                title={tab.title}
                onMouseDown={keepFocus}
                onClick={() => {
                  onSelect(tab.id)
                  setTabList(null)
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors duration-100 hover:bg-chrome/10 ${
                  active ? 'font-medium text-chrome' : ''
                }`}
              >
                <span
                  className={`h-3.5 w-0.5 shrink-0 rounded-full ${active ? 'bg-sky-400' : 'bg-transparent'}`}
                />
                <span className="truncate">{tab.title}</span>
                {attention && (
                  <span
                    aria-label="Needs attention"
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}

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
