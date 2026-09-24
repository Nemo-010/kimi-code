// A small terminal emulator for the desktop shell's Terminal panel.
//
// The shipped web bundle no longer contains a terminal: the harness that did
// was removed and only its translation strings remain (`xterm` has zero hits in
// the bundle). The daemon, however, still serves terminals — `POST
// /sessions/:id/terminals`, PTY I/O over `/api/v1/ws` — bundled with `node-pty`
// and reachable. So the shell supplies both the client and the emulator, and
// the result is the daemon's real PTY rather than an imitation.
//
// The emulator is deliberately self-contained: the desktop bundles everything
// into the AppImage, so a terminal library would be one more thing to ship and
// keep patched. It implements the VT subset a shell actually emits.
//
// Screen state lives in plain arrays; the DOM is written only for the visible
// rows, so a chatty command cannot turn into thousands of nodes.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Scrollback kept per terminal. */
const MAX_SCROLLBACK = 2000;
const MAX_PARAMS = 16;

interface Cell {
  char: string;
  fg: number | null;
  bg: number | null;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
}

function blankCell(): Cell {
  return { char: ' ', fg: null, bg: null, bold: false, underline: false, inverse: false };
}

/** A terminal screen: a grid plus the parser state that feeds it. */
export class TerminalScreen {
  /**
   * The screen grid. Cursor coordinates index this, never the scrollback, so
   * the two cannot drift apart.
   */
  private lines: Cell[][] = [];
  /** Lines that have scrolled off the top, oldest first. */
  private scrollbackLines: Cell[][] = [];
  /** Rows scrolled back from the live view; 0 means showing the live screen. */
  private scrollOffset = 0;
  private cursorRow = 0;
  private cursorCol = 0;
  private savedCursor = { row: 0, col: 0 };
  private current: Cell = blankCell();
  /** Parser state: how many bytes of an escape sequence we are inside. */
  private state: 'text' | 'escape' | 'csi' | 'osc' = 'text';
  private csiParams = '';
  private scrollTop = 0;
  private scrollBottom = DEFAULT_ROWS - 1;

  constructor(
    public cols = DEFAULT_COLS,
    public rows = DEFAULT_ROWS,
  ) {
    this.reset();
  }

  reset(): void {
    this.lines = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, blankCell));
    this.scrollbackLines = [];
    this.scrollOffset = 0;
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.current = blankCell();
    this.state = 'text';
    this.csiParams = '';
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
  }

  /**
   * The rows on screen: the live grid, or a window into scrollback when the
   * user has scrolled back.
   */
  visible(): Cell[][] {
    if (this.scrollOffset === 0) return this.lines;
    const history = this.scrollbackLines;
    const end = history.length - this.scrollOffset + this.rows;
    const start = Math.max(0, end - this.rows);
    const fromHistory = history.slice(start, Math.min(end, history.length));
    const fromScreen = this.lines.slice(0, Math.max(0, this.rows - fromHistory.length));
    const view = [...fromHistory, ...fromScreen];
    while (view.length < this.rows) view.push(Array.from({ length: this.cols }, blankCell));
    return view;
  }

  /** How many rows of scrollback exist above the live screen. */
  scrollback(): number {
    return this.scrollbackLines.length;
  }

  /** Scroll the view by whole rows; positive scrolls up into history. */
  scrollBy(rows: number): void {
    const limit = this.scrollback();
    this.scrollOffset = Math.max(0, Math.min(limit, this.scrollOffset + rows));
  }

  /** Return to the live screen. */
  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  /** Whether the view is showing history rather than the live screen. */
  get scrollingBack(): boolean {
    return this.scrollOffset > 0;
  }

  cursor(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    const next = Array.from({ length: rows }, (_, row) => {
      const existing = this.lines[row] ?? [];
      return Array.from({ length: cols }, (_, col) => existing[col] ?? blankCell());
    });
    this.lines = next;
    this.scrollOffset = 0;
    this.cols = cols;
    this.rows = rows;
    this.cursorRow = Math.min(this.cursorRow, rows - 1);
    this.cursorCol = Math.min(this.cursorCol, cols - 1);
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
  }

  /** Feed raw PTY output. */
  write(data: string): void {
    // New output brings the view back to the live screen, unless the user is
    // deliberately reading history.
    if (this.scrollOffset > 0 && !this.holdScroll) this.scrollOffset = 0;
    for (const char of data) this.feed(char);
  }

  /**
   * When true, incoming output does not pull the view back to the bottom. The
   * panel sets this while the user is scrolling through history.
   */
  holdScroll = false;

  private feed(char: string): void {
    if (this.state === 'osc') {
      // OSC runs until BEL or ST; the desktop has no use for its payload.
      if (char === '\u0007') this.state = 'text';
      else if (char === '\\' && this.csiParams.endsWith('\u001B')) this.state = 'text';
      else this.csiParams += char;
      return;
    }
    if (this.state === 'escape') {
      if (char === '[') {
        this.state = 'csi';
        this.csiParams = '';
        return;
      }
      if (char === ']') {
        this.state = 'osc';
        this.csiParams = '';
        return;
      }
      this.applyEscape(char);
      this.state = 'text';
      return;
    }
    if (this.state === 'csi') {
      // Parameter bytes are digits, `;`, `?`, `>` and intermediates.
      if (char >= '\u0030' && char <= '\u003F') {
        this.csiParams += char;
        return;
      }
      if (char >= '\u0020' && char <= '\u002F') {
        this.csiParams += char;
        return;
      }
      this.applyCsi(char, this.csiParams);
      this.state = 'text';
      this.csiParams = '';
      return;
    }
    switch (char) {
      case '\u001B':
        this.state = 'escape';
        return;
      case '\r':
        this.cursorCol = 0;
        return;
      case '\n':
        this.lineFeed();
        return;
      case '\b':
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        return;
      case '\t':
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        return;
      case '\u0007':
        return;
      default:
        if (char < '\u0020') return;
        this.putChar(char);
    }
  }

  private putChar(char: string): void {
    if (this.cursorCol >= this.cols) {
      // Deferred wrap: writing past the end starts a new line.
      this.cursorCol = 0;
      this.lineFeed();
    }
    const line = this.lines[this.cursorRow];
    if (line === undefined) return;
    line[this.cursorCol] = { ...this.current, char };
    this.cursorCol += 1;
  }

  private lineFeed(): void {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp();
      return;
    }
    this.cursorRow = Math.min(this.rows - 1, this.cursorRow + 1);
  }

  /**
   * Scroll the region up by one: the top line leaves the screen and joins the
   * scrollback, and a blank line appears at the bottom.
   */
  private scrollUp(): void {
    const top = this.scrollTop;
    const bottom = Math.min(this.scrollBottom, this.lines.length - 1);
    if (this.scrollTop === 0) {
      // Only a full-screen scroll produces history; a set region is a
      // full-screen program managing its own layout.
      const leaving = this.lines[top];
      if (leaving !== undefined) {
        this.scrollbackLines.push(leaving);
        const excess = this.scrollbackLines.length - MAX_SCROLLBACK;
        if (excess > 0) this.scrollbackLines.splice(0, excess);
      }
    }
    const moved = this.lines.splice(top, bottom - top + 1);
    moved.shift();
    this.lines.splice(top, 0, ...moved, Array.from({ length: this.cols }, blankCell));
  }

  private applyEscape(char: string): void {
    switch (char) {
      case '7':
        this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
        return;
      case '8':
        this.cursorRow = this.savedCursor.row;
        this.cursorCol = this.savedCursor.col;
        return;
      case 'c':
        this.reset();
        return;
      case 'M': {
        // Reverse index: scroll the region down when at its top margin.
        if (this.cursorRow === this.scrollTop) {
          const top = this.scrollTop;
          const bottom = Math.min(this.scrollBottom, this.lines.length - 1);
          const moved = this.lines.splice(top, bottom - top + 1);
          moved.pop();
          this.lines.splice(top, 0, Array.from({ length: this.cols }, blankCell), ...moved);
          return;
        }
        this.cursorRow = Math.max(0, this.cursorRow - 1);
        return;
      }
      default:
        return;
    }
  }

  private params(raw: string): number[] {
    const cleaned = raw.replace(/^[?>!]/, '');
    if (cleaned.length === 0) return [];
    return cleaned
      .split(';')
      .slice(0, MAX_PARAMS)
      .map((part) => {
        if (part.length === 0) return 0;
        const value = Number.parseInt(part, 10);
        return Number.isFinite(value) ? value : 0;
      });
  }

  private applyCsi(final: string, raw: string): void {
    const args = this.params(raw);
    const first = args[0] === undefined || args[0] === 0 ? 1 : args[0];
    switch (final) {
      case 'A':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - first);
        return;
      case 'B':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + first);
        return;
      case 'C':
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + first);
        return;
      case 'D':
        this.cursorCol = Math.max(0, this.cursorCol - first);
        return;
      case 'E':
        this.cursorRow = Math.min(this.scrollBottom, this.cursorRow + first);
        this.cursorCol = 0;
        return;
      case 'F':
        this.cursorRow = Math.max(this.scrollTop, this.cursorRow - first);
        this.cursorCol = 0;
        return;
      case 'G':
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, first - 1));
        return;
      case 'd':
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, first - 1));
        return;
      case 'H':
      case 'f': {
        const row = args[0] === undefined || args[0] === 0 ? 1 : args[0];
        const col = args[1] === undefined || args[1] === 0 ? 1 : args[1];
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, row - 1));
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, col - 1));
        return;
      }
      case 'J':
        this.eraseDisplay(args[0] ?? 0);
        return;
      case 'K':
        this.eraseLine(args[0] ?? 0);
        return;
      case 'm':
        this.applySgr(args);
        return;
      case 'r': {
        const top = (args[0] ?? 1) - 1;
        const bottom = (args[1] ?? this.rows) - 1;
        this.scrollTop = Math.max(0, Math.min(this.rows - 1, top));
        this.scrollBottom = Math.max(this.scrollTop, Math.min(this.rows - 1, bottom));
        this.cursorRow = this.scrollTop;
        this.cursorCol = 0;
        return;
      }
      case 's':
        this.savedCursor = { row: this.cursorRow, col: this.cursorCol };
        return;
      case 'u':
        this.cursorRow = this.savedCursor.row;
        this.cursorCol = this.savedCursor.col;
        return;
      default:
        return;
    }
  }

  private eraseDisplay(mode: number): void {
    const blank = (): Cell[] => Array.from({ length: this.cols }, blankCell);
    if (mode === 2 || mode === 3) {
      this.lines = Array.from({ length: this.rows }, blank);
      return;
    }
    if (mode === 0) {
      const line = this.lines[this.cursorRow];
      if (line !== undefined) {
        for (let col = this.cursorCol; col < this.cols; col += 1) line[col] = blankCell();
      }
      for (let row = this.cursorRow + 1; row < this.rows; row += 1) this.lines[row] = blank();
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row += 1) this.lines[row] = blank();
      const line = this.lines[this.cursorRow];
      if (line !== undefined) {
        for (let col = 0; col <= this.cursorCol; col += 1) line[col] = blankCell();
      }
    }
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.cursorRow];
    if (line === undefined) return;
    if (mode === 2) {
      this.lines[this.cursorRow] = Array.from({ length: this.cols }, blankCell);
      return;
    }
    if (mode === 0) {
      for (let col = this.cursorCol; col < this.cols; col += 1) line[col] = blankCell();
      return;
    }
    if (mode === 1) {
      for (let col = 0; col <= this.cursorCol; col += 1) line[col] = blankCell();
    }
  }

  private applySgr(args: number[]): void {
    if (args.length === 0) {
      this.current = blankCell();
      return;
    }
    for (let index = 0; index < args.length; index += 1) {
      const code = args[index] ?? 0;
      if (code === 0) {
        this.current = blankCell();
        continue;
      }
      if (code === 1) {
        this.current.bold = true;
        continue;
      }
      if (code === 4) {
        this.current.underline = true;
        continue;
      }
      if (code === 7) {
        this.current.inverse = true;
        continue;
      }
      if (code === 22) {
        this.current.bold = false;
        continue;
      }
      if (code === 24) {
        this.current.underline = false;
        continue;
      }
      if (code === 27) {
        this.current.inverse = false;
        continue;
      }
      if (code === 39) {
        this.current.fg = null;
        continue;
      }
      if (code === 49) {
        this.current.bg = null;
        continue;
      }
      if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        this.current.fg = code >= 90 ? code - 90 + 8 : code - 30;
        continue;
      }
      if (code >= 40 && code <= 47) {
        this.current.bg = code - 40;
        continue;
      }
      if (code >= 100 && code <= 107) {
        this.current.bg = code - 100 + 8;
        continue;
      }
      if (code === 38 || code === 48) {
        // 256-colour and truecolour forms; only the 256-colour index is kept.
        const target = code === 38 ? 'fg' : 'bg';
        const mode = args[index + 1];
        if (mode === 5) {
          const value = args[index + 2];
          if (value !== undefined) this.current[target] = value;
          index += 2;
        } else if (mode === 2) {
          const r = args[index + 2] ?? 0;
          const g = args[index + 3] ?? 0;
          const b = args[index + 4] ?? 0;
          this.current[target] = 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
          index += 4;
        }
      }
    }
  }
}
