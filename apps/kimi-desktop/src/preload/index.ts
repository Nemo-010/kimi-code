// Preload for the Kimi Code Desktop shell.
//
// The renderer is the shared Kimi web UI, which was written for the closed
// code-app shell. Two of the APIs that shell used to expose are implemented
// here, because the renderer silently degrades without them:
//
//   - `window.kimiDesktop.setTheme` — the macOS window appearance follows the
//     web UI's colour scheme. The main process used to get this from a tagged
//     `console-message` plus injected JavaScript; with a preload it is a direct
//     call.
//   - `window.kimiBrowser` — the Browser panel that shows up in the quick open
//     list on macOS. `BrowserView` cannot be masked, displayed, resized or
//     scrolled from the page, so the preload builds the surface out of masked
//     `<webview>` tags and keeps their bounds in sync with placeholder
//     elements, which is what the panel needs to be able to clip, scroll and
//     occlude it.
//
// Everything crossing this bridge is validated here: the renderer is the web
// UI, but it still renders model output, so nothing is trusted.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

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
  __kimiVisible: boolean;
};

const surfaces = new Map<string, Surface>();

function send(channel: string, payload: Record<string, unknown>): void {
  ipcRenderer.send(channel, payload);
}

function createSurface(browserId: string): Surface {
  // `webview` is not in the lib.dom tag map; Electron types it as WebviewTag.
  const view = document.createElement('webview') as unknown as Surface;
  view.__kimiVisible = false;
  view.className = 'kimi-browser-surface';
  view.setAttribute('data-kimi-browser-id', browserId);
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
        browserId: view.getAttribute('data-kimi-browser-id') ?? '',
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
    const view = surfaces.get(asId(browserId) ?? '');
    view?.reload();
  },

  stop(browserId: unknown): void {
    const view = surfaces.get(asId(browserId) ?? '');
    view?.stop();
  },

  focus(browserId: unknown): void {
    surfaces.get(asId(browserId) ?? '')?.focus();
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
    const value =
      theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system';
    send('kimi-browser:theme', { theme: value });
    return true;
  },
};

const kimiDesktop = {
  platform: process.platform,
  version: process.versions.electron,
  setTheme: kimiBrowser.setTheme,
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

contextBridge.exposeInMainWorld('kimiDesktop', kimiDesktop);
contextBridge.exposeInMainWorld('kimiBrowser', kimiBrowser);
