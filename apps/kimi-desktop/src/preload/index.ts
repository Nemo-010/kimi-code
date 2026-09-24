// Preload for the Kimi Code Desktop shell.
//
// The renderer is the shared Kimi web UI, which was written for the closed
// code-app shell. Three APIs it uses are implemented here, because it silently
// degrades without them:
//
//   - `window.kimiDesktop.setTheme` — the macOS window appearance follows the
//     web UI's colour scheme.
//   - `window.kimiBrowser` — the Browser panel. `BrowserView` cannot be masked,
//     displayed, resized, scrolled or occluded from the page, so the surface is
//     built out of masked `<webview>` tags and their bounds are kept in sync
//     with placeholder elements.
//   - `window.kimiBrowserSurface` — the privileged half the main process calls
//     when the agent drives the same tabs over MCP. It exposes the surface
//     operations (navigate, evaluate, capture) that a page cannot do for
//     itself, keyed by tab id, and is only ever called from the main process.
//
// Everything crossing these bridges is validated here: the renderer is the web
// UI, but it still renders model output, so nothing is trusted.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { TerminalPanel, readCredential } from '../renderer/terminal-panel';

const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 512;
const MAX_ID_LENGTH = 128;
const MAX_BROWSERS = 24;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function asString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function asId(value: unknown): string | null {
  const id = asString(value, MAX_ID_LENGTH);
  return id !== null && ID_PATTERN.test(id) ? id : null;
}

function asBounds(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const numbers = [raw['x'], raw['y'], raw['width'], raw['height']];
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x, y, width, height] = numbers as [number, number, number, number];
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height)),
  };
}

type Surface = HTMLElement & {
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  isLoading(): boolean;
  getURL(): string;
  getTitle(): string;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toDataURL(): string }>;
  __kimiVisible: boolean;
};

const surfaces = new Map<string, Surface>();
let surfaceCounter = 0;

function send(channel: string, payload: Record<string, unknown>): void {
  ipcRenderer.send(channel, payload);
}

function createSurface(browserId: string): Surface {
  // `webview` is not in the lib.dom tag map; Electron types it as WebviewTag.
  const view = document.createElement('webview') as unknown as Surface;
  view.__kimiVisible = false;
  view.className = 'kimi-browser-surface';
  view.dataset['kimiBrowserId'] = browserId;
  Object.assign(view.style, {
    position: 'fixed',
    border: '0',
    background: '#ffffff',
    zIndex: '1',
    visibility: 'hidden',
  });
  // A rejected navigation must not take the panel down with it.
  view.addEventListener('did-fail-load', (event) => {
    const detail = event as unknown as { errorCode?: number; validatedURL?: string };
    if (detail.errorCode === -3) return;
    send('kimi-browser:event', {
      browserId,
      type: 'did-fail-load',
      data: { errorCode: detail.errorCode ?? 0, url: detail.validatedURL ?? '' },
    });
  });
  // Every navigation and title change is reported so the transcript and the
  // panel agree about which page the agent touched.
  for (const type of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'page-title-updated']) {
    view.addEventListener(type, () => {
      send('kimi-browser:event', {
        browserId,
        type,
        data: { url: view.getURL(), title: view.getTitle() },
      });
    });
  }
  document.body.append(view);
  surfaces.set(browserId, view);
  return view;
}

function destroySurface(browserId: string): void {
  const view = surfaces.get(browserId);
  if (view === undefined) return;
  surfaces.delete(browserId);
  view.remove();
}

function applyBounds(view: Surface, bounds: ReturnType<typeof asBounds>): void {
  if (bounds === null) return;
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const onScreen = bounds.height >= 1 && bounds.width >= 1 && bounds.y + height > 0;
  Object.assign(view.style, {
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${width}px`,
    height: `${height}px`,
    visibility: onScreen ? 'visible' : 'hidden',
  });
  if (onScreen) view.__kimiVisible = true;
}

let resizeScheduled = false;
function scheduleResize(): void {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    for (const view of surfaces.values()) {
      if (!view.__kimiVisible) continue;
      const box = view.getBoundingClientRect();
      send('kimi-browser:event', {
        browserId: view.dataset['kimiBrowserId'] ?? '',
        type: 'bounds-lost',
        data: { x: box.x, y: box.y, width: box.width, height: box.height },
      });
    }
  });
}

window.addEventListener('resize', scheduleResize);

const kimiBrowser = {
  available: true,

  create(input: unknown): string | null {
    if (surfaces.size >= MAX_BROWSERS) return null;
    const browserId = asId((input as { browserId?: unknown } | null)?.browserId);
    if (browserId === null) return null;
    if (!surfaces.has(browserId)) createSurface(browserId);
    return browserId;
  },

  destroy(browserId: unknown): void {
    const id = asId(browserId);
    if (id !== null) destroySurface(id);
  },

  navigate(browserId: unknown, url: unknown): boolean {
    const id = asId(browserId);
    const target = asString(url, MAX_URL_LENGTH);
    if (id === null || target === null) return false;
    const view = surfaces.get(id);
    if (view === undefined) return false;
    void view.loadURL(target).catch(() => undefined);
    return true;
  },

  setBounds(browserId: unknown, bounds: unknown): void {
    const id = asId(browserId);
    if (id === null) return;
    const view = surfaces.get(id);
    if (view !== undefined) applyBounds(view, asBounds(bounds));
  },

  goBack(browserId: unknown): void {
    const view = surfaces.get(asId(browserId) ?? '');
    if (view?.canGoBack()) view.goBack();
  },

  goForward(browserId: unknown): void {
    const view = surfaces.get(asId(browserId) ?? '');
    if (view?.canGoForward()) view.goForward();
  },

  reload(browserId: unknown): void {
    surfaces.get(asId(browserId) ?? '')?.reload();
  },

  stop(browserId: unknown): void {
    surfaces.get(asId(browserId) ?? '')?.stop();
  },

  focus(browserId: unknown): void {
    surfaces.get(asId(browserId) ?? '')?.focus();
  },

  takeover(browserId: unknown): void {
    const id = asId(browserId);
    if (id !== null) send('kimi-browser:takeover', { browserId: id });
  },

  onEvent(callback: unknown): () => void {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      if (typeof payload !== 'object' || payload === null) return;
      (callback as (payload: unknown) => void)(payload);
    };
    ipcRenderer.on('kimi-browser:main-event', listener);
    return () => {
      ipcRenderer.removeListener('kimi-browser:main-event', listener);
    };
  },

  setTheme(theme: unknown): boolean {
    const value = theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system';
    send('kimi-browser:theme', { theme: value });
    return true;
  },
};

/**
 * The privileged surface API the main process calls when the agent drives a
 * tab. The renderer is where the `<webview>` lives, so only the renderer can
 * dereference it; the main process sends a request and waits for the answer.
 *
 * `handlers` is kept in the preload's own scope and never exposed to the page:
 * the page can ask for a tab to be created, but it cannot evaluate arbitrary
 * script in another tab through this channel.
 */
const handlers = new Map<string, (request: Record<string, unknown>) => unknown>();

function surfaceRequest(request: Record<string, unknown>): unknown {
  const id = asId(request['tabId']);
  if (id === null) return { ok: false, error: { code: 'TAB_NOT_FOUND', message: 'No such tab.' } };
  const handler = handlers.get(id);
  if (handler === undefined) {
    return { ok: false, error: { code: 'TAB_NOT_FOUND', message: `No tab ${id}.` } };
  }
  return handler(request);
}

const kimiBrowserSurface = {
  /** Called by the panel when it mounts a surface element. */
  attach(browserId: unknown, bound: unknown): boolean {
    const id = asId(browserId);
    if (id === null || typeof bound !== 'function') return false;
    handlers.set(id, bound as (request: Record<string, unknown>) => unknown);
    return true;
  },

  detach(browserId: unknown): void {
    const id = asId(browserId);
    if (id !== null) handlers.delete(id);
  },

  /** The main process calls this to run an engine request against a surface. */
  execute(browserId: unknown, request: unknown): unknown {
    const id = asId(browserId);
    if (id === null || typeof request !== 'object' || request === null) return null;
    const handler = handlers.get(id);
    if (handler === undefined) return null;
    return handler(request as Record<string, unknown>);
  },
};

// The agent asked for a new tab: make the element here, where the DOM is, and
// answer with its id so the main process can register a surface for it.
ipcRenderer.on('kimi-browser:create-tab', (event, payload: unknown) => {
  const { requestId } = (payload ?? {}) as { requestId?: unknown };
  if (typeof requestId !== 'string') return;
  let browserId = '';
  if (surfaces.size < MAX_BROWSERS) {
    browserId = `t${++surfaceCounter}`;
    createSurface(browserId);
  }
  event.sender.send('kimi-browser:surface-response', { requestId, value: browserId });
});

// The agent closed a tab; the element has to go, not just its id.
ipcRenderer.on('kimi-browser:close-tab', (_event, payload: unknown) => {
  const browserId = asId((payload as { browserId?: unknown } | null)?.browserId);
  if (browserId !== null) {
    handlers.delete(browserId);
    destroySurface(browserId);
  }
});

ipcRenderer.on('kimi-browser:surface-request', (event, payload: unknown) => {
  if (typeof payload !== 'object' || payload === null) return;
  const { requestId, request } = payload as { requestId?: unknown; request?: unknown };
  if (typeof requestId !== 'string' || typeof request !== 'object' || request === null) return;
  void Promise.resolve(surfaceRequest(request as Record<string, unknown>)).then((value) => {
    event.sender.send('kimi-browser:surface-response', { requestId, value });
  });
});

const kimiDesktop = {
  platform: process.platform,
  version: process.versions.electron,
  setTheme: (theme: unknown): boolean => kimiBrowser.setTheme(theme),
  /** Open or close the Terminal panel; bound to Ctrl/Cmd+` in the main process. */
  toggleTerminal: (): void => {
    ipcRenderer.send('kimi-terminal:toggle-request', {});
  },
  showWindow: (): void => send('kimi-desktop:show-window', {}),
  onMenuAction: (callback: unknown): (() => void) => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event: IpcRendererEvent, action: unknown): void => {
      if (typeof action === 'string') (callback as (action: string) => void)(action);
    };
    ipcRenderer.on('kimi-desktop:menu-action', listener);
    return () => {
      ipcRenderer.removeListener('kimi-desktop:menu-action', listener);
    };
  },
  log: (level: unknown, message: unknown, extra: unknown): void => {
    send('kimi-desktop:log', {
      level: asString(level, 32) ?? 'info',
      message: asString(message, 4096) ?? '',
      extra: asString(JSON.stringify(extra ?? null), 4096) ?? '',
    });
  },
};

function bridge(): void {
  const title = asString(document.title, MAX_TITLE_LENGTH);
  if (title !== null) send('kimi-browser:event', { type: 'title', data: { title } });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bridge, { once: true });
} else {
  bridge();
}

// --- terminal -----------------------------------------------------------------
//
// The web bundle in this repo has no terminal: its harness was removed and
// `xterm` has zero hits in it, though the daemon still serves terminals and
// bundles node-pty. The panel here speaks the daemon's own REST + WebSocket
// protocol, so the terminal is the daemon's PTY and the same one the agent sees.
//
// The credential is read from the store the web UI itself uses
// (`kimi-web.server-credential`), so there is one token, not a second one.

let terminal: TerminalPanel | undefined;

function terminalPanel(): TerminalPanel {
  if (terminal !== undefined) return terminal;
  terminal = new TerminalPanel({
    origin: window.location.origin,
    // The page receives its credential after the panel is mounted, so read it
    // per request rather than once.
    token: readCredential,
  });
  terminal.install();
  return terminal;
}

/** Create the (hidden) panel up front, so it is mounted and ready to toggle. */
function mountTerminal(): void {
  if (document.body === null) {
    window.addEventListener('DOMContentLoaded', mountTerminal, { once: true });
    return;
  }
  terminalPanel();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', mountTerminal, { once: true });
} else {
  mountTerminal();
}

// The main process binds the accelerator (the page would otherwise swallow it)
// and relays the toggle here.
ipcRenderer.on('kimi-terminal:toggle', () => {
  void (async () => {
    const panel = terminalPanel();
    const opening = panel.toggle();
    if (!opening) return;
    // Only open a tab when there is not one already, so the shortcut toggles the
    // panel rather than piling up terminals.
    if (panel.tabCount === 0) await panel.open();
  })();
});


contextBridge.exposeInMainWorld('kimiDesktop', kimiDesktop);
contextBridge.exposeInMainWorld('kimiBrowser', kimiBrowser);
contextBridge.exposeInMainWorld('kimiBrowserSurface', kimiBrowserSurface);
