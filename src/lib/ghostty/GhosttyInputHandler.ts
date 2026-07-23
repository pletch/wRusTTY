export class GhosttyInputHandler {
  private element: HTMLElement;
  private onData: (data: Uint8Array) => void;
  private encoder = new TextEncoder();
  private isAppCursorKeys: () => boolean;
  private backspaceBehavior: 'delete' | 'backspace' = 'delete';

  constructor(
    element: HTMLElement, 
    onData: (data: Uint8Array) => void,
    isAppCursorKeys: () => boolean = () => false
  ) {
    this.element = element;
    this.onData = onData;
    this.isAppCursorKeys = isAppCursorKeys;

    element.tabIndex = 0; // Make focusable
    element.addEventListener('keydown', this.handleKeyDown);
  }

  setBackspaceBehavior(behavior: 'delete' | 'backspace') {
    this.backspaceBehavior = behavior;
  }

  dispose() {
    this.element.removeEventListener('keydown', this.handleKeyDown);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    // Avoid interfering with browser shortcuts
    if (e.metaKey && e.key !== 'v' && e.key !== 'c') return;

    let seq = '';
    const alt = e.altKey ? '\x1b' : '';
    
    // Calculate modifier mask for CSI sequences (1 + Shift*1 + Alt*2 + Ctrl*4)
    let modifier = 1;
    if (e.shiftKey) modifier += 1;
    if (e.altKey) modifier += 2;
    if (e.ctrlKey) modifier += 4;
    const modStr = modifier > 1 ? `;${modifier}` : '';

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.length === 1) {
      // Basic ctrl mapping (a-z, [, ], \, ^, _)
      const k = e.key.toLowerCase();
      if (k >= 'a' && k <= 'z') {
        seq = String.fromCharCode(k.charCodeAt(0) - 96);
      } else if (k === '[') seq = '\x1b';
      else if (k === '\\') seq = '\x1c';
      else if (k === ']') seq = '\x1d';
      else if (k === '^') seq = '\x1e';
      else if (k === '_') seq = '\x1f';
      else if (k === ' ') seq = '\x00';
    } else {
      const appCursor = this.isAppCursorKeys() && modifier === 1;
      switch (e.key) {
        case 'Enter': seq = alt + '\r'; break;
        case 'Backspace': 
          seq = alt + (this.backspaceBehavior === 'delete' ? '\x7f' : '\x08'); 
          break;
        case 'Tab': 
          if (e.shiftKey) seq = '\x1b[Z';
          else seq = alt + '\t'; 
          break;
        case 'Escape': seq = '\x1b'; break;
        case 'ArrowUp': seq = modifier > 1 ? `\x1b[1${modStr}A` : (appCursor ? '\x1bOA' : '\x1b[A'); break;
        case 'ArrowDown': seq = modifier > 1 ? `\x1b[1${modStr}B` : (appCursor ? '\x1bOB' : '\x1b[B'); break;
        case 'ArrowRight': seq = modifier > 1 ? `\x1b[1${modStr}C` : (appCursor ? '\x1bOC' : '\x1b[C'); break;
        case 'ArrowLeft': seq = modifier > 1 ? `\x1b[1${modStr}D` : (appCursor ? '\x1bOD' : '\x1b[D'); break;
        case 'Home': seq = modifier > 1 ? `\x1b[1${modStr}H` : (appCursor ? '\x1bOH' : '\x1b[H'); break;
        case 'End': seq = modifier > 1 ? `\x1b[1${modStr}F` : (appCursor ? '\x1bOF' : '\x1b[F'); break;
        case 'PageUp': seq = `\x1b[5${modStr}~`; break;
        case 'PageDown': seq = `\x1b[6${modStr}~`; break;
        case 'Insert': seq = `\x1b[2${modStr}~`; break;
        case 'Delete': seq = `\x1b[3${modStr}~`; break;
        case 'F1': seq = modifier > 1 ? `\x1b[1${modStr}P` : '\x1bOP'; break;
        case 'F2': seq = modifier > 1 ? `\x1b[1${modStr}Q` : '\x1bOQ'; break;
        case 'F3': seq = modifier > 1 ? `\x1b[1${modStr}R` : '\x1bOR'; break;
        case 'F4': seq = modifier > 1 ? `\x1b[1${modStr}S` : '\x1bOS'; break;
        case 'F5': seq = `\x1b[15${modStr}~`; break;
        case 'F6': seq = `\x1b[17${modStr}~`; break;
        case 'F7': seq = `\x1b[18${modStr}~`; break;
        case 'F8': seq = `\x1b[19${modStr}~`; break;
        case 'F9': seq = `\x1b[20${modStr}~`; break;
        case 'F10': seq = `\x1b[21${modStr}~`; break;
        case 'F11': seq = `\x1b[23${modStr}~`; break;
        case 'F12': seq = `\x1b[24${modStr}~`; break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            seq = alt + e.key;
          }
      }
    }

    if (seq) {
      e.preventDefault();
      e.stopPropagation();
      this.onData(this.encoder.encode(seq));
    }
  };
}
