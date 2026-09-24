# Portable AppImages (pkgforge-dev quick-sharun)

These scripts build the fork's Linux AppImages with
[`quick-sharun.sh`](https://github.com/pkgforge-dev/Anylinux-AppImages/blob/main/useful-tools/quick-sharun.sh),
following
[HOW-TO-MAKE-THESE.md](https://github.com/pkgforge-dev/Anylinux-AppImages/blob/main/HOW-TO-MAKE-THESE.md).
They are run by [`.github/workflows/appimage.yml`](../../.github/workflows/appimage.yml)
inside the pkgforge Arch Linux container.

- `kimi-code/` — the CLI, from the Node SEA single executable.
- `kimi-desktop/` — the Electron client, from the `electron-builder --dir` output.

Each directory has a `get-dependencies.sh` (system packages, debloated packages,
staging the app) and a `make-appimage.sh` (`quick-sharun` + `--make-appimage`).

## Notes for whoever runs this

- **Build on Arch Linux.** The pkgforge guide is explicit that other distros
  (especially ones that put 32-bit libraries in `/usr/lib`) produce broken
  bundles. Building on anything but Arch is a very bad idea.
- **Install the application to `/usr` before deploying.** `quick-sharun` is
  meant to deploy an application that is installed on the build system; the
  scripts here build it in the checkout and stage it into the AppDir, which is
  the equivalent for a monorepo app that is not packaged yet.
- **Do not copy libraries by hand.** Everything the app needs is passed to
  `quick-sharun`, which finds the dlopened libraries itself.
- `NO_STRIP=binaries` is set because stripping a Node SEA binary removes its
  dynamic section and breaks it; libraries are still stripped.
- The Electron AppImage bundles the Electron runtime (Chromium). There is no way
  around that for the desktop client; the CLI AppImage has no Electron bloat.

## The Browser panel and the agent's browser tool

The commit that produced issue #1 shipped a desktop with no preload and no IPC.
The web UI is the shared Kimi front end, so it offered a Browser panel and
probed for `window.kimiDesktop` / `window.kimiBrowser`; both were `undefined` and
the panel was offered-but-dead. The shell now provides them:

- `apps/kimi-desktop/src/preload/index.ts` builds the browser surface from masked
  `<webview>` tags. `BrowserView` cannot be masked, moved or occluded by the page,
  so it cannot back a panel.
- `apps/kimi-desktop/src/main/browser-engine.ts` implements the
  `kimi.browser/1.0.0` operations and `browser-mcp.ts` + `browser-http.ts` expose
  them as the `desktop_browser` MCP server, over Streamable HTTP on loopback.
  The web bundle renders the tool as `mcp__desktop_browser__run`; if either half
  of that name changes, the panel silently loses its renderer.
- The transport is HTTP rather than stdio on purpose. **The AppImage ships no
  Node interpreter**: its only executable is Electron, whose path lives inside
  the AppImage mount, so a stdio MCP entry could never be spawned. The main
  process serves the protocol itself and writes the endpoint (with a bearer
  token, `chmod 600`) into `<KIMI_CODE_HOME>/mcp.json` on launch.

The token is in that file, so it must stay owner-only; the endpoint binds
`127.0.0.1` so the browser is never reachable from the network.

## The Terminal panel

The web bundle this repo ships has no terminal. Its terminal harness was
removed: there is no `term` entry in the renderer map, no `case"term"` in the tab
renderer, and `xterm` does not appear in the bundle at all. Only the translation
strings survive, so a panel offered by an older bundle cannot be brought back by
anything the shell does. The daemon still serves terminals and still bundles
node-pty.

So the shell provides the panel, above the page rather than inside it:

- `apps/kimi-desktop/src/renderer/terminal-screen.ts` is a VT emulator (cursor
  movement, scroll regions, SGR colours, bounded scrollback). It is written by
  hand because the desktop bundles everything into the AppImage and ships no
  `xterm`.
- `apps/kimi-desktop/src/renderer/terminal-panel.ts` drives it. It creates a
  terminal through `POST /sessions/:id/terminals` and then attaches over the
  daemon's own WebSocket at `/api/v1/ws`, using the same credential the web UI
  stores under `kimi-web.server-credential`.
- The bearer token goes in the WebSocket **subprotocol**
  (`kimi-code.bearer.<token>`), which is where the daemon reads it, not in a
  query parameter that would land in logs.

Because the panel is created by the shell, a later bundle sync cannot take it
away. Terminals belong to a session, so the panel asks the daemon for the most
recently updated session when it opens its first tab.

## Fonts (desktop only)

`quick-sharun` copies `/etc/fonts/fonts.conf` into the AppDir but not its
`conf.d` rules, and it only bundles `/usr/share/fonts` when a deployed binary
hardcodes that path — Electron does not. `sharun` then only sets
`FONTCONFIG_FILE`, and only when the host has no `/etc/fonts/fonts.conf`. On a
host with no working fontconfig that leaves Chromium without a resolvable
`sans` family, and the whole UI renders with no text at all.

`make-appimage.sh` therefore ships `etc/fonts/conf.d`, DejaVu + Noto and its own
`fonts.conf`, as the fallback for a host that has no working fontconfig.

The host's fontconfig wins wherever it exists. An earlier revision pointed
`FONTCONFIG_PATH` at the bundled rules unconditionally, which forced the host's
fontconfig library to read cache files and `conf.d` rules generated by a newer
Fontconfig than the host runs, producing

```
Fontconfig warning: We will not regenerate the cache because some cache files
were generated by a newer version (0x2012003) of Fontconfig ...
```

and losing `sans` afterwards. `10-fontconfig.hook` now only documents the
fallback; `apps/kimi-desktop/src/main/index.ts` (`configureFonts`) decides, and
leaves an explicit `FONTCONFIG_FILE`/`FONTCONFIG_PATH` alone so it can still be
forced.

## Version

`get-dependencies.sh` writes the version to `~/version`; `appimagetool` reads it
when `VERSION` is not set, so the scripts do not set `VERSION` themselves.
