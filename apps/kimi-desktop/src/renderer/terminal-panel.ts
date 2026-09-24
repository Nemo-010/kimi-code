// The Terminal panel.
//
// The daemon serves terminals (`POST /sessions/:id/terminals`, PTY I/O over
// `/api/v1/ws`), but the web bundle shipped in this repo no longer creates one:
// its terminal harness was removed and `xterm` has zero hits in it. This mounts
// a terminal in the shell instead, speaking the daemon's own protocol, so it is
// the daemon's PTY the user types into.
//
// It deliberately lives in its own layer above the page rather than inside the
// web UI's DOM: the web UI's markup is generated and minified, and patching it
// would break on the next bundle sync. This panel is part of the shell, so a
// new bundle cannot take it away.
import { TerminalScreen } from './terminal-screen';

/** The 16 ANSI colours, plus a fallback for the 256-colour cube. */
const ANSI_COLORS = [
  '#3f3f46', '#e06c75', '#98c379', '#e5c07b',
  '#61afef', '#c678dd', '#56b6c2', '#d0d0d0',
  '#5c6370', '#ff7b72', '#7ee787', '#ffd866',
  '#79c0ff', '#d2a8ff', '#76e3ea', '#ffffff',
];

function colorFor(index: number | null, fallback: string): string {
  if (index === null) return fallback;
  if (index < 16) return ANSI_COLORS[index] ?? fallback;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  const n = index - 16;
  const r = Math.floor(n / 36);
  const g = Math.floor((n % 36) / 6);
  const b = n % 6;
  const channel = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
  return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
}

export interface TerminalPanelOptions {
  /** Daemon origin, e.g. `http://127.0.0.1:41234`. */
  readonly origin: string;
  /**
   * The daemon's bearer token. A function, because the page receives its
   * credential from the URL fragment after the panel is mounted.
   */
  readonly token: () => string | undefined;
}

/** The store key the web UI keeps its daemon credential under. */
const CREDENTIAL_KEY = 'kimi-web.server-credential';

/**
 * Read the daemon credential the web UI stored. Using the same store means one
 * token, and it stays current as the page rotates it.
 */
export function readCredential(): string | undefined {
  try {
    const raw = window.localStorage.getItem(CREDENTIAL_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { credential?: unknown; expiresAt?: unknown };
    if (typeof parsed.credential !== 'string' || parsed.credential.length === 0) return undefined;
    if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= Date.now()) return undefined;
    return parsed.credential;
  } catch {
    return undefined;
  }
}

/** One terminal tab: its daemon id, its screen and its DOM. */
interface Tab {
  id: string;
  title: string;
  screen: TerminalScreen;
  /** One element per visible row; rebuilt only when the row count changes. */
  element: HTMLDivElement;
  textRows: HTMLDivElement[];
  cursor: HTMLSpanElement;
  cols: number;
  rows: number;
  exited: boolean;
}

export class TerminalPanel {
  private readonly root: HTMLDivElement;
  private readonly tabBar: HTMLDivElement;
  private readonly viewport: HTMLDivElement;
  private readonly tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private socket: WebSocket | undefined;
  private readonly pending = new Map<string, (value: unknown) => void>();
  private requestCounter = 0;
  private sessionId: string | null = null;
  private resizeTimer: number | undefined;
  /** The `resize` handler, held so `dispose` can unbind it. */
  private onWindowResize: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: TerminalPanelOptions) {
    this.root = document.createElement('div');
    this.root.className = 'kimi-terminal-panel';
    this.root.hidden = true;
    this.root.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      'bottom:0',
      'height:320px',
      'min-height:120px',
      'background:#0b0b0c',
      'border-top:1px solid #27272a',
      'z-index:2147483000',
      'display:flex',
      'flex-direction:column',
      'font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      'color:#e4e4e7',
    ].join(';');

    this.tabBar = document.createElement('div');
    this.tabBar.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #27272a;flex:0 0 auto';

    this.viewport = document.createElement('div');
    this.viewport.style.cssText = 'flex:1 1 auto;overflow:auto;padding:8px';

    this.root.append(this.tabBar, this.viewport);
    document.body.append(this.root);

    this.renderTabs();
  }

  /** Whether the panel is currently visible. */
  get visible(): boolean {
    return !this.root.hidden;
  }

  /** How many terminals are open. */
  get tabCount(): number {
    return this.tabs.size;
  }

  /** Tell the panel which session new terminals belong to. */
  setSession(sessionId: string | null): void {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId;
  }

  show(): void {
    this.root.hidden = false;
    this.refit();
  }

  hide(): void {
    this.root.hidden = true;
  }

  toggle(): boolean {
    if (this.visible) {
      this.hide();
      return false;
    }
    this.show();
    return true;
  }

  /** Open a new terminal in the current session. */
  async open(cwd?: string): Promise<void> {
    if (this.sessionId === null) {
      this.sessionId = await this.resolveSession();
    }
    if (this.sessionId === null) {
      this.writeNotice('Open a session first, then start a terminal.');
      this.show();
      return;
    }
    const { cols, rows } = this.gridSize();
    let created: Record<string, unknown>;
    try {
      created = (await this.rest('POST', `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/terminals`, {
        cwd,
        cols,
        rows,
      })) as Record<string, unknown>;
    } catch (error) {
      this.writeNotice(error instanceof Error ? error.message : 'Could not create a terminal.');
      this.show();
      return;
    }
    const id = typeof created['id'] === 'string' ? created['id'] : '';
    if (id.length === 0) {
      this.writeNotice('The terminal was created without an id.');
      return;
    }
    const screen = new TerminalScreen(cols, rows);
    const element = document.createElement('div');
    element.style.cssText = 'margin:0;white-space:pre;tab-size:8';
    const cursor = document.createElement('span');
    cursor.style.cssText = 'background:#e4e4e7;color:#0b0b0c;width:0.6em;display:inline-block';
    const tab: Tab = {
      id,
      title: typeof created['shell'] === 'string' ? String(created['shell']) : 'Terminal',
      screen,
      element,
      textRows: [],
      cursor,
      cols,
      rows,
      exited: false,
    };
    this.tabs.set(id, tab);
    this.activeId = id;
    this.viewport.append(element);
    this.renderTabs();
    this.select(id);
    this.attach(id);
    this.show();
  }

  /** Close the active terminal, or a named one. */
  async closeTab(terminalId?: string): Promise<void> {
    const id = terminalId ?? this.activeId;
    if (id === null) return;
    const tab = this.tabs.get(id);
    if (tab === undefined) return;
    this.send({ type: 'terminal_detach', payload: { session_id: this.sessionId, terminal_id: id } });
    this.tabs.delete(id);
    tab.element.remove();
    if (this.activeId === id) {
      this.activeId = [...this.tabs.keys()].at(-1) ?? null;
    }
    this.renderTabs();
    this.refit();
    if (this.sessionId !== null) {
      try {
        await this.rest(
          'POST',
          `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/terminals/${encodeURIComponent(id)}:close`,
          {},
        );
      } catch {
        // It is already gone from the panel; the daemon will reap the process.
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer);
    // The listener is bound to the window, not to the panel, so removing the
    // panel's element does not remove it. Leaving it attached leaks one handler
    // per panel and keeps the panel object alive through its closure.
    if (this.onWindowResize !== undefined) {
      window.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = undefined;
    }
    // Terminals belong to the daemon and keep running after the panel is gone,
    // so closing the panel has to close them. Rendering this without telling
    // the daemon would leave a shell alive with no way to reach it.
    for (const tab of this.tabs.values()) {
      if (tab.exited || this.sessionId === null) continue;
      try {
        void this.rest(
          'POST',
          `/api/v1/sessions/${encodeURIComponent(this.sessionId)}/terminals/${encodeURIComponent(tab.id)}:close`,
          {},
        );
      } catch {
        // Best effort: the daemon reaps a terminal whose session ends anyway.
      }
    }
    this.tabs.clear();
    this.socket?.close();
    this.socket = undefined;
    this.root.remove();
  }

  // --- daemon plumbing --------------------------------------------------------

  /**
   * Find the session new terminals belong to. The web UI keeps its active
   * session in its own store rather than the URL, so the daemon's session list
   * is the authority: the most recently updated session is the one the user is
   * working in.
   */
  private async resolveSession(): Promise<string | null> {
    const fromUrl = new URLSearchParams(window.location.search).get('session');
    if (fromUrl !== null && fromUrl.length > 0) return fromUrl;
    try {
      const data = (await this.rest('GET', '/api/v1/sessions?limit=1', undefined)) as {
        items?: { id?: unknown }[];
      };
      const newest = data.items?.[0]?.id;
      return typeof newest === 'string' && newest.length > 0 ? newest : null;
    } catch {
      return null;
    }
  }

  private connect(): WebSocket {
    if (this.socket !== undefined && this.socket.readyState <= WebSocket.OPEN) return this.socket;
    const wsUrl = `${this.options.origin.replace(/^http/, 'ws')}/api/v1/ws`;
    // The daemon reads its bearer token from the WebSocket subprotocol
    // (`bearerProtocol.ts`), not from a query parameter.
    const token = this.options.token();
    const socket =
      token === undefined ? new WebSocket(wsUrl) : new WebSocket(wsUrl, [`kimi-code.bearer.${token}`]);
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      this.onFrame(event.data);
    });
    socket.addEventListener('close', () => {
      this.socket = undefined;
      if (this.disposed) return;
      for (const tab of this.tabs.values()) {
        if (!tab.exited) tab.screen.write('\r\n[connection closed]\r\n');
        tab.exited = true;
        this.paint(tab);
      }
      for (const resolve of this.pending.values()) resolve(undefined);
      this.pending.clear();
    });
    return socket;
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.connect();
    const frame = JSON.stringify({ ...payload, id: `t${++this.requestCounter}` });
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(frame);
      return;
    }
    socket.addEventListener(
      'open',
      () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      },
      { once: true },
    );
  }

  private attach(terminalId: string): void {
    this.send({
      type: 'terminal_attach',
      payload: { session_id: this.sessionId, terminal_id: terminalId },
    });
  }

  private onFrame(text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof frame['type'] === 'string' ? frame['type'] : '';
    // Events carry `terminal_id` at the top level, not inside the payload
    // (`terminalOutputMessageSchema` in the daemon's ws-control protocol).
    // Reading it from the payload would drop every frame.
    const terminalId = typeof frame['terminal_id'] === 'string' ? frame['terminal_id'] : undefined;
    if (terminalId === undefined) return;
    const payload = (frame['payload'] ?? {}) as Record<string, unknown>;
    if (type === 'terminal_output') {
      const tab = this.tabs.get(terminalId);
      if (tab === undefined) return;
      // PTY output is already text (`onData` passes the string through).
      tab.screen.write(typeof payload['data'] === 'string' ? payload['data'] : '');
      this.paint(tab);
      return;
    }
    if (type === 'terminal_exit') {
      const tab = this.tabs.get(terminalId);
      if (tab === undefined) return;
      const code = payload['exit_code'];
      tab.screen.write(`\r\n[process exited${typeof code === 'number' ? ` with code ${code}` : ''}]\r\n`);
      tab.exited = true;
      this.paint(tab);
      this.renderTabs();
    }
  }

  private async rest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = this.options.token();
    const response = await fetch(`${this.options.origin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`The terminal request failed (${response.status}).`);
    const envelope = (await response.json()) as { code?: number; msg?: string; data?: unknown };
    if (typeof envelope.code === 'number' && envelope.code !== 0) {
      throw new Error(envelope.msg ?? 'The terminal request failed.');
    }
    return envelope.data ?? envelope;
  }

  // --- rendering --------------------------------------------------------------

  private gridSize(): { cols: number; rows: number } {
    const width = this.viewport.clientWidth || this.root.clientWidth || 800;
    const height = this.viewport.clientHeight || this.root.clientHeight || 300;
    // Approximate advance width for the monospace stack above.
    return {
      cols: Math.max(20, Math.floor((width - 16) / 7.2)),
      rows: Math.max(5, Math.floor((height - 16) / 16.8)),
    };
  }

  private paint(tab: Tab): void {
    if (tab.id !== this.activeId) return;
    const rows = tab.screen.visible();
    const { row: cursorRow, col: cursorCol } = tab.screen.cursor();
    // Rebuild the visible grid. Only the rows on screen are written, and each
    // row is a plain string, so the DOM stays flat no matter how much output
    // has scrolled past.
    if (tab.rows !== tab.textRows.length) {
      tab.textRows = Array.from({ length: tab.rows }, () => {
        const line = document.createElement('div');
        return line;
      });
      tab.element.replaceChildren(...tab.textRows);
    }
    for (let row = 0; row < tab.rows; row += 1) {
      const line = tab.textRows[row];
      if (line === undefined) continue;
      const cells = rows[row] ?? [];
      let text = '';
      for (let col = 0; col < tab.cols; col += 1) {
        const cell = cells[col];
        if (row === cursorRow && col === cursorCol && !tab.exited) {
          // A placeholder, so the cursor element can be placed exactly here.
          text += '\u0000';
          continue;
        }
        text += cell?.char ?? ' ';
      }
      const parts = text.split('\u0000');
      if (parts.length === 1) {
        line.textContent = text;
        continue;
      }
      line.replaceChildren(
        document.createTextNode(parts[0] ?? ''),
        tab.cursor,
        document.createTextNode(parts[1] ?? ''),
      );
    }
    const at = rows[cursorRow]?.[cursorCol];
    tab.cursor.textContent = at === undefined || at.char === ' ' ? ' ' : at.char;
    tab.cursor.style.visibility = tab.exited || !tab.screen.cursorShown ? 'hidden' : 'visible';
  }

  private renderTabs(): void {
    this.tabBar.textContent = '';
    const title = document.createElement('span');
    title.textContent = 'Terminal';
    title.style.cssText = 'opacity:0.7;margin-right:4px';
    this.tabBar.append(title);

    for (const tab of this.tabs.values()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = tab.exited ? `${tab.title} (exited)` : tab.title;
      button.style.cssText = [
        'background:transparent',
        'border:1px solid #27272a',
        'border-radius:4px',
        'color:inherit',
        'font:inherit',
        'padding:2px 8px',
        'cursor:pointer',
        tab.id === this.activeId ? 'background:#27272a' : '',
      ].join(';');
      button.addEventListener('click', () => this.select(tab.id));
      this.tabBar.append(button);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+';
    add.title = 'New terminal';
    add.style.cssText =
      'background:transparent;border:1px solid #27272a;border-radius:4px;color:inherit;font:inherit;padding:2px 8px;cursor:pointer';
    add.addEventListener('click', () => {
      void this.open();
    });
    this.tabBar.append(add);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = 'Close';
    closeButton.style.cssText =
      'margin-left:auto;background:transparent;border:1px solid #27272a;border-radius:4px;color:inherit;font:inherit;padding:2px 8px;cursor:pointer';
    closeButton.addEventListener('click', () => this.hide());
    this.tabBar.append(closeButton);
  }

  private select(terminalId: string): void {
    const tab = this.tabs.get(terminalId);
    if (tab === undefined) return;
    this.activeId = terminalId;
    for (const other of this.tabs.values()) other.element.hidden = other.id !== terminalId;
    this.renderTabs();
    this.refit();
    this.paint(tab);
    this.focus();
  }

  private focus(): void {
    // Keystrokes belong to the terminal while it is open. The listener below is
    // attached to the panel's own viewport so the page keeps its own input.
    this.viewport.focus();
  }

  /** Resize the PTY to the panel, so full-screen programs lay out correctly. */
  private refit(): void {
    const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
    if (tab === undefined || this.sessionId === null) return;
    const { cols, rows } = this.gridSize();
    if (cols === tab.cols && rows === tab.rows) return;
    tab.cols = cols;
    tab.rows = rows;
    tab.screen.resize(cols, rows);
    this.paint(tab);
    this.send({
      type: 'terminal_resize',
      payload: { session_id: this.sessionId, terminal_id: tab.id, cols, rows },
    });
  }

  private writeNotice(message: string): void {
    this.viewport.textContent = '';
    const line = document.createElement('pre');
    line.style.cssText = 'margin:0;color:#a1a1aa';
    line.textContent = message;
    this.viewport.append(line);
  }

  /** Wire keyboard input and the resize observer. */
  install(): void {
    this.viewport.tabIndex = 0;
    this.viewport.addEventListener('keydown', (event: KeyboardEvent) => {
      const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
      if (tab === undefined || this.sessionId === null) return;
      // Let our own shortcuts through, send everything else to the PTY.
      if (event.metaKey || (event.ctrlKey && event.shiftKey)) return;
      if (event.ctrlKey && event.key === '`') return;
      // PageUp and PageDown read history in this shell rather than reaching the
      // PTY, so they are handled here instead of being encoded.
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        if (tab.screen.scrollback() === 0) return;
        tab.screen.holdScroll = true;
        tab.screen.scrollBy(event.key === 'PageUp' ? tab.rows : -tab.rows);
        this.paint(tab);
        event.preventDefault();
        return;
      }
      const data = keyToBytes(event);
      if (data === null) return;
      event.preventDefault();
      if (tab.exited) return;
      this.send({
        type: 'terminal_input',
        payload: { session_id: this.sessionId, terminal_id: tab.id, data },
      });
    });
    this.viewport.addEventListener('paste', (event: ClipboardEvent) => {
      const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
      if (tab === undefined || this.sessionId === null || tab.exited) return;
      const text = event.clipboardData?.getData('text');
      if (text === undefined || text.length === 0) return;
      event.preventDefault();
      this.send({
        type: 'terminal_input',
        payload: { session_id: this.sessionId, terminal_id: tab.id, data: text },
      });
    });
    // Scrolling back through history. While the user is reading, incoming
    // output must not yank the view to the bottom.
    this.viewport.addEventListener(
      'wheel',
      (event: WheelEvent) => {
        const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
        if (tab === undefined) return;
        if (tab.screen.scrollback() === 0) return;
        const lines = event.deltaY > 0 ? -3 : 3;
        tab.screen.holdScroll = true;
        tab.screen.scrollBy(lines);
        this.paint(tab);
        event.preventDefault();
      },
      { passive: false },
    );
    // PageUp/PageDown walk history; any other key returns to the live screen.
    this.viewport.addEventListener('keydown', (event: KeyboardEvent) => {
      const tab = this.activeId === null ? undefined : this.tabs.get(this.activeId);
      if (tab === undefined) return;
      if (event.key === 'PageUp' || event.key === 'PageDown') return;
      if (tab.screen.scrollingBack) {
        tab.screen.holdScroll = false;
        tab.screen.scrollToBottom();
        this.paint(tab);
      }
    });
    this.onWindowResize = () => {
      if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.refit(), 120);
    };
    window.addEventListener('resize', this.onWindowResize);
  }
}

/** Translate a key event into the byte sequence a PTY expects. */
function keyToBytes(event: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey } = event;
  if (key === 'Enter') return '\r';
  if (key === 'Backspace') return '\u007F';
  if (key === 'Tab') return '\t';
  if (key === 'Escape') return '\u001B';
  if (key === 'ArrowUp') return '\u001B[A';
  if (key === 'ArrowDown') return '\u001B[B';
  if (key === 'ArrowRight') return '\u001B[C';
  if (key === 'ArrowLeft') return '\u001B[D';
  if (key === 'Home') return '\u001B[H';
  if (key === 'End') return '\u001B[F';
  if (key === 'Delete') return '\u001B[3~';
  if (key === 'PageUp') return '\u001B[5~';
  if (key === 'PageDown') return '\u001B[6~';
  if (key.length === 1) {
    if (ctrlKey) {
      const code = key.toUpperCase().codePointAt(0) ?? 0;
      // Ctrl-A..Ctrl-Z and the usual control punctuation map to 1..26 and 0x1c+.
      if (code >= 64 && code <= 95) return String.fromCodePoint(code - 64);
      if (key === ' ') return '\u0000';
    }
    return altKey ? `\u001B${key}` : key;
  }
  return null;
}

export { ANSI_COLORS, colorFor };
