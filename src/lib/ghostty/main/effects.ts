/**
 * Query responses on ghostty `main`, which are a callback rather than a queue.
 *
 * ## The trap
 *
 * Our ABI queued replies for the host to drain after a write
 * (`GhosttyEngine.drainResponses`). `main`'s `vt_write` by default ignores
 * sequences that need responses, answering only once the host registers
 * "effects" (callbacks invoked synchronously during the write). Without them
 * the screen renders perfectly while every device-attributes and status query
 * goes silently unanswered. `effects.test.ts` asserts replies arrive with the
 * callback and don't without it.
 *
 * ## Getting a JS function into a wasm table
 *
 * `OPT_WRITE_PTY` takes a function pointer, i.e. a table index. A JS closure
 * isn't a `funcref` (and `WebAssembly.Function` isn't available), but an
 * exported wasm function is, so this hand-assembles a 60-byte trampoline
 * module that wraps an imported JS function.
 *
 * - **The value is the function pointer itself**, not a pointer to it (a
 *   pointer-to-pointer succeeds, then traps in `vt_write` with "table index
 *   is out of bounds").
 * - **Responses arrive during the write.** Callbacks must not re-enter
 *   `vt_write`, so they're buffered and handed over after it returns,
 *   matching `drainResponses`.
 */
import * as abi from './abi'

/**
 * A module importing `env.cb : (i32 x arity) -> ()` and exporting `f`, which
 * forwards to it. Hand-assembled, being far smaller than any dependency that
 * would emit it. Every callback is all-i32 with no result
 * (`GhosttyTerminalWritePtyFn` takes four, `GhosttyTerminalRenderHoldFn`
 * three), so only the arity varies.
 */
function trampolineBytes(arity: number): Uint8Array<ArrayBuffer> {
  const i32s = new Array<number>(arity).fill(0x7f)
  const gets = Array.from({ length: arity }, (_, i) => [0x20, i]).flat()
  // locals (none), the gets, call 0, end
  const body = [0x00, ...gets, 0x10, 0x00, 0x0b]
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // type: one func type, (i32 x arity) -> ()
    0x01, 4 + arity, 0x01, 0x60, arity, ...i32s, 0x00,
    // import: env.cb, func, type 0
    0x02, 0x0a, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x02, 0x63, 0x62, 0x00, 0x00,
    // function: one func, type 0
    0x03, 0x02, 0x01, 0x00,
    // export: "f" -> func index 1 (0 is the import)
    0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x01,
    // code: one body
    0x0a, body.length + 2, 0x01, body.length, ...body,
  ])
}

const trampolineModules = new Map<number, WebAssembly.Module>()
function trampoline(arity: number, cb: (...args: number[]) => void): WebAssembly.Instance {
  let mod = trampolineModules.get(arity)
  if (!mod) {
    mod = new WebAssembly.Module(trampolineBytes(arity))
    trampolineModules.set(arity, mod)
  }
  return new WebAssembly.Instance(mod, { env: { cb } })
}

/**
 * Table slots freed by `dispose`, per wasm instance. A table only grows, so
 * reopened panes reuse slots. Weakly keyed, to die with the instance.
 */
const freeSlots = new WeakMap<object, number[]>()

export interface EffectsHandles {
  ex: abi.GhosttyMainExports & { __indirect_function_table?: WebAssembly.Table }
  term: number
  /**
   * Synchronized output (mode 2026) starting or ending, called during
   * `vt_write` at the exact byte: when `held` is true the terminal holds exactly
   * the frame to leave on screen, even if more follows in the same write. So it
   * can't be buffered. Snapshots are allowed here; writes aren't. Omitted, mode
   * 2026 is only a mode bit.
   */
  onRenderHold?: (held: boolean) => void
}

export class MainEffects {
  private readonly ex: EffectsHandles['ex']
  private readonly table: WebAssembly.Table
  private readonly slot: number
  private readonly holdSlot: number | null = null
  private pending: Uint8Array[] = []
  private disposed = false

  constructor({ ex, term, onRenderHold }: EffectsHandles) {
    const table = ex.__indirect_function_table
    if (!table) {
      throw new Error('ghostty wasm build does not export __indirect_function_table')
    }
    this.ex = ex
    this.table = table

    const inst = trampoline(4, (_term, _userdata, ptr, len) => {
      if (len <= 0) return
      // Only valid for the duration of the call, so copy now.
      this.pending.push(new Uint8Array(ex.memory.buffer, ptr, len).slice())
    })

    this.slot = this.claimSlot(inst)
    // The value is the function pointer, not a pointer to it.
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_WRITE_PTY, this.slot), 'set WRITE_PTY')

    if (onRenderHold) {
      const hold = trampoline(3, (_term, _userdata, held) => onRenderHold(held !== 0))
      this.holdSlot = this.claimSlot(hold)
      abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_RENDER_HOLD, this.holdSlot), 'set RENDER_HOLD')
    }
  }

  /** A table entry for `inst`'s export, reusing one a disposed pane gave back. */
  private claimSlot(inst: WebAssembly.Instance): number {
    const slot = freeSlots.get(this.ex)?.pop() ?? this.table.grow(1)
    this.table.set(slot, inst.exports.f as WebAssembly.ExportValue)
    return slot
  }

  /**
   * Everything the terminal answered since the last call, as separate replies
   * (one write can trigger several).
   */
  takeResponses(): Uint8Array[] {
    if (this.pending.length === 0) return []
    const out = this.pending
    this.pending = []
    return out
  }

  /** Releases the table slot for reuse. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pending = []
    // Cleared so a stale entry traps rather than resolving to a live trampoline.
    const list = freeSlots.get(this.ex) ?? []
    for (const slot of [this.slot, this.holdSlot]) {
      if (slot === null) continue
      this.table.set(slot, null)
      list.push(slot)
    }
    freeSlots.set(this.ex, list)
  }
}
