# Re-adding Kimi Code Desktop (the `kimi-desktop` Electron shell)

Upstream removed the desktop client in
[MoonshotAI/kimi-code#1849](https://github.com/MoonshotAI/kimi-code/pull/1849),
merged 2026-07-17 as `f441193e1de0541af96f26c1a8b5a8c003fd6f60`
("chore: remove kimi-desktop app and desktop release pipeline"). The PR body is
explicit that the client itself did not cease to exist — development moved to a
dedicated internal repository. What was removed from this repo is:

- `apps/kimi-desktop/` (16 files, ~830 lines of source plus 3 binary icons)
- `.github/workflows/desktop-build.yml` (170 lines)
- the `desktop-artifacts` job in `.github/workflows/release.yml` (16 lines)
- workspace wiring: the root `dev:desktop` script, the `@moonshot-ai/kimi-desktop`
  entry in the root `typecheck` script, the Electron-only `onlyBuiltDependencies`
  block in `pnpm-workspace.yaml`, and the `apps/kimi-desktop` entries in
  `flake.nix` (`workspacePaths` / `workspaceNames`).

The deletion also dropped `electron` and `electron-builder` from
`pnpm-lock.yaml` (1726 lines).

This document is a reconstruction guide. It describes how to put the app back
in *this* checkout, what changed under it since the deletion, and where the
restored code stops working if you copy the old files verbatim. Read
[What changed since the deletion](#what-changed-since-the-deletion) before you
copy anything.

## Status on this fork

The app has been restored. What actually shipped differs from this guide in a
few places, and the rest was verified against the tree:

- The server discovery uses a third option the guide did not spell out: the
desktop reads the kap-server **instance registry** directly (a small JSON
reader, `apps/kimi-desktop/src/main/instance-registry.ts`) instead of importing
`@moonshot-ai/kap-server` (which would bundle the whole server into the
Electron main process) or parsing the SEA's human-readable banner.
- The daemon teardown policy is **reap the child the desktop started, leave a
server started by the CLI alone**. `kimi web` has no idle shutdown, so this is
the only option that neither orphans servers nor kills another client's.
- Electron moved to `44.x` and electron-builder to `26.x`; the `console-message`
listener uses the current `(details) => details.message` shape.
- The Linux AppImage is produced with pkgforge-dev's `quick-sharun` from the
`electron-builder --dir` output, not by electron-builder's own AppImage target.
- The desktop AppImage has to ship its own fontconfig rules and a font. Chromium
renders with no text at all when fontconfig cannot resolve `sans`; see
`packaging/appimage/README.md`.
- Desktop artifact names carry the platform
(`Kimi-Code-Desktop-2.1.0-linux-x64.zip`, `…-macos-arm64.dmg`), because the
macOS auto-update zip and a Linux portable zip are both `.zip`.
- The Nix `pnpmDeps` hash in `flake.nix` still has to be refreshed after the
lockfile change (no Nix in the environment that produced the restore).

Verified as accurate: `kimi server run` is gone (deprecation shim); the
single-instance lock was replaced by the instance registry; `kimi web` is a
foreground runner with no idle shutdown; `server.token` is still
`<KIMI_CODE_HOME>/server.token` at mode `0600`; the committed web bundle reads
`#token=` from `location.hash` and strips it, and honours
`?kimi_desktop=1&platform=…`; the `typecheck` filter and the Electron
`onlyBuiltDependencies` allowance were removed and have been restored.

Recover the deleted files. A normal `git clone` is shallow-traversed enough that
the removal commit may not be present, so fetch it explicitly first:

```sh
# 1. Get the merge commit and its parent (needed for `^` and for the archive).
git fetch --depth=2 origin f441193e1de0541af96f26c1a8b5a8c003fd6f60

# 2. Inspect or extract single files.
git show 56ba8e0196a3053ad1115a7e8f8b8c4c0cd1b320:apps/kimi-desktop/src/main/index.ts

# 3. Or restore the whole app directory at once.
git archive 56ba8e0196a3053ad1115a7e8f8b8c4c0cd1b320 apps/kimi-desktop \
  | tar -x -C /tmp/desktop-restore
```

`56ba8e0196a3053ad1115a7e8f8b8c4c0cd1b320` is the parent of the merge commit
`f441193e1de0541af96f26c1a8b5a8c003fd6f60` and therefore holds the last state of
the app. Upstream's copy is also readable on the Electrosphere at
`https://github.com/MoonshotAI/kimi-code/tree/56ba8e0196a3053ad1115a7e8f8b8c4c0cd1b320/apps/kimi-desktop`,
as are the individual deleted files as raw text.

## What the desktop app is

An Electron shell and process manager around the local Kimi server. It
deliberately contains no UI and no backend: the renderer is the web UI
(`apps/kimi-code/dist-web`, produced from the closed code-app repo), and the
backend is the `kimi` single-file executable (SEA) built from `apps/kimi-code`.

The design is three files:

| File | Role |
| --- | --- |
| `src/main/ensure-server.ts` | Find or start the shared local daemon, confirm it is healthy, return its origin. |
| `src/main/sea-path.ts` | Resolve the bundled `kimi` executable: `<resources>/bin/<target>/kimi` when packaged, `apps/kimi-code/dist-native/bin/<target>/kimi` in dev. |
| `src/main/index.ts` | `BrowserWindow`, native menu, window-state persistence, loading/error screens, macOS traffic-light and theme handling, and the browser and terminal bridges. |
| `src/preload/index.ts` | The window bridge: `window.kimiDesktop`, `window.kimiBrowser`, the masked-`<webview>` browser surface, and the Terminal panel. |
| `src/renderer/terminal-screen.ts` | VT emulator for the Terminal panel: cursor movement, scroll regions, SGR colours, bounded scrollback. |
| `src/renderer/terminal-panel.ts` | The Terminal panel itself, driving the daemon's terminal REST + WebSocket protocol. |

Two design decisions carry consequences worth understanding before restoring:

1. **The desktop app never starts a private server.** It invokes the bundled
   SEA, which finds a server other clients (CLI, browser, TUI) are already using,
   or starts one they can reuse. It never spawns an app-only daemon.
2. **The renderer talks to the daemon over plain same-origin HTTP.** `contextIsolation` is on and `nodeIntegration` is off, but there **is** a preload
   (`src/preload/index.ts`). The web UI bundle is written for the internal
   code-app shell and probes `window.kimiDesktop`; without a preload the shell
   cannot answer, and the quick-open list goes on offering a Browser panel that
   can never open (issue #1). The preload exposes `window.kimiDesktop` and
   `window.kimiBrowser`, and the main process routes them over IPC. The macOS
   theme sync now calls through that channel instead of the tagged
   `console-message` workaround, which is kept only as a fallback.
3. **The Terminal panel belongs to the shell, not the bundle.** The shipped web
   bundle has no terminal — its harness was removed, and `xterm` has no hits in
   it. The shell mounts a VT emulator and speaks the daemon's terminal protocol
   itself (`src/renderer/terminal-screen.ts`, `terminal-panel.ts`), so the panel
   does not depend on a bundle that no longer has one.

## Porting the removed code: what will break

The deletion landed upstream in July 2026 (`mergedAt` 2026-07-17). Between that
commit and kimi-code 2.1.0, four things the desktop app depended on changed.

### 1. `kimi server run` no longer exists

`ensure-server.ts` did:

```ts
execFile(seaPath, ['server', 'run', '--log-level', 'error'], { timeout: 30_000 }, ...)
```

`kimi server` is now a deprecation shim
(`apps/kimi-code/src/cli/sub/web/deprecated-server.ts`). Any `kimi server …`
invocation — including `run` — prints a notice and exits 1. A verbatim restore
of `ensure-server.ts` therefore fails immediately with
`kimi server run failed: …`.

Replace it with `kimi web --no-open`, which runs the server in-process in the
foreground:

```ts
execFile(seaPath, ['web', '--no-open', '--log-level', 'error'], { timeout: RUN_TIMEOUT_MS }, ...)
```

Do not copy `kimi server kill` for teardown either; the shim keeps that
subcommand only to clean up pre-0.28.0 leftovers.

### 2. The lock file is gone; there is an instance registry instead

`ensure-server.ts` read `<KIMI_CODE_HOME>/server/lock` for `{ pid, host, port }`
and derived the origin from it. The single-instance lock was removed in favour
of a per-instance registry: each server writes
`<KIMI_CODE_HOME>/server/instances/<serverId>.json` and heartbeats it every 15s
(`packages/kap-server/src/instanceRegistry.ts`). The registry is exported from
`@moonshot-ai/kap-server`:

```ts
import { getLiveServerInstance, listLiveServerInstances } from '@moonshot-ai/kap-server';
```

Two viable ports:

- **Preferred:** have the SEA perform discovery and report the origin, then read
  it (see "Getting the origin out of the SEA" below).
- **Direct:** `getLiveServerInstance(kimiHome())` and use `host` / `port` from
  the returned `ServerInstanceInfo`. This only sees servers started by a build
  that has the registry, so it is blind to daemons older than the change.

`readLegacyLock` still exists in `legacy-kill.ts` for the pre-0.28.0 cleanup
path, but it is not a supported discovery mechanism and the directory it reads
is only written by ancient builds.

### 3. `kimi web` is a foreground, terminal-attached command

The `agent-core-v2` daemon path that the old desktop shell relied on is no
longer the only shape. `runServerInProcess()` blocks until SIGINT/SIGTERM and
`process.exit(0)`s on shutdown. Two consequences:

- If you spawn `kimi web --no-open` as a child, it lives exactly as long as the
  Electron app, and Electron must reap it on quit or leave an orphan holding the
  port. Upstream's "detach and let the daemon idle out" comment no longer
  describes what the process does: there is no idle shutdown left in
  `kap-server`. `startServer()` returns a `close()` that the foreground runner
  calls from its SIGINT/SIGTERM handler, and nothing exits on client count.
- If you run it in the Electron main process instead (`import`ing the server),
  you get in-process shutdown behaviour but you now own `process.exit(0)` inside
  Electron, which is worse.

The current code therefore wants a small change of shape: keep spawning a
child, and kill it on `before-quit`. A shared-daemon workflow needs a policy you
choose deliberately — for example a `KIMI_DESKTOP_SERVER=external` mode that
skips spawning, or a `--port` value the client tries to connect to first.

### 4. Getting the origin out of the SEA

The reliable way to learn the port without depending on registry internals is to
have the CLI print it. Either:

- add a hidden flag to `apps/kimi-code` that runs the server, prints
  `{"origin":"http://127.0.0.1:58627"}` on readiness and keeps running, then read
  one line of stdout; or
- configure the port deterministically with `kimi web --port <port> --no-open`
  and use that port directly. This is simplest and removes the need for any
  discovery file. It costs you the CLI's "next free port" behaviour when another
  client already holds 58627.

Both are better than re-reading a lock file that no longer exists.

### 5. Auth is a private-mode file, and it moved into the web UI's fragment

`server.token` is still `<KIMI_CODE_HOME>/server.token` with mode `0600`
(`packages/kap-server/src/services/auth/persistentToken.ts`). The token reader
now refuses files that are not `0600` on POSIX
(`readPrivateFile` throws `PrivateFileTooPermissiveError`), so do not relax the
permissions when restoring the reader.

The web UI reads the token from `location.hash` as `#token=<token>` and then
strips it with `history.replaceState`
(`apps/kimi-code/dist-web/assets/index-*.js`, verified against the committed
bundle). Upstream's `connect()` appended it correctly:

```ts
const fragment = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
await win.loadURL(`${origin}/?kimi_desktop=1&platform=${process.platform}${fragment}`);
```

Keep that shape. Do not move the token into a query parameter: it would then
land in server access logs.

### 6. The desktop marker is still honoured by the web bundle

The web UI detects desktop mode from `?kimi_desktop=1`, records it in
`sessionStorage` under the key `kimi-desktop` (and the platform under
`kimi-desktop-platform`), and shows an internal-build banner. The committed
bundle in this checkout contains that code path (`kimi_desktop`, `platform`,
`kimi-desktop`, `kimi-desktop-platform`). Upstream's desktop-build workflow also
baked `KIMI_WEB_DESKTOP=1` into the bundle; because `apps/kimi-web` no longer
exists here, that flag is now the code-app repo's business and the banner comes
from the query parameter alone.

Note the stricter consequence: the web UI removes `#token=` from the URL after
reading it, so a reload recovers auth from the stored token rather than from the
URL. Do not build flows that depend on the fragment surviving a navigation.

### 7. `typecheck` wiring changed

The root `typecheck` script reads:

```json
"typecheck": "pnpm run build:packages && pnpm -r --filter './packages/*' run typecheck && pnpm --filter @moonshot-ai/kimi-code run typecheck && pnpm --filter kimi-code run typecheck && pnpm --filter @moonshot-ai/vis-server run typecheck && pnpm --filter @moonshot-ai/vis-web run typecheck"
```

Add the desktop filter back after `kimi-code`:

```
&& pnpm --filter @moonshot-ai/kimi-desktop run typecheck
```

Also note the root `lint` script is now
`node scripts/check-no-comments.mjs && oxlint --type-aware`. That comment
checker only scans `packages/agent-core-v2`, `packages/kap-server` and
`packages/transcript`, so desktop source is unaffected — but new source under
one of those three packages will fail CI on comments.

### 8. Nix wiring is optional, and `check-nix-workspace.mjs` will not catch a miss

The removal edited `flake.nix` in two places, so a faithful revert re-adds
`./apps/kimi-desktop` to `workspacePaths` and `"@moonshot-ai/kimi-desktop"` to
`workspaceNames`. Nothing requires that:

- The Nix package is the **CLI only**. Its `installPhase` installs
  `apps/kimi-code/dist-native/bin/<target>/kimi` and nothing else, and its
  `buildPhase` runs `pnpm --filter=@moonshot-ai/kimi-code run build:native:sea`.
- `workspaceNames` exists to populate `pnpmWorkspaces` for
  `pkgs.fetchPnpmDeps`, so it needs every package pnpm must resolve — Electron
  included, because `pnpm install` is what fetches it.
- `scripts/check-nix-workspace.mjs` does **not** validate all workspaces. It
  computes the dependency closure of `@moonshot-ai/kimi-code` and checks only
  those against the flake. `@moonshot-ai/kimi-desktop` is not in that closure —
  it depends on the SEA's *files*, not on any workspace package — so the checker
  stays green either way.

Add the entries if `nix build` should resolve the desktop app's dependencies;
skip them if you only care about the CLI. Do not expect the checker to tell you
which you did.

### 9. Electron's postinstall allowance was deleted from `pnpm-workspace.yaml`

The removal deleted the whole block, not one line:

```yaml
onlyBuiltDependencies:
  - electron
```

Without it, pnpm never runs Electron's postinstall and the installed `electron`
package has no binary, so `electron .` fails. Re-add it, and keep it minimal:
upstream leaves the other native dependencies unbuilt on purpose. Do not put
anything besides `electron` in the block.

Expect `pnpm-lock.yaml` to grow by roughly 1.7k lines.

## Reimplementation outline

The cheap path is `git revert f441193e1de0541af96f26c1a8b5a8c003fd6f60` on a
branch and then apply the porting notes above. That gives you the original
files, and then you fix the real breakages: `server run` → `web --no-open` (1),
lock-file discovery → the instance registry or a printed origin (2), daemon
teardown on quit (3), the `onlyBuiltDependencies` / lockfile regeneration (4),
and the `typecheck` filter (5). Everything else in the deleted code is still
valid as written.

If you would rather write it fresh, the file set to recreate is:

```
apps/kimi-desktop/
├── .gitignore                  # out/ dist-app/ resources-stage/
├── package.json                # @moonshot-ai/kimi-desktop, private, type: module
├── tsconfig.json               # { "extends": "../../tsconfig.json", "include": ["src"] }
├── tsdown.config.ts            # src/main/index.ts -> out/main.cjs, cjs, electron external
├── electron-builder.config.cjs
├── scripts/before-pack.cjs     # stage the matching SEA into resources-stage/bin/<target>/
├── build/entitlements.mac.plist
├── build/icon.{icns,ico,png}
└── src/main/{index,ensure-server,sea-path}.ts
```

`package.json` in full, from the deleted tree:

```json
{
  "name": "@moonshot-ai/kimi-desktop",
  "version": "0.1.1-internal.0",
  "private": true,
  "license": "MIT",
  "description": "Kimi Code desktop client — an Electron shell around the Kimi web UI.",
  "type": "module",
  "main": "out/main.cjs",
  "scripts": {
    "build": "tsdown",
    "start": "electron .",
    "dev": "tsdown && electron .",
    "typecheck": "tsc --noEmit",
    "dist": "tsdown && electron-builder --config electron-builder.config.cjs"
  },
  "devDependencies": {
    "electron": "33.4.11",
    "electron-builder": "25.1.8",
    "tsdown": "0.22.0",
    "typescript": "6.0.2"
  }
}
```

Adjust `electron` forward: 33 is old, and the version you pin must have a
prebuilt binary for your host. Electron only ever hosts the bundled main-process
JavaScript and loads the web UI over HTTP — it never runs the SEA in-process —
so the ABI coupling to the SEA is weak, and you are free to move to a current
Electron. `tsdown` is already at `0.22.0` at the repo root; pinning a second copy
here will make `pnpm sherif` unhappy, so match the root version or use
`workspace:`.

## The SEA backend

`before-pack.cjs` copies `apps/kimi-code/dist-native/bin/<platform>-<arch>/`
into the Electron app's resources. Build it first, for the *host* platform:

```sh
pnpm install
pnpm --filter @moonshot-ai/kimi-code run build:native:sea
pnpm --filter @moonshot-ai/kimi-code run test:native:smoke
```

The SEA embeds `apps/kimi-code/dist-web`, which in this checkout is a committed
bundle synced from the code-app repo. `scripts/check-web-assets.mjs` fails the
build if `dist-web/index.html` is missing, so a checkout that has it can build
the SEA without any web toolchain.

SEA injection is per-platform: the blob is injected into a copy of the host Node
binary. You cannot cross-build the backend. Each platform needs its own runner
or its own machine.

## Local development

```sh
pnpm install
pnpm --filter @moonshot-ai/kimi-code run build:native:sea   # once per kimi-code change
pnpm -C apps/kimi-desktop run dev                            # tsdown + electron .
```

`sea-path.ts` resolves `apps/kimi-code/dist-native/bin/<target>/kimi` in dev
because `app.getAppPath()` is `apps/kimi-desktop`. If you change that path
layout in the restore, change `resolveSeaPath()` with it.

Add `dev:desktop` back to the root `package.json`:

```json
"dev:desktop": "pnpm -C apps/kimi-desktop run dev"
```

## Packaging and distribution

`pnpm -C apps/kimi-desktop run dist` builds for the current platform only.

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm -C apps/kimi-desktop run dist
```

Note `pnpm-workspace.yaml`'s `overrides` and the removed `onlyBuiltDependencies`
block: the removal deleted an Electron-only allowance, and the *upstream* reason
was that other native dependencies deliberately stay unbuilt. If you re-add the
block, keep it to `electron`.

### macOS

An unsigned bundle transferred to another Mac fails Gatekeeper with "app is
damaged". To distribute, sign with a **Developer ID Application** certificate
and notarize. An `Apple Development` certificate is not sufficient.

The deleted config drove both from the environment:

- `CSC_IDENTITY_AUTO_DISCOVERY=false` — unsigned local build.
- `KIMI_DESKTOP_NOTARIZE=true` plus `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER` — signed and notarized.

The hardened-runtime entitlements must be applied to the app *and* every nested
Mach-O, including the bundled SEA. The deletion used
`entitlementsInherit: 'build/entitlements.mac.plist'` for that. The plist has
four keys, and all four matter:

| Entitlement | Why |
| --- | --- |
| `com.apple.security.cs.allow-jit` | Electron/V8 and the Node SEA both need JIT pages. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8 writes to executable memory during codegen. |
| `com.apple.security.cs.disable-library-validation` | The SEA `dlopen`s `koffi.node` / `clipboard.node`, which are third-party and not signed by your team. |
| `com.apple.security.cs.allow-dyld-environment-variables` | Users may set `NODE_OPTIONS` / `DYLD_*`. |

Do not rename a built `.app` after signing; it invalidates the signature.

## CI

The deleted workflow built each platform on its own runner, because the SEA
cannot be cross-built. Restoring it means restoring:

1. `pnpm install --frozen-lockfile`
2. build the web assets / stage `dist-web` (in this checkout: verify the
   committed bundle instead — `KIMI_WEB_DESKTOP=1` was baked into the code-app
   build and has no equivalent here)
3. `pnpm --filter @moonshot-ai/kimi-code run build:native:sea`
4. macOS: keychain setup, strip the `Developer ID Application: ` prefix from
   `CSC_NAME` (electron-builder rejects it), decode the notarization key
5. `pnpm --filter @moonshot-ai/kimi-desktop run dist`
6. upload `*.dmg`, `*.zip`, `*.exe`, `*.AppImage`, `*.deb` (the Linux `dist`
   run also emits the no-install `Kimi-Code-Desktop-<version>-linux-<arch>.zip`)

The helper actions still exist in this repo:
`.github/actions/macos-keychain-setup` and `macos-keychain-cleanup`. Reuse them
rather than reimplementing the keychain dance. `release.yml` needs the
`desktop-artifacts` job added back, calling the new workflow and passing the same
`APPLE_*` secrets that `native-artifacts` already receives.

The fork-specific note: in a fork, push-triggered workflows do not fire, so the
restored workflow needs a `workflow_dispatch:` trigger to be runnable by hand
via `gh workflow run`.

Matrix from the deleted workflow (adjust runner images to whatever is current —
`macos-15-intel` and `windows-2025-vs2026` are the ones it used):

| Runner | Target |
| --- | --- |
| `macos-15` | `darwin-arm64` |
| `macos-15-intel` | `darwin-x64` |
| `windows-2025-vs2026` | `win32-x64` |
| `ubuntu-24.04` | `linux-x64` |

`sea-path.ts`'s `SUPPORTED_TARGETS` also lists `linux-arm64` and `win32-arm64`,
which the deleted matrix did not build. Either build them or trim the set, but
do not leave the two lists disagreeing: `currentTarget()` throws on a target the
SEA build cannot produce.

## Known gaps in the deleted implementation

Restoring it does not restore these; they were explicitly out of scope in the
old code.

- **No auto-update.** Users reinstall by hand. `electron-updater` is the
  obvious hook, and the fork's `updates/latest.json` mechanism is unrelated.
- **Windows and Linux ship unsigned.** Windows shows a SmartScreen prompt.
- **There is a preload and an IPC channel now**, added so the web UI's
  `window.kimiDesktop` / `window.kimiBrowser` probes have something to answer.
  Anything else that needs the host (tray, global shortcut, deep links, native
  file dialogs scoped to the OS) still has to be added on top of it.
- **The Browser panel and the agent's browser tool are the same tabs.** The
  shell implements the `kimi.browser/1.0.0` operations (`browser-engine.ts`) over
  the masked `<webview>` surfaces, and exposes them as the `desktop_browser` MCP
  server (`browser-mcp.ts` + `browser-http.ts`). The committed web bundle already
  renders that tool as `mcp__desktop_browser__run`, so the agent's calls and the
  panel's view are one surface, not two.
- **The MCP transport is HTTP, not stdio, and that is not a preference.** The
  AppImage ships no Node interpreter — its only executable is Electron, whose
  path is inside the AppImage mount — so there is nothing a stdio entry could
  name. The main process serves Streamable HTTP on `127.0.0.1` and writes the
  endpoint plus a bearer token into `<KIMI_CODE_HOME>/mcp.json` on launch (mode
  `0600`). A stdio entry would only work where a `node` happens to exist on PATH,
  which is exactly the case that does not ship.
- **The daemon lifetime problem is unresolved.** "Leave it running" was correct
  when the SEA was a detached daemon; `kimi web` is foreground now and there is
  no idle shutdown. Pick a policy explicitly: reap the child on quit, or leave it
  and accept that the next launch reuses a server the user started in a terminal.
- **Tests exist now** (`apps/kimi-desktop/test`): the MCP protocol surface, the
  browser engine's operation handling, the preload bundle contract, the MCP
  registration, the VT emulator, the panel driven in a DOM, and the terminal
  protocol the panel must speak. `ensure-server.ts` and `sea-path.ts` still have
  none, and that is where the discovery logic keeps breaking; add tests there
  next.
- **The MCP endpoint is not exercised in this sandbox.** Binding a loopback
  listener is denied here, so the protocol tests call the transport-free handler
  (`handleMcpHttpRequest`) directly. The socket-level path is only covered on a
  normal host and in CI.
- **`desktopFlag` in the web UI is inert outside desktop.** The bundle's
  detection path is harmless when loaded in a normal browser tab, which means a
  bug in it will not show up in `kimi web`.

## Checklist

- [x] `git revert f441193e1de0541af96f26c1a8b5a8c003fd6f60` (or extract the files from `56ba8e01`)
- [x] `ensure-server.ts`: `server run` → `web --no-open`
- [x] `ensure-server.ts`: lock file → instance registry
- [x] `index.ts`: reap the spawned server on quit; leave a reused one alone
- [x] re-add `apps/kimi-desktop` to `flake.nix` `workspacePaths` and `workspaceNames`
- [x] re-add `onlyBuiltDependencies: [electron]` to `pnpm-workspace.yaml`, regenerate the lock
- [x] re-add `dev:desktop` to root scripts and the desktop filter to root `typecheck`
- [x] `pnpm --filter @moonshot-ai/kimi-code run build:native:sea` succeeds
- [x] `pnpm -C apps/kimi-desktop run typecheck` passes
- [x] `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm -C apps/kimi-desktop run dist:dir` produces `dist-app/linux-unpacked/`
- [x] the bundle launches, starts or finds a server, and connects to it — the
      release smoke test launches the desktop AppImage under `xvfb` and waits
      for its `[kimi-desktop] connected to …` line (`verify-release.mjs`).
      The web UI itself is not asserted, only that the window process reaches a
      healthy server
- [x] the `.deb` and Linux portable `.zip` targets are wired up; building them
      locally needs electron-builder's bundled `fpm`, which wants `libcrypt.so.1`
      — present on the CI runners (`desktop-build.yml` builds them there)
- [x] the desktop AppImage bundles `etc/fonts/conf.d` and a DejaVu font, and
      `10-fontconfig.hook` points `FONTCONFIG_PATH` at them — without that a host
      with no fontconfig renders the UI with no text (this is what
      `Kimi-Code-Desktop-x86_64.AppImage` shipped before the fix)
- [x] restoring CI: `desktop-build.yml` with `workflow_dispatch`, and the
      `desktop-artifacts` job in `release.yml`
- [x] a fork-safe release pipeline (`fork-release.yml`) and pkgforge AppImages
      (`appimage.yml`, `packaging/appimage/`)
- [x] refresh the `pnpmDeps` hash in `flake.nix` (the `nix-build.yml` build log
      reports the correct `got:` hash)
- [x] run `fork-release.yml` once to produce the first AppImage release
      (`v2.1.0-fork.2`, plus the rolling `continuous` pre-release)
