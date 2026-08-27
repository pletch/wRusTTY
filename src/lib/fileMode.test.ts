import { describe, expect, it } from 'vitest'
import { canRead, canWrite, formatMode, formatOctal, needsRootToEdit, parseOctal } from './fileMode'

describe('formatMode', () => {
  it('renders the ordinary modes', () => {
    expect(formatMode(0o755)).toBe('rwxr-xr-x')
    expect(formatMode(0o644)).toBe('rw-r--r--')
    expect(formatMode(0o600)).toBe('rw-------')
    expect(formatMode(0o777)).toBe('rwxrwxrwx')
    expect(formatMode(0o000)).toBe('---------')
  })

  it('folds setuid and setgid into the execute column, as ls does', () => {
    expect(formatMode(0o4755)).toBe('rwsr-xr-x')
    expect(formatMode(0o2755)).toBe('rwxr-sr-x')
    expect(formatMode(0o6755)).toBe('rwsr-sr-x')
  })

  /** `/tmp`. Getting this wrong by masking to 0o777 would render it `rwxrwxrwx`
   *  and quietly misreport a directory whose whole point is the sticky bit. */
  it('renders the sticky bit', () => {
    expect(formatMode(0o1777)).toBe('rwxrwxrwt')
  })

  /**
   * The capital is the useful case: setuid set on something nobody can
   * execute is almost always a mistake, and showing a plain `s` would hide it.
   */
  it('capitalises a special bit whose execute bit is off', () => {
    expect(formatMode(0o4644)).toBe('rwSr--r--')
    expect(formatMode(0o2644)).toBe('rw-r-Sr--')
    expect(formatMode(0o1666)).toBe('rw-rw-rwT')
  })
})

describe('formatOctal', () => {
  it('pads to three digits', () => {
    expect(formatOctal(0o755)).toBe('755')
    expect(formatOctal(0o644)).toBe('644')
    expect(formatOctal(0o7)).toBe('007')
    expect(formatOctal(0)).toBe('000')
  })

  it('shows the special digit only when there is one', () => {
    expect(formatOctal(0o1777)).toBe('1777')
    expect(formatOctal(0o4755)).toBe('4755')
    expect(formatOctal(0o777)).toBe('777')
  })

  it('round-trips through parseOctal', () => {
    for (const mode of [0o755, 0o644, 0o1777, 0o4755, 0o7777, 0o0]) {
      expect(parseOctal(formatOctal(mode))).toBe(mode)
    }
  })
})

describe('parseOctal', () => {
  it('accepts what people actually type', () => {
    expect(parseOctal('755')).toBe(0o755)
    expect(parseOctal('0644')).toBe(0o644)
    expect(parseOctal('0o600')).toBe(0o600)
    expect(parseOctal(' 700 ')).toBe(0o700)
    expect(parseOctal('1777')).toBe(0o1777)
  })

  /**
   * Strictness is the feature. A field that read `abc` as 0 would `chmod 000`
   * a file on a remote host the user may not easily get back to.
   */
  it('refuses anything that is not a mode', () => {
    for (const input of ['', 'abc', '8', '9', '778', '12345', '-1', '7 5 5', 'rwxr-xr-x', '0x1ff']) {
      expect(parseOctal(input)).toBeNull()
    }
  })
})

const tim = { user: 'tim', isRoot: false, groups: ['tim', 'sudo'] }

describe('canWrite', () => {
  it('reads the owner triad for a file the user owns', () => {
    expect(canWrite({ mode: 0o644, owner: 'tim', group: 'tim' }, tim)).toBe(true)
    expect(canWrite({ mode: 0o444, owner: 'tim', group: 'tim' }, tim)).toBe(false)
  })

  it('reads the group triad when the user is in that group', () => {
    expect(canWrite({ mode: 0o664, owner: 'root', group: 'sudo' }, tim)).toBe(true)
    expect(canWrite({ mode: 0o644, owner: 'root', group: 'sudo' }, tim)).toBe(false)
  })

  it('reads the other triad for a file that is neither', () => {
    // The case the whole feature exists for.
    expect(canWrite({ mode: 0o644, owner: 'root', group: 'root' }, tim)).toBe(false)
    expect(canWrite({ mode: 0o666, owner: 'root', group: 'root' }, tim)).toBe(true)
  })

  it('never predicts a refusal for root', () => {
    const root = { user: 'root', isRoot: true, groups: ['root'] }
    expect(canWrite({ mode: 0o444, owner: 'nobody', group: 'nogroup' }, root)).toBe(true)
  })

  it('answers "no idea" rather than guessing', () => {
    // Each of these would put a sudo dialog in front of a file the user may
    // well be able to write, which is worse than trying and being refused.
    expect(canWrite({ mode: 0o644, owner: 'root', group: 'root' }, null)).toBeNull()
    expect(canWrite({ mode: null, owner: 'root', group: 'root' }, tim)).toBeNull()
    expect(canWrite({ mode: 0o644, owner: null, group: null }, tim)).toBeNull()
    // A host that would not name the group: the file might belong to one of
    // the user's, so the other triad is not the one to read.
    expect(canWrite({ mode: 0o644, owner: 'root', group: null }, tim)).toBeNull()
    // A uid with no passwd entry.
    expect(canWrite({ mode: 0o644, owner: 'root', group: 'root' }, {
      user: null,
      isRoot: false,
      groups: [],
    })).toBeNull()
  })
})

describe('canRead', () => {
  it('uses the read bit of the triad that applies', () => {
    expect(canRead({ mode: 0o600, owner: 'root', group: 'root' }, tim)).toBe(false)
    expect(canRead({ mode: 0o644, owner: 'root', group: 'root' }, tim)).toBe(true)
    expect(canRead({ mode: 0o640, owner: 'root', group: 'sudo' }, tim)).toBe(true)
  })
})

describe('needsRootToEdit', () => {
  it('is true when either half of an edit would be refused', () => {
    // Readable but not writable — the ordinary /etc file, and the case that
    // used to fail on save minutes after opening cleanly.
    expect(needsRootToEdit({ mode: 0o644, owner: 'root', group: 'root' }, tim)).toBe(true)
    // Neither readable nor writable.
    expect(needsRootToEdit({ mode: 0o600, owner: 'root', group: 'root' }, tim)).toBe(true)
  })

  it('is false for a file the user owns and can write', () => {
    expect(needsRootToEdit({ mode: 0o644, owner: 'tim', group: 'tim' }, tim)).toBe(false)
  })

  it('is false whenever the answer is unknown, so the ordinary attempt is made', () => {
    // An ACL or a read-only mount can still refuse a write the bits permit;
    // that is what the offer on the failure path is for.
    expect(needsRootToEdit({ mode: 0o644, owner: 'root', group: 'root' }, null)).toBe(false)
    expect(needsRootToEdit({ mode: null, owner: 'root', group: 'root' }, tim)).toBe(false)
  })
})
