// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sftp = vi.hoisted(() => ({
  listDir: vi.fn(),
  canonicalize: vi.fn(),
  listEdits: vi.fn(),
  remoteIdentity: vi.fn(),
}))
const save = vi.hoisted(() => vi.fn())

vi.mock('../lib/sftp', async (original) => ({
  ...(await original<typeof import('../lib/sftp')>()),
  ...sftp,
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => new Promise(() => {})),
  Channel: class {
    onmessage = () => {}
  },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save }))
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn() }))
vi.mock('./confirmContext', () => ({ useConfirm: () => async () => true }))
vi.mock('../lib/platform', async (original) => ({
  ...(await original<typeof import('../lib/platform')>()),
  isAndroid: true,
}))

import { resetDismissStack } from '../lib/dismissStack'
import { FilesPanel } from './FilesPanel'

const ENTRIES = [
  { name: 'projects', isDir: true, size: 0, mode: 0o755, modified: null, uid: null, gid: null },
  { name: 'notes.txt', isDir: false, size: 2048, mode: 0o644, modified: null, uid: null, gid: null },
]

async function open(onClose = () => {}) {
  render(
    <FilesPanel
      sessionId="s"
      startDir="/home/tim"
      reveal={null}
      editorCommand=""
      onClose={onClose}
    />,
  )
  await screen.findByText('projects')
}

function escape() {
  fireEvent.keyDown(window, { key: 'Escape' })
}

describe('FilesPanel on a phone', () => {
  beforeEach(() => {
    resetDismissStack()
    vi.clearAllMocks()
    sftp.listDir.mockResolvedValue(ENTRIES)
    sftp.canonicalize.mockResolvedValue('/home/tim')
    sftp.listEdits.mockResolvedValue([])
    sftp.remoteIdentity.mockResolvedValue({ uid: 1000, gid: 1000, groups: [] })
    save.mockResolvedValue(null)
  })
  afterEach(cleanup)

  it('opens a folder on one tap', async () => {
    await open()
    sftp.listDir.mockClear()
    fireEvent.click(screen.getByText('projects'))
    await waitFor(() => expect(sftp.listDir).toHaveBeenCalledWith('s', '/home/tim/projects'))
  })

  it('offers to save a file on one tap, which can be backed out of', async () => {
    await open()
    fireEvent.click(screen.getByText('notes.txt'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })

  it('only closes the menu when a tap lands on a row with it open', async () => {
    await open()
    fireEvent.contextMenu(screen.getByText('notes.txt'))
    expect(screen.getByText('Copy path')).toBeTruthy()
    sftp.listDir.mockClear()
    fireEvent.click(screen.getByText('projects'))
    expect(screen.queryByText('Copy path')).toBeNull()
    expect(sftp.listDir).not.toHaveBeenCalled()
  })

  it('backs out of the menu before closing the panel', async () => {
    const onClose = vi.fn()
    await open(onClose)
    fireEvent.contextMenu(screen.getByText('notes.txt'))
    escape()
    expect(screen.queryByText('Copy path')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    escape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from its back arrow', async () => {
    const onClose = vi.fn()
    await open(onClose)
    fireEvent.click(screen.getByLabelText('Close remote files'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
