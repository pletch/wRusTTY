// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConnectDialog } from './ConnectDialog'
import type { SessionProfile } from '../lib/profiles'

afterEach(cleanup)

/**
 * The Wake-on-LAN group.
 *
 * Pinned because every interesting case here is a *conditional* — the field is
 * absent for protocols that don't wire waking, absent when a jump host makes
 * waking impossible, and its two qualifying inputs are absent until there's a
 * MAC for them to qualify. A field that appears when it shouldn't is worse
 * than cosmetic in the jump-host case: it would promise a packet the backend
 * deliberately never sends.
 */

const noop = () => {}

const wake = { mac: 'aa:bb:cc:dd:ee:ff', broadcast: null, port: null, waitSeconds: null }

const jumpProfile: SessionProfile = {
  id: 'jump-1',
  label: 'bastion',
  folder: null,
  host: 'bastion.example.net',
  port: 22,
  protocol: 'ssh',
  username: 'tim',
  authType: 'agent',
  keyPath: null,
  hasCredential: false,
  jumpProfileId: null,
  termType: null,
  backspaceSendsCtrlH: null,
  keepaliveSeconds: null,
  wakeOnLan: null,
  serial: null,
}

function dialog(props: Partial<Parameters<typeof ConnectDialog>[0]> = {}) {
  return (
    <ConnectDialog onConnect={noop} vaultUnlocked={false} {...props} />
  )
}

/** The MAC input, by its label. */
function macField() {
  return screen.queryByLabelText(/Wake-on-LAN/i)
}

describe('the Wake-on-LAN field', () => {
  it('is offered for an SSH session', () => {
    render(dialog())
    expect(macField()).toBeTruthy()
  })

  it('is not offered for telnet or serial, which have no wake wiring', async () => {
    render(dialog({ initial: { protocol: 'telnet' } }))
    expect(macField()).toBeNull()
    cleanup()
    render(dialog({ initial: { protocol: 'serial' } }))
    expect(macField()).toBeNull()
  })

  /** The backend refuses to wake a host behind a jump (a magic packet is a
   * local broadcast and the target isn't on this segment), so the form must
   * not offer a field that would do nothing. */
  it('disappears once a jump host is selected', async () => {
    render(dialog({ sessions: [jumpProfile] }))
    expect(macField()).toBeTruthy()

    await userEvent.selectOptions(screen.getByLabelText(/Jump host/i), 'jump-1')
    expect(macField()).toBeNull()
  })

  /** Two more inputs on every SSH form would be noise for the majority of
   * sessions, which wake nothing. */
  it('reveals the broadcast and wait inputs only once a MAC is typed', async () => {
    render(dialog())
    expect(screen.queryByLabelText(/Broadcast to/i)).toBeNull()

    await userEvent.type(macField() as HTMLElement, 'aa:bb:cc:dd:ee:ff')

    expect(screen.getByLabelText(/Broadcast to/i)).toBeTruthy()
    expect(screen.getByLabelText(/Wait \(seconds\)/i)).toBeTruthy()
  })

  /** The command behind the menu item fails without a MAC, so an item that
   * could only ever report that isn't worth a row. */
  it('offers Wake in a session\'s menu only when that session has a MAC', async () => {
    const sleeps = { ...jumpProfile, id: 'desk', label: 'desktop', wakeOnLan: wake }
    render(dialog({ sessions: [jumpProfile, sleeps] }))

    await userEvent.pointer({ target: screen.getByText('bastion'), keys: '[MouseRight]' })
    expect(screen.queryByText('Wake')).toBeNull()

    await userEvent.pointer({ target: screen.getByText('desktop'), keys: '[MouseRight]' })
    expect(screen.getByText('Wake')).toBeTruthy()
  })

  it('opens a saved session on the MAC it already had', () => {
    render(
      dialog({
        initial: {
          host: 'desktop.lan',
          wakeOnLan: { mac: 'aa:bb:cc:dd:ee:ff', broadcast: null, port: null, waitSeconds: null },
        },
      }),
    )
    expect((macField() as HTMLInputElement).value).toBe('aa:bb:cc:dd:ee:ff')
  })
})

/**
 * How the auth radios turn into an `AuthMethod`.
 *
 * The interesting case is a blank password field, which carries two different
 * meanings depending on whether a credential is stored — and used to carry a
 * third, useless one (send an empty string and be rejected) when neither
 * applied.
 */

/** Submits the form with `host`/`username` filled in, returning the source. */
async function connectWith(
  props: Partial<Parameters<typeof ConnectDialog>[0]>,
  fill: (user: ReturnType<typeof userEvent.setup>) => Promise<void> = async () => {},
) {
  let source: unknown = null
  const user = userEvent.setup()
  render(dialog({ ...props, onConnect: (s: unknown) => void (source = s) }))
  await user.type(screen.getByPlaceholderText('host'), 'example.net')
  await user.type(screen.getByPlaceholderText('username'), 'tim')
  await fill(user)
  await user.click(screen.getByRole('button', { name: 'Connect' }))
  return source as { protocol: string; config?: { auth: { type: string; password?: string } } }
}

describe('the auth method a blank password field produces', () => {
  it('asks at connect time when nothing is typed and nothing is stored', async () => {
    // Used to send `{ type: 'Password', password: '' }`, which the server can
    // only reject — and each rejection spends one of its limited attempts.
    const source = await connectWith({})
    expect(source.config?.auth.type).toBe('KeyboardInteractive')
  })

  it('still sends a typed password as a password', async () => {
    const source = await connectWith({}, async (user) => {
      await user.type(screen.getByPlaceholderText('password'), 'hunter2')
    })
    expect(source.config?.auth).toEqual({ type: 'Password', password: 'hunter2' })
  })

  it('leaves the stored-credential reading of a blank field alone', async () => {
    // A saved session's password field starts blank because the plaintext
    // never comes back to the webview. That blank means "use the vault", and
    // must keep routing through the profile rather than prompting.
    const source = await connectWith({
      initial: {
        id: 'saved-1',
        protocol: 'ssh',
        host: 'example.net',
        username: 'tim',
        authType: 'Password',
        hasCredential: true,
      },
    })
    expect(source.protocol).toBe('sshProfile')
  })
})

describe('the "ask each time" auth option', () => {
  it('is offered by name', () => {
    render(dialog())
    expect(screen.getByText('Ask each time')).toBeTruthy()
  })

  it('produces keyboard-interactive auth', async () => {
    const source = await connectWith({}, async (user) => {
      await user.click(screen.getByText('Ask each time'))
    })
    expect(source.config?.auth.type).toBe('KeyboardInteractive')
  })
})
