import { useEffect, useState } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import {
  SHORTCUT_ACTIONS,
  bindingsFor,
  chordFromEvent,
  chordProblem,
  chordWarning,
  findConflicts,
  setRecordingShortcut,
  type ActionId,
  type Keybindings,
} from '../lib/keybindings'

const LABELS = Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, a.label])) as Record<
  ActionId,
  string
>

function withoutAction(value: Keybindings, id: ActionId): Keybindings {
  const next = { ...value }
  delete next[id]
  return next
}

/** Settings → Keyboard: every action, its chords, and a way to record more.
 *
 * Recording listens on the window in the capture phase and swallows every
 * key until it has one, so a chord being bound cannot also fire — Escape
 * would otherwise close the dialog, and Ctrl+Shift+T would open a tab. The
 * app's own window-level shortcuts are registered first and see the key
 * anyway, which is why they check `isRecordingShortcut` and stand aside. */
export function KeybindingsEditor({
  value,
  onChange,
}: {
  value: Keybindings
  onChange: (next: Keybindings) => void
}) {
  const [recordingFor, setRecordingFor] = useState<ActionId | null>(null)
  const [notice, setNotice] = useState<{ id: ActionId; text: string; error: boolean } | null>(null)
  const conflicts = findConflicts(value)

  useEffect(() => {
    if (!recordingFor) return
    setRecordingShortcut(true)
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRecordingFor(null)
        return
      }
      // A modifier on its own: keep waiting for the key that ends the chord.
      const chord = chordFromEvent(e)
      if (!chord) return
      const problem = chordProblem(chord)
      if (problem) {
        // Still recording, so the next attempt needs no second click.
        setNotice({ id: recordingFor, text: `${chord}: ${problem}`, error: true })
        return
      }
      const current = bindingsFor(value, recordingFor)
      if (!current.includes(chord)) onChange({ ...value, [recordingFor]: [...current, chord] })
      const warning = chordWarning(chord)
      setNotice(warning ? { id: recordingFor, text: warning, error: false } : null)
      setRecordingFor(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      setRecordingShortcut(false)
    }
  }, [recordingFor, value, onChange])

  return (
    <div className="space-y-0.5 px-2 py-1.5">
      <p className="mb-2 leading-relaxed text-chrome/40">
        Press + beside an action, then the keys. Escape cancels. A shortcut needs Ctrl, Alt or
        Win unless it is a function key, since on its own a key is typing. Pane shortcuts work
        while a terminal has the keyboard; the rest work anywhere in the window.
      </p>
      {SHORTCUT_ACTIONS.map((action) => {
        const chords = bindingsFor(value, action.id)
        const recording = recordingFor === action.id
        return (
          <div
            key={action.id}
            className="flex flex-wrap items-center gap-1.5 rounded-md px-1 py-1 transition-colors duration-100 hover:bg-chrome/5"
          >
            <span className="min-w-[11rem] flex-1 text-chrome/85">
              {action.label}
              <span className="ml-1.5 text-[0.65rem] uppercase tracking-wide text-chrome/30">
                {action.scope}
              </span>
            </span>
            {chords.map((chord) => {
              const clash = (conflicts.get(chord) ?? []).filter((id) => id !== action.id)
              return (
                <span
                  key={chord}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[0.7rem] ${
                    clash.length
                      ? 'border-red-400/50 text-red-200'
                      : 'border-chrome/15 text-chrome/80'
                  }`}
                  title={
                    clash.length
                      ? `Also bound to ${clash.map((id) => LABELS[id]).join(', ')} — only one of them will run`
                      : undefined
                  }
                >
                  {chord}
                  <button
                    type="button"
                    aria-label={`Remove ${chord} from ${action.label}`}
                    onClick={() =>
                      onChange({ ...value, [action.id]: chords.filter((c) => c !== chord) })
                    }
                    className="text-chrome/40 transition-colors duration-100 hover:text-chrome/90"
                  >
                    <X size={11} />
                  </button>
                </span>
              )
            })}
            {chords.length === 0 && !recording && <span className="text-chrome/30">Unbound</span>}
            <button
              type="button"
              aria-label={recording ? 'Cancel recording' : `Add a shortcut for ${action.label}`}
              onClick={() => {
                setNotice(null)
                setRecordingFor(recording ? null : action.id)
              }}
              className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.7rem] transition-colors duration-100 ${
                recording
                  ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
                  : 'border-chrome/10 text-chrome/50 hover:bg-chrome/10 hover:text-chrome/90'
              }`}
            >
              {recording ? 'Press keys…' : <Plus size={12} />}
            </button>
            {value[action.id] !== undefined && (
              <button
                type="button"
                title="Restore the default"
                aria-label={`Restore the default for ${action.label}`}
                onClick={() => {
                  setNotice(null)
                  onChange(withoutAction(value, action.id))
                }}
                className="text-chrome/40 transition-colors duration-100 hover:text-chrome/90"
              >
                <RotateCcw size={12} />
              </button>
            )}
            {notice?.id === action.id && (
              <p
                className={`basis-full pl-1 text-[0.7rem] leading-relaxed ${
                  notice.error ? 'text-red-300/90' : 'text-amber-200/80'
                }`}
              >
                {notice.text}
              </p>
            )}
          </div>
        )
      })}
      {Object.keys(value).length > 0 && (
        <button
          type="button"
          onClick={() => {
            setNotice(null)
            setRecordingFor(null)
            onChange({})
          }}
          className="mt-2 rounded border border-chrome/10 px-2 py-1 text-chrome/70 transition-colors duration-100 hover:bg-chrome/10 hover:text-chrome/90"
        >
          Restore all defaults
        </button>
      )}
    </div>
  )
}
