import { describe, expect, it } from 'vitest'
import { formatMode, formatOctal, parseOctal } from './fileMode'

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
