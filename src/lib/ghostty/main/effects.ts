/**
 * Query responses on ghostty `main`, which are a callback rather than a queue.
 *
 * ## The model change, and why it is the dangerous one
 *
 * Our ABI queues replies and the host drains them after a write —
 * `has_response` / `read_response`, wrapped by `GhosttyEngine.drainResponses`.
 * `main` has neither. Instead `vt_write` **by default ignores sequences that
 * have side effects or require responses**, and only answers them once the host
 * registers "effects": callbacks invoked synchronously during the write.
 *
 * That default is the trap. A port that maps every read and forgets this
 * renders a perfect screen — every glyph, colour and attribute correct — while
 * every device-attributes and status query silently goes unanswered, and the
 * programs that asked wait out their timeouts. There is no error and nothing
 * looks wrong. `effects.test.ts` therefore asserts both that the replies arrive
 * *and* that they do not without the callback installed.
 *
 * ## Getting a JS function into a wasm table
 *
 * `OPT_WRITE_PTY` takes a C function pointer, which in wasm is an index into
 * the module's table. A JS closure is not a `funcref` and `Table.set` rejects it
 * outright (`WebAssembly.Function` would help but is not available here). An
 * *exported wasm function* is a valid entry, though — so this hand-assembles a
 * 60-byte trampoline module that imports a JS function and exports a wasm
 * wrapper around it, and installs that.
 *
 * Two ABI details, both found by trying the other thing first:
 *
 * - **The value is the function pointer itself**, not a pointer to it. Passing
 *   a pointer-to-pointer returns `GHOSTTY_SUCCESS` and then traps inside
 *   `vt_write` with "table index is out of bounds", because the core used the
 *   address as the index.
 * - **Responses arrive during the write, not after it.** The header is explicit
 *   that callbacks must not re-enter `vt_write` on the same terminal, so they
 *   are buffered here and handed over once the write returns — which is also
 *   what keeps the shape compatible with `drainResponses`.
 */
import * as abi from './abi'

/**
 * A module importing `env.cb : (i32,i32,i32,i32) -> ()` and exporting `f`,
 * which forwards to it. Assembled by hand because it is far smaller than any
 * dependency that would emit it, and it never needs to change: the signature is
 * fixed by `GhosttyTerminalWritePtyFn`.
 */
const TRAMPOLINE_WASM = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  // type: one func type, (i32 i32 i32 i32) -> ()
  0x01, 0x08, 0x01, 0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x00,
  // import: env.cb, func, type 0
  0x02, 0x0a, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x02, 0x63, 0x62, 0x00, 0x00,
  // function: one func, type 0
  0x03, 0x02, 0x01, 0x00,
  // export: "f" -> func index 1 (0 is the import)
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x01,
  // code: local.get 0..3; call 0; end
  0x0a, 0x0e, 0x01, 0x0c, 0x00,
  0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0x20, 0x03, 0x10, 0x00, 0x0b,
])

let trampolineModule: WebAssembly.Module | null = null
function trampoline(onCall: (ptr: number, len: number) => void): WebAssembly.Instance {
  trampolineModule ??= new WebAssembly.Module(TRAMPOLINE_WASM)
  return new WebAssembly.Instance(trampolineModule, {
    env: { cb: (_term: number, _userdata: number, ptr: number, len: number) => onCall(ptr, len) },
  })
}

/**
 * Table slots freed by `dispose`, per wasm instance.
 *
 * A wasm table only grows, so without this a pane opened and closed repeatedly
 * would add an entry each time and never give one back. Keyed weakly so the
 * list dies with the instance it belongs to.
 */
const freeSlots = new WeakMap<object, number[]>()

export interface EffectsHandles {
  ex: abi.GhosttyMainExports & { __indirect_function_table?: WebAssembly.Table }
  term: number
}

export class MainEffects {
  private readonly ex: EffectsHandles['ex']
  private readonly table: WebAssembly.Table
  private readonly slot: number
  private pending: Uint8Array[] = []
  private disposed = false

  constructor({ ex, term }: EffectsHandles) {
    const table = ex.__indirect_function_table
    if (!table) {
      throw new Error('ghostty wasm build does not export __indirect_function_table')
    }
    this.ex = ex
    this.table = table

    const inst = trampoline((ptr, len) => {
      if (len <= 0) return
      // "The data is only valid for the duration of the call" — so copy now.
      // Handing the caller a view over wasm memory would give them bytes that
      // the next write overwrites, which is a race that reads as corruption.
      this.pending.push(new Uint8Array(ex.memory.buffer, ptr, len).slice())
    })

    const recycled = freeSlots.get(ex)?.pop()
    this.slot = recycled ?? table.grow(1)
    table.set(this.slot, inst.exports.f as WebAssembly.ExportValue)

    // The value IS the function pointer here, not a pointer to it.
    abi.expectOk(ex.ghostty_terminal_set(term, abi.T_OPT_WRITE_PTY, this.slot), 'set WRITE_PTY')
  }

  /**
   * Everything the terminal answered during writes since the last call.
   *
   * Returned as separate replies rather than one concatenated buffer because
   * that is what they are — a single write can trigger several — and the
   * existing drain loop already forwards them one at a time.
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
    // Cleared rather than left pointing at a live trampoline: the terminal is
    // usually freed around now, and a stale entry that still resolves is worse
    // than one that traps.
    this.table.set(this.slot, null)
    const list = freeSlots.get(this.ex) ?? []
    list.push(this.slot)
    freeSlots.set(this.ex, list)
  }
}
