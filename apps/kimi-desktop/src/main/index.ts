import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { ensureServer, kimiHome, serverLogPath, stopServer } from './ensure-server';
import { resolveSeaPath } from './sea-path';

// --- fontconfig -----------------------------------------------------------------

/**
 * Point the process at an explicitly resolved fontconfig setup, falling back to
 * the host's own when the AppImage's bundled rules and cache are unusable.
 *
 * The released AppImage bundled `/etc/fonts/conf.d` and a font, but it still
 * used the *host* fontconfig library, so the host reported a cache built by a
 * different Fontconfig version ("We will not regenerate the cache ...") and
 * could not resolve `sans`. A bundled fontconfig library alone does not fix
 * that: its cache directory is inside the AppImage, so on a read-only mount it
 * can neither read nor write a cache and re-scans every font on each launch.
 *
 * Order of preference:
 *   1. an explicit override, so a user can force a setup;
 *   2. the host's `/etc/fonts`, which already has the host's caches and fonts —
 *      this also makes the UI use the host fonts, as it should;
 *   3. the bundled rules, which are all the AppImage can rely on offline.
 *
 * `FONTCONFIG_FILE` / `FONTCONFIG_PATH` are read by the fontconfig library on
 * first use, so they have to be set before the renderer starts.
 */
function configureFonts(): void {
  if (process.env['KIMI_DESKTOP_FONTCONFIG'] !== undefined) return;
  const bundled = join(process.resourcesPath, '..', 'etc', 'fonts');
  if (existsSync('/etc/fonts/fonts.conf')) {
    delete process.env['FONTCONFIG_FILE'];
    delete process.env['FONTCONFIG_PATH'];
    return;
  }
  if (existsSync(join(bundled, 'fonts.conf'))) {
    process.env['FONTCONFIG_FILE'] = join(bundled, 'fonts.conf');
    process.env['FONTCONFIG_PATH'] = bundled;
  }
}

/** Absolute path to the preload bundle, emitted next to the main bundle. */
const preload = join(__dirname, 'preload', 'index.cjs');

let mainWindow: BrowserWindow | null = null;
/** Server started by this process, reaped on quit. Reused servers stay alive. */
let spawnedChild: import('node:child_process').ChildProcess | undefined;
/** Guards against overlapping connect attempts (e.g. retry spam). */
let connecting = false;

// --- window state persistence -------------------------------------------------

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 860 };

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<WindowBounds>;
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return {
        width: parsed.width,
        height: parsed.height,
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
      };
    }
  } catch {
    // No saved state yet, or it is unreadable — fall back to defaults.
  }
  return DEFAULT_BOUNDS;
}

function saveBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }),
    );
  } catch {
    // Best-effort; losing window position is not worth surfacing an error.
  }
}

// --- startup screens (no separate renderer files; inline data URLs) -----------

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const SCREEN_STYLE = `
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: #0b0b0c; color: #e7e7ea; font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
    }
    .spinner {
      width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid #2a2a2e; border-top-color: #7c8cff; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;

function loadingHtml(): string {
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <div class="spinner"></div>
    <h1>正在启动 Kimi 本地服务…</h1>
    <p>首次启动可能需要几秒。</p>`;
}

function errorHtml(message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>无法启动本地服务</h1>
    <p>${safe}</p>
    <p>查看日志：<code>${serverLogPath()}</code></p>
    <p>菜单 → Kimi Code Desktop → 重试连接，或先检查日志。</p>`;
}

// --- server auth token --------------------------------------------------------

/** On-disk filename of the daemon's persistent bearer token (under KIMI_CODE_HOME). */
const SERVER_TOKEN_FILE = 'server.token';

/**
 * Read the daemon's bearer token so the web UI can authenticate without showing
 * the manual token dialog on a fresh launch. Returns undefined when the token
 * cannot be read (the web UI then falls back to the dialog).
 */
function readServerToken(): string | undefined {
  try {
    const token = readFileSync(join(kimiHome(), SERVER_TOKEN_FILE), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

// --- connect flow -------------------------------------------------------------

async function connect(win: BrowserWindow): Promise<void> {
  if (connecting) return;
  connecting = true;
  try {
    // A retry must not leave the previous attempt's server behind.
    stopServer(spawnedChild);
    spawnedChild = undefined;
    await win.loadURL(dataUrl(loadingHtml()));
    try {
      const { origin, child } = await ensureServer(resolveSeaPath());
      spawnedChild = child;
      process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
      if (!win.isDestroyed()) {
        // Append a desktop marker so the web UI shows the internal-build banner
        // even when it is served by an already-running shared daemon (the desktop
        // reuses the local daemon rather than starting a private one). Carry the
        // server token in the `#token=` fragment — like `kimi web` does — so the
        // web UI can authenticate without falling into the manual token dialog on
        // a fresh launch.
        const token = readServerToken();
        const fragment = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
        await win.loadURL(`${origin}/?kimi_desktop=1&platform=${process.platform}${fragment}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[kimi-desktop] ensureServer failed: ${message}\n`);
      if (!win.isDestroyed()) {
        await win.loadURL(dataUrl(errorHtml(message)));
      }
    }
  } finally {
    connecting = false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0b0c',
    title: 'Kimi Code Desktop',
    // macOS: hide the native title bar and float the traffic lights over the
    // content; the web UI reserves a draggable strip at the top to clear them.
    // 'hidden' (not 'hiddenInset') so trafficLightPosition can pin the lights
    // to the vertical center of the web UI's 48px header row.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // The Browser panel is built out of <webview> tags by the preload; the
      // tag is disabled by default.
      webviewTag: true,
      // Nothing here needs a node environment in a subframe.
      sandbox: true,
    },
  });
  mainWindow = win;
  // Keep the window title as the product name. The web page sets document.title
  // ("Kimi Code Web"), which would otherwise replace it.
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // macOS traffic lights.
  //
  // 1) Visibility across transitions: with titleBarStyle 'hidden' + a custom
  //    trafficLightPosition, the buttons can vanish (or lose their custom
  //    position) after a full-screen round-trip or on re-focus. Re-assert both
  //    on those transitions.
  //
  // 2) Blur is NOT such a case: unfocused traffic lights are merely DIMMED by
  //    AppKit, and the dimmed color follows the WINDOW appearance, not the page
  //    (electron#27295) — with the OS in dark mode but the web UI on a light
  //    theme, the light-gray dimmed dots become invisible against the light
  //    sidebar. That is fixed by the theme sync below, which keeps the window
  //    appearance aligned with the web UI's <html data-color-scheme>.
  if (process.platform === 'darwin') {
    const showTrafficLights = (): void => {
      if (win.isDestroyed()) return;
      win.setWindowButtonPosition({ x: 16, y: 18 });
      win.setWindowButtonVisibility(true);
    };
    win.on('enter-full-screen', showTrafficLights);
    win.on('leave-full-screen', showTrafficLights);
    win.on('focus', showTrafficLights);

    // Theme sync used to be injected JavaScript plus a tagged console message,
    // because there was no preload and no IPC. There is a preload now: the web
    // UI calls `window.kimiDesktop.setTheme`, which arrives as an IPC message.
    // The observer below is kept as a fallback for bundles that only report the
    // scheme through <html data-color-scheme> and never call the bridge.
    const THEME_TAG = '__kimi_desktop_theme__:';
    win.webContents.on('console-message', (details) => {
      const message = details.message;
      if (!message.startsWith(THEME_TAG)) return;
      const scheme = message.slice(THEME_TAG.length);
      if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
        nativeTheme.themeSource = scheme;
      }
    });
    win.webContents.on('did-finish-load', () => {
      win.webContents
        .executeJavaScript(
          `(() => {
            const report = () => {
              const v = document.documentElement.dataset.colorScheme;
              console.info(${JSON.stringify(THEME_TAG)} + (v === 'light' || v === 'dark' ? v : 'system'));
            };
            new MutationObserver(report).observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-color-scheme'],
            });
            report();
          })();`,
        )
        .catch(() => {
          // Navigation can tear the page down mid-injection; theme sync is
          // cosmetic, so ignore.
        });
    });
  }
  installUiProbe(win);
  win.on('close', () => {
    saveBounds(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  void connect(win);
}

// --- native menu --------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const appMenu: MenuItemConstructorOptions = {
    label: 'Kimi Code Desktop',
    submenu: [
      ...(isMac ? [{ role: 'about' as const }, { type: 'separator' as const }] : []),
      {
        label: '打开设置',
        click: () => {
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('kimi-desktop:menu-action', 'open-settings');
          }
        },
      },
      {
        label: '重试连接',
        click: () => {
          if (mainWindow !== null) {
            void connect(mainWindow);
          } else {
            createWindow();
          }
        },
      },
      {
        label: '打开服务日志',
        click: () => {
          void shell.openPath(serverLogPath());
        },
      },
      { type: 'separator' },
      isMac ? { role: 'quit' } : { role: 'close' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- release smoke probe ------------------------------------------------------

/**
 * `KIMI_DESKTOP_UI_PROBE=<file>` makes the shell write what the window actually
 * rendered, once it has loaded. `KIMI_DESKTOP.md` calls the release smoke test
 * "a launch test, not a --version probe" — but it only ever waited for
 * `[kimi-desktop] connected to`, so a release could connect and still ship a UI
 * with no usable font stack or with missing bridges (issue #1). This writes the
 * facts the verifier needs, from inside the real renderer.
 */
function installUiProbe(win: BrowserWindow): void {
  const target = process.env['KIMI_DESKTOP_UI_PROBE'];
  if (target === undefined || target.length === 0) return;
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `(() => {
            const probes = ['kimiDesktop', 'kimiBrowser'];
            const bridges = probes.filter((name) => typeof window[name] === 'object');
            const ready = (document.fonts && document.fonts.status === 'loaded') || document.readyState === 'complete';
            let sans = '';
            try {
              const computed = getComputedStyle(document.body).fontFamily || '';
              sans = computed.split(',')[0].replace(/["']/g, '').trim();
            } catch {}
            return { title: document.title, bridges, fontReady: ready, sans, url: location.origin };
          })();`,
        )
        .then((result: unknown) => {
          writeFileSync(target, JSON.stringify(result));
        })
        .catch(() => {
          // The probe is a release smoke aid; never let it take the window down.
        });
    }, 5_000);
  });
}

// --- renderer bridge ----------------------------------------------------------

/**
 * Channels the preload uses. The preload owns the privileged behaviour (the
 * native shell's `webview` surface and the window appearance), the main process
 * only routes and validates.
 */
function installBridge(): void {
  const send = (channel: string, payload: object | string): void => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  ipcMain.on('kimi-browser:theme', (_event, payload: unknown) => {
    const theme = (payload as { theme?: unknown } | null)?.theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      nativeTheme.themeSource = theme;
    }
  });
  ipcMain.on('kimi-browser:event', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return;
    // The Browser panel is not implemented by this shell yet; log what the page
    // asks for instead of dropping it silently, so the gap is visible in the
    // terminal when someone runs the AppImage from one.
    process.stdout.write(`[kimi-desktop] browser event ${JSON.stringify(payload)}\n`);
  });
  ipcMain.on('kimi-desktop:show-window', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.on('kimi-desktop:log', (_event, payload: unknown) => {
    const entry = payload as { level?: unknown; message?: unknown } | null;
    process.stdout.write(
      `[kimi-desktop] renderer ${String(entry?.level ?? 'info')}: ${String(entry?.message ?? '')}\n`,
    );
  });
  ipcMain.on('kimi-desktop:menu-action', (_event, action: unknown) => {
    if (typeof action === 'string') send('kimi-desktop:menu-action', action);
  });
}

// --- app lifecycle ------------------------------------------------------------

function main(): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // `kimi web` is a foreground server with no idle shutdown, so a server the
  // desktop started has to be reaped here. A server started by the CLI is not
  // ours to stop and is left running for the other clients using it.
  app.on('before-quit', () => {
    stopServer(spawnedChild);
    spawnedChild = undefined;
  });

  void app.whenReady().then(() => {
    configureFonts();
    installBridge();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

main();
