import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// Imported dynamically inside each test, not here: the cache being tested is
// module-level state, so every case needs a freshly evaluated module (see the
// vi.resetModules in beforeEach).

/**
 * The compiled module is shared by every pane; the instance never is.
 *
 * Both halves matter and they fail in opposite directions. Losing the sharing
 * costs a full compile of a 3 MB binary on every pane open — the reason the
 * `ReleaseFast` build is affordable at all. Accidentally sharing an *instance*
 * would be far worse than slow: panes would silently render each other's
 * terminal, since the instance is where linear memory (and so all terminal
 * state) lives.
 */

const here = dirname(fileURLToPath(import.meta.url))
const WASM = readFileSync(join(here, 'vendor/ghostty-vt.wasm'))

/** `compileGhosttyWasm` takes a URL and fetches it; in node there is no fetch
 *  of a bundler URL, so it is stubbed to hand back the real binary. */
function stubFetch(): { calls: () => number } {
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => {
    calls++
    if (url === 'bad://missing') return { ok: false, status: 404 } as Response
    return { ok: true, status: 200, arrayBuffer: async () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) } as Response
  })
  return { calls: () => calls }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('compileGhosttyWasm', () => {
  it('fetches and compiles only once no matter how many panes ask', async () => {
    const { compileGhosttyWasm: compile } = await import('./wasmBindings')
    const f = stubFetch()
    const mods = await Promise.all([
      compile('ok://wasm'), compile('ok://wasm'), compile('ok://wasm'), compile('ok://wasm'),
    ])
    expect(f.calls()).toBe(1)
    // Same compiled artifact handed to every caller, not four equivalent ones.
    for (const m of mods) expect(m).toBe(mods[0])
  })

  it('serves later callers from the cache too, not just concurrent ones', async () => {
    const { compileGhosttyWasm: compile } = await import('./wasmBindings')
    const f = stubFetch()
    const first = await compile('ok://wasm')
    const second = await compile('ok://wasm')
    expect(f.calls()).toBe(1)
    expect(second).toBe(first)
  })

  it('does not cache a failure, so a later pane can still succeed', async () => {
    const { compileGhosttyWasm: compile } = await import('./wasmBindings')
    stubFetch()
    await expect(compile('bad://missing')).rejects.toThrow(/404/)
    // A rejected promise left in the cache would poison every pane opened
    // after one bad fetch, for the life of the app.
    stubFetch()
    await expect(compile('ok://wasm')).resolves.toBeInstanceOf(WebAssembly.Module)
  })
})

describe('instantiateGhosttyModule', () => {
  it('gives each pane its own memory and its own terminal state', async () => {
    const { compileGhosttyWasm: compile, instantiateGhosttyModule: inst } = await import('./wasmBindings')
    stubFetch()
    const mod = await compile('ok://wasm')
    const a = await inst(mod)
    const b = await inst(mod)

    expect(a.instance).not.toBe(b.instance)
    expect(a.exports.memory).not.toBe(b.exports.memory)
    expect(a.exports.memory.buffer).not.toBe(b.exports.memory.buffer)

    // Prove the isolation where it counts: write to one terminal and the
    // other must not see it.
    const enc = new TextEncoder()
    const termA = a.exports.ghostty_terminal_new(80, 24)
    const termB = b.exports.ghostty_terminal_new(80, 24)
    const bytes = enc.encode('only in A\r\n'.repeat(50))
    const p = a.exports.ghostty_wasm_alloc_u8_array(bytes.length)
    new Uint8Array(a.exports.memory.buffer, p, bytes.length).set(bytes)
    a.exports.ghostty_terminal_write(termA, p, bytes.length)
    a.exports.ghostty_wasm_free_u8_array(p, bytes.length)

    expect(a.exports.ghostty_terminal_get_scrollback_length(termA)).toBeGreaterThan(0)
    expect(b.exports.ghostty_terminal_get_scrollback_length(termB)).toBe(0)
  })
})
