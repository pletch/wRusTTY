import { describe, it, expect } from 'vitest'
import { serialProfileFrom, serialConfigFrom, profileSubtitle } from './profiles'
import type { SessionProfile } from './profiles'
import { defaultSerialConfig } from './serial'
import type { SerialConfig } from './serial'

const adapter = { vid: 0x0403, pid: 0x6001, serialNumber: 'A50285BI' }

function config(overrides: Partial<SerialConfig> = {}): SerialConfig {
  return { ...defaultSerialConfig(), portName: 'COM4', baudRate: 115200, ...overrides }
}

describe('serial profile conversion', () => {
  /** The whole point of the feature: what gets stored is the adapter, not the
   * COM number the adapter happens to be on today. */
  it('stores the adapter identity alongside the port name', () => {
    const profile = serialProfileFrom(config(), adapter)
    expect(profile.identity).toEqual({ portName: 'COM4', usb: adapter })
  })

  /** A PCI card or on-board port has no USB identity and doesn't need one — it
   * doesn't move, so its name is a fine identity. */
  it('accepts a port with no USB identity', () => {
    const profile = serialProfileFrom(config({ portName: 'COM1' }), null)
    expect(profile.identity).toEqual({ portName: 'COM1', usb: null })
  })

  it('round-trips every line setting through the stored form', () => {
    const original = config({
      dataBits: 'Seven',
      parity: 'Even',
      stopBits: 'Two',
      flowControl: 'Hardware',
      lineEnding: 'CrLf',
      inputMode: 'Readline',
    })
    expect(serialConfigFrom(serialProfileFrom(original, adapter))).toEqual(original)
  })

  /** `inputMode` is frontend-only, so it has to survive the trip through a
   * backend that never looks at it — otherwise a session saved in readline
   * mode comes back in normal mode. */
  it('preserves the frontend-only input mode', () => {
    for (const inputMode of ['Normal', 'LocalEcho', 'Readline', 'ReadlineHex'] as const) {
      const restored = serialConfigFrom(serialProfileFrom(config({ inputMode }), adapter))
      expect(restored.inputMode).toBe(inputMode)
    }
  })

  /** Only LocalEcho has a backend-visible effect, and the backend reads it
   * from `localEcho` rather than interpreting the mode. */
  it('derives localEcho from the input mode for the backend', () => {
    expect(serialProfileFrom(config({ inputMode: 'LocalEcho' }), adapter).localEcho).toBe(true)
    expect(serialProfileFrom(config({ inputMode: 'Readline' }), adapter).localEcho).toBe(false)
  })

  /** A profile written before `inputMode` was stored — or imported from PuTTY,
   * which has no such concept — still has to open in a sensible mode. */
  it('falls back to localEcho when no input mode was stored', () => {
    const legacy = { ...serialProfileFrom(config(), adapter), inputMode: null }
    expect(serialConfigFrom(legacy).inputMode).toBe('Normal')
    expect(serialConfigFrom({ ...legacy, localEcho: true }).inputMode).toBe('LocalEcho')
  })
})

describe('profileSubtitle for serial sessions', () => {
  function serialSession(usb: typeof adapter | null): SessionProfile {
    return {
      id: 'p1',
      label: 'switch rack 3',
      folder: null,
      host: 'COM4',
      port: 0,
      protocol: 'serial',
      username: '',
      authType: '',
      keyPath: null,
      hasCredential: false,
      jumpProfileId: null,
      termType: null,
      backspaceSendsCtrlH: null,
      autoReconnect: null,
      keepaliveSeconds: null,
      wakeOnLan: null,
      serial: serialProfileFrom(config(), usb),
    }
  }

  /** Names the adapter, not the port: the COM number shown in the list would
   * be where it *was*, which is exactly the thing that stops being true. */
  it('identifies the session by its adapter serial number when it has one', () => {
    expect(profileSubtitle(serialSession(adapter))).toBe('A50285BI @ 115200')
  })

  it('falls back to the port name for an adapter with no identity', () => {
    expect(profileSubtitle(serialSession(null))).toBe('COM4 @ 115200')
  })
})
