import { useEffect, useRef, useState } from 'react'
import { Pane } from './components/Pane'
import { TabBar } from './components/TabBar'
import { SessionManager } from './components/SessionManager'
import { QuickConnectPalette } from './components/QuickConnectPalette'
import { SettingsMenu } from './components/SettingsMenu'
import { VaultMenu } from './components/VaultMenu'
import { ToastHost } from './components/ToastHost'
import { TerminalSquare } from 'lucide-react'
import { toast } from './lib/toast'
import * as profiles from './lib/profiles'
import type { SessionProfile } from './lib/profiles'
import * as vault from './lib/vault'
import type { VaultStatus, VaultSecret } from './lib/vault'
import type { ConnectionSource } from './lib/connection'
import { sourceLabel } from './lib/connection'
import { loadSettings, saveSettings } from './lib/settings'
import { allLeaves, blankLeaf, closeLeaf, firstLeaf, splitLeaf, updateLeaf } from './lib/paneTree'
import type { Tab } from './types'

function newTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function blankTab(): Tab {
  const leaf = blankLeaf()
  return { id: newTabId(), title: 'New Connection', root: leaf, activePaneId: leaf.id }
}

function refit() {
  // Terminal listens for window resize to re-fit; nudge it after a tab or
  // pane becomes visible/resized (it may have been sized while hidden).
  setTimeout(() => window.dispatchEvent(new Event('resize')), 0)
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>(() => [blankTab()])
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null)
  const [statusByPane, setStatusByPane] = useState<Record<string, string>>({})
  const [profilesVersion, setProfilesVersion] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteSessions, setPaletteSessions] = useState<SessionProfile[]>([])
  const [terminalSettings, setTerminalSettings] = useState(() => loadSettings())
  const [vaultStatus, setVaultStatus] = useState<VaultStatus>('uninitialized')

  function updateSettings(next: typeof terminalSettings) {
    setTerminalSettings(next)
    saveSettings(next)
  }

  function refreshVaultStatus() {
    vault
      .status()
      .then(setVaultStatus)
      .catch(() => {})
  }

  useEffect(() => {
    refreshVaultStatus()
  }, [])

  function newTab() {
    const tab = blankTab()
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id) {
        const idx = prev.findIndex((t) => t.id === id)
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        setActiveTabId(neighbor?.id ?? null)
      }
      return next
    })
  }

  function selectTab(id: string) {
    setActiveTabId(id)
    refit()
  }

  function reorderTabs(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === draggedId)
      const to = prev.findIndex((t) => t.id === targetId)
      if (from === -1 || to === -1) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  function stepTab(delta: 1 | -1) {
    if (tabs.length === 0) return
    const idx = tabs.findIndex((t) => t.id === activeTabId)
    const next = tabs[(idx + delta + tabs.length) % tabs.length]
    if (next) selectTab(next.id)
  }

  /** Duplicates the tab's active pane's session into a new single-pane tab. */
  function duplicateTab(id: string) {
    const sourceTab = tabs.find((t) => t.id === id)
    if (!sourceTab) return
    const activeLeaf = allLeaves(sourceTab.root).find((l) => l.id === sourceTab.activePaneId)
    if (!activeLeaf?.source) return
    const leaf = blankLeaf()
    leaf.source = activeLeaf.source
    leaf.initial = activeLeaf.initial
    const tab: Tab = { id: newTabId(), title: sourceTab.title, root: leaf, activePaneId: leaf.id }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  /** Reconnects the tab's active pane in place. */
  function reconnectTab(id: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, root: updateLeaf(t.root, t.activePaneId, (l) => ({ ...l, generation: l.generation + 1 })) }
          : t,
      ),
    )
  }

  function connectPane(tabId: string, paneId: string, source: ConnectionSource) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        const root = updateLeaf(t.root, paneId, (l) => ({ ...l, source }))
        const title = paneId === t.activePaneId ? sourceLabel(source) : t.title
        return { ...t, root, title }
      }),
    )
  }

  function focusPane(tabId: string, paneId: string) {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId || t.activePaneId === paneId) return t
        const leaf = allLeaves(t.root).find((l) => l.id === paneId)
        return {
          ...t,
          activePaneId: paneId,
          title: leaf?.source ? sourceLabel(leaf.source) : t.title,
        }
      }),
    )
  }

  function splitPane(tabId: string, paneId: string, direction: 'horizontal' | 'vertical') {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t
        const root = splitLeaf(t.root, paneId, direction)
        const newLeafId = allLeaves(root).find((l) => !allLeaves(t.root).some((old) => old.id === l.id))?.id
        return { ...t, root, activePaneId: newLeafId ?? t.activePaneId }
      }),
    )
    refit()
  }

  function closePane(tabId: string, paneId: string) {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const newRoot = closeLeaf(tab.root, paneId)
    if (!newRoot) {
      closeTab(tabId)
      return
    }
    const activePaneId = tab.activePaneId === paneId ? firstLeaf(newRoot).id : tab.activePaneId
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, root: newRoot, activePaneId } : t)))
    refit()
  }

  async function openSavedSession(profile: SessionProfile) {
    const leaf = blankLeaf()

    // If the vault is unlocked and already holds this profile's credential,
    // skip the manual connect form entirely — the secret is resolved on
    // the Rust side and never sent to the frontend.
    const canConnectDirect =
      vaultStatus === 'unlocked' && (await vault.hasCredential(profile.id).catch(() => false))

    if (canConnectDirect) {
      leaf.source = { protocol: 'sshProfile', profileId: profile.id }
    }
    leaf.initial = {
      id: profile.id,
      label: profile.label,
      folder: profile.folder,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      authType: profile.authType === 'password' ? 'Password' : 'PublicKey',
      keyPath: profile.keyPath ?? undefined,
    }
    const tab: Tab = { id: newTabId(), title: profile.label, root: leaf, activePaneId: leaf.id }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }

  function saveProfile(profile: SessionProfile) {
    profiles
      .saveSession(profile)
      .then(() => {
        setProfilesVersion((v) => v + 1)
        toast.success(`Saved session "${profile.label}"`)
      })
      .catch((err) => toast.error(`Couldn't save session: ${err}`))
  }

  function saveCredential(profileId: string, secret: VaultSecret) {
    vault
      .setCredential(profileId, secret)
      .then(() => toast.success('Credential saved to vault'))
      .catch((err) => toast.error(`Couldn't save credential: ${err}`))
  }

  function openPalette() {
    profiles
      .listSessions()
      .then(setPaletteSessions)
      .catch(() => setPaletteSessions([]))
    setPaletteOpen(true)
  }

  // Keydown handlers close over state that changes every render; rather than
  // re-subscribing the listener on every change, keep a ref to the latest
  // callbacks and mount the listener once.
  const shortcutsRef = useRef({ newTab, closeTab, stepTab, openPalette, activeTabId })
  shortcutsRef.current = { newTab, closeTab, stepTab, openPalette, activeTabId }

  useEffect(() => {
    // Capture phase so these fire before xterm's own keydown handler can
    // treat them as shell input (e.g. Ctrl+W deletes a word in most
    // shells, so tab shortcuts intentionally avoid plain Ctrl combos).
    function onKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey) return
      const s = shortcutsRef.current

      if (e.key === 'Tab') {
        e.preventDefault()
        s.stepTab(e.shiftKey ? -1 : 1)
      } else if (e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        s.newTab()
      } else if (e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (s.activeTabId) s.closeTab(s.activeTabId)
      } else if (e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        s.openPalette()
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div className="flex h-screen w-screen flex-col bg-[#16171d]">
      <div className="flex h-10 shrink-0 items-stretch border-b border-white/10 bg-black/20">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          statusByPane={statusByPane}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          onDuplicate={duplicateTab}
          onReconnect={reconnectTab}
          onReorder={reorderTabs}
        />
        <div className="flex shrink-0 items-center gap-0.5 px-1.5">
          <SessionManager onOpen={openSavedSession} refreshToken={profilesVersion} />
          <VaultMenu status={vaultStatus} onStatusChange={refreshVaultStatus} />
          <SettingsMenu settings={terminalSettings} onChange={updateSettings} />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-h-0 flex-1 p-2">
          {tabs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-white/30">
              <TerminalSquare size={28} strokeWidth={1.5} />
              No open sessions
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-2"
              style={{ display: tab.id === activeTabId ? undefined : 'none' }}
            >
              <Pane
                node={tab.root}
                activePaneId={tab.activePaneId}
                settings={terminalSettings}
                vaultUnlocked={vaultStatus === 'unlocked'}
                onFocusPane={(paneId) => focusPane(tab.id, paneId)}
                onConnect={(paneId, config) => connectPane(tab.id, paneId, config)}
                onSaveProfile={saveProfile}
                onSaveCredential={saveCredential}
                onStatus={(paneId, s) => {
                  setStatusByPane((prev) => ({ ...prev, [paneId]: s }))
                  // Surfaced even for background tabs — otherwise a failed
                  // connection in a tab you're not looking at is silent.
                  if (s.startsWith('failed')) toast.error(s.replace(/^failed: /, ''))
                  // A clean remote-initiated disconnect (the shell exited,
                  // the server hung up) closes the pane on its own rather
                  // than leaving a dead terminal sitting open — but only a
                  // clean disconnect, not a failure, since the error should
                  // stay visible until the user dismisses it themselves.
                  if (s === 'disconnected') {
                    setTimeout(() => closePane(tab.id, paneId), 800)
                  }
                }}
                onSplit={(paneId, direction) => splitPane(tab.id, paneId, direction)}
                onClose={(paneId) => closePane(tab.id, paneId)}
              />
            </div>
          ))}
        </main>
        {paletteOpen && (
          <QuickConnectPalette
            sessions={paletteSessions}
            onClose={() => setPaletteOpen(false)}
            onSelect={(profile) => {
              openSavedSession(profile)
              setPaletteOpen(false)
            }}
          />
        )}
      </div>
      {(() => {
        const activeTab = tabs.find((t) => t.id === activeTabId)
        const status = activeTab && statusByPane[activeTab.activePaneId]
        if (!status) return null
        const dotColor = status === 'connected'
          ? 'bg-emerald-400'
          : status.startsWith('failed') || status === 'disconnected'
            ? 'bg-red-400'
            : 'bg-amber-400'
        return (
          <footer className="flex shrink-0 items-center gap-1.5 border-t border-white/10 px-3 py-1.5 text-xs text-white/40">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor} transition-colors duration-300`} />
            {status}
          </footer>
        )
      })()}
      <ToastHost />
    </div>
  )
}

export default App
