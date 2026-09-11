import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_ACTIONS,
  actionForEvent,
  chordFromEvent,
  chordProblem,
  chordWarning,
  findConflicts,
  normalizeChord,
  sanitizeKeybindings,
  withShortcut,
} from './keybindings'

function key(
  k: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; win?: boolean } = {},
) {
  return {
    key: k,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.win,
  }
}

describe('chords', () => {
  it('spells modifiers in one order however they are typed', () => {
    expect(normalizeChord('shift+ctrl+t')).toBe('Ctrl+Shift+T')
    expect(normalizeChord('Win+Alt+Control+x')).toBe('Ctrl+Alt+Win+X')
  })

  it('reads the plus key at the end of a chord', () => {
    expect(normalizeChord('Ctrl++')).toBe('Ctrl++')
    expect(normalizeChord('+')).toBe('+')
  })

  it('drops Shift from a symbol, whose character already says it', () => {
    expect(normalizeChord('Ctrl+Shift+=')).toBe('Ctrl+=')
    // Shift+= on a US keyboard, and the numpad's own plus: one chord either way.
    expect(chordFromEvent(key('+', { ctrl: true, shift: true }))).toBe('Ctrl++')
    expect(chordFromEvent(key('+', { ctrl: true }))).toBe('Ctrl++')
  })

  it('keeps Shift on a letter or a named key', () => {
    expect(chordFromEvent(key('T', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+T')
    expect(chordFromEvent(key('Tab', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+Tab')
    expect(chordFromEvent(key('Insert', { shift: true }))).toBe('Shift+Insert')
  })

  it('makes nothing of a lone modifier', () => {
    expect(chordFromEvent(key('Control', { ctrl: true }))).toBeNull()
    expect(chordFromEvent(key('Shift', { shift: true }))).toBeNull()
    expect(chordFromEvent(key('Dead', { alt: true }))).toBeNull()
  })

  it('refuses what is not a chord', () => {
    expect(normalizeChord('')).toBeNull()
    expect(normalizeChord('Ctrl+Hyper+T')).toBeNull()
    expect(normalizeChord('Ctrl+Banana')).toBeNull()
  })

  it('ships every default in its canonical spelling', () => {
    for (const action of SHORTCUT_ACTIONS) {
      for (const chord of action.defaults) expect(normalizeChord(chord)).toBe(chord)
    }
  })

  it('ships no two actions on one chord', () => {
    expect(findConflicts({})).toEqual(new Map())
  })
})

describe('matching', () => {
  it('finds an action only in its own scope', () => {
    const e = key('T', { ctrl: true, shift: true })
    expect(actionForEvent(e, {}, 'window')).toBe('newTab')
    expect(actionForEvent(e, {}, 'pane')).toBeNull()
  })

  it('keeps both of the shipped zoom-in keys', () => {
    expect(actionForEvent(key('=', { ctrl: true }), {}, 'window')).toBe('zoomIn')
    expect(actionForEvent(key('+', { ctrl: true, shift: true }), {}, 'window')).toBe('zoomIn')
  })

  it("leaves Ctrl+_, readline's undo, alone", () => {
    expect(actionForEvent(key('_', { ctrl: true, shift: true }), {}, 'window')).toBeNull()
  })

  it('replaces the defaults with an override, and an empty one unbinds', () => {
    const overrides = { newTab: ['Alt+N'] }
    expect(actionForEvent(key('N', { alt: true }), overrides, 'window')).toBe('newTab')
    expect(actionForEvent(key('T', { ctrl: true, shift: true }), overrides, 'window')).toBeNull()
    expect(actionForEvent(key('T', { ctrl: true, shift: true }), { newTab: [] }, 'window')).toBeNull()
  })

  it('does not advertise an unbound key', () => {
    expect(withShortcut('New tab', {}, 'newTab')).toBe('New tab (Ctrl+Shift+T)')
    expect(withShortcut('New tab', { newTab: [] }, 'newTab')).toBe('New tab')
  })
})

describe('rules', () => {
  it('will not bind a bare key that is typing', () => {
    expect(chordProblem('A')).not.toBeNull()
    expect(chordProblem('Shift+A')).not.toBeNull()
    expect(chordProblem('Enter')).not.toBeNull()
  })

  it('allows function keys and Shift+Insert without Ctrl', () => {
    expect(chordProblem('F5')).toBeNull()
    expect(chordProblem('Shift+Insert')).toBeNull()
  })

  it('never takes Escape', () => {
    expect(chordProblem('Ctrl+Escape')).not.toBeNull()
  })

  it('warns about a control character but allows it', () => {
    expect(chordProblem('Ctrl+W')).toBeNull()
    expect(chordWarning('Ctrl+W')).toMatch(/control character/)
    expect(chordWarning('Ctrl+Shift+W')).toBeNull()
  })

  it('reports a chord two actions share, across scopes', () => {
    const conflicts = findConflicts({ find: ['Ctrl+Shift+T'] })
    expect(conflicts.get('Ctrl+Shift+T')).toEqual(['newTab', 'find'])
  })
})

describe('sanitizeKeybindings', () => {
  it('keeps only real actions and bindable chords, canonical and once', () => {
    expect(
      sanitizeKeybindings({
        newTab: ['alt+n', 'Alt+N', 'Q', 42],
        closeTab: [],
        notAnAction: ['Ctrl+X'],
        find: 'Ctrl+F',
      }),
    ).toEqual({ newTab: ['Alt+N'], closeTab: [] })
  })

  it('treats anything but an object as no overrides', () => {
    expect(sanitizeKeybindings(null)).toEqual({})
    expect(sanitizeKeybindings(['Ctrl+T'])).toEqual({})
    expect(sanitizeKeybindings('x')).toEqual({})
  })
})
