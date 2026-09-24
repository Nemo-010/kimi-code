# Kimi Code Desktop

An Electron desktop client for Kimi Code (product name **Kimi Code Desktop**;
workspace package `@moonshot-ai/kimi-desktop`). It is a thin **shell + process
manager** around the web UI that is already bundled inside the `kimi` SEA: it
does not reimplement any UI or backend, it just opens a native window onto the
local Kimi server.

## How it works

The web UI cannot run on its own — it needs the Kimi Code **server** (REST + WS
under `/api/v1`). That server ships as a self-contained single-file executable
(SEA) built from `apps/kimi-code`, with the web UI bundled inside it.

On launch the app:

1. Reads the kap-server instance registry
   (`<KIMI_CODE_HOME>/server/instances/*.json`) and reuses a live, healthy
   server if one is already running (started by the CLI, the browser or the
   TUI). It health-checks `/api/v1/healthz` before trusting an entry.
2. If none is healthy, spawns the bundled SEA with `web --no-open` and waits
   for the new instance to register and answer `/api/v1/healthz`. `kimi web`
   always starts a fresh server (it does not reuse), so the reuse decision has
   to be made here.
3. Loads the web UI from the server's origin with `?kimi_desktop=1&platform=…`
   and the bearer token in the `#token=` fragment, same as `kimi web` does.

On quit the desktop **reaps the server it started** (`SIGTERM`, then `SIGKILL`
after 5s). A server it did not start — for example one the user launched in a
terminal — is left alone. `kimi web` is a foreground server with no idle
shutdown, so leaving the child behind would orphan it and hold the port.

Key files:

- `src/main/instance-registry.ts` — read/parse the server instance files.
- `src/main/ensure-server.ts` — reuse-or-spawn, health-check, reap.
- `src/main/sea-path.ts` — resolve the bundled SEA (dev vs packaged vs
  quick-sharun AppImage wrapper).
- `src/main/index.ts` — window, native menu, window-state, loading/error
  screens.

## Develop

The dev build loads the SEA from `apps/kimi-code/dist-native/bin/<target>/`, so
build the backend once for your platform first:

```bash
pnpm install
pnpm --filter @moonshot-ai/kimi-code run build:native:sea

pnpm -C apps/kimi-desktop run dev      # or: pnpm dev:desktop (repo root)
```

Checks:

```bash
pnpm -C apps/kimi-desktop run typecheck
pnpm -C apps/kimi-desktop run test
```

## Package

`dist` builds the main process and runs electron-builder for the **current**
platform. `scripts/before-pack.cjs` stages the matching-platform SEA into the
app's resources (`<resources>/bin/<target>/`).

```bash
# unsigned local build (for your own machine):
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm -C apps/kimi-desktop run dist
# -> apps/kimi-desktop/dist-app/

# unpacked tree only (used as the quick-sharun AppImage input):
pnpm -C apps/kimi-desktop run dist:dir
```

> Do **not** rename a built `.app` bundle — renaming invalidates its code
> signature and macOS will report it as "damaged".

Cross-platform installers are produced in CI (`.github/workflows/desktop-build.yml`),
which builds the SEA on each platform runner and packages there. SEA injection
is per-platform (the blob is injected into the host Node binary), so each OS must
be built on its own runner.

The portable Linux AppImage is built by `.github/workflows/appimage.yml` with
pkgforge-dev's `quick-sharun` (see `packaging/appimage/kimi-desktop`). That path
uses `dist:dir` output, not the electron-builder AppImage target.

On Linux `dist` also writes a no-install
`Kimi-Code-Desktop-<version>-linux-<arch>.zip` (the `zip` target). It is a plain
archive of the unpacked app — it needs the distro's GTK/NSS, and the bundled SEA
uses the host libc — so prefer the AppImage when you want something that runs
anywhere. Every desktop artifact names its platform, because the macOS
auto-update zip is also a `.zip` and used to be indistinguishable from a Linux
one.

### macOS signing + notarization

An **unsigned** macOS build shows *"app is damaged and can't be opened"* once it
has been transferred to another Mac (Gatekeeper quarantine). To distribute it,
the app must be signed with a **Developer ID Application** certificate and
notarized by Apple. The config (`electron-builder.config.cjs`) applies the
hardened runtime + entitlements (`build/entitlements.mac.plist`) to the app and
the nested SEA, and signing/notarization are environment-driven:

```bash
KIMI_DESKTOP_NOTARIZE=true \
CSC_NAME="Developer ID Application: … (TEAMID)" \
APPLE_API_KEY=/path/AuthKey_XXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=…uuid… \
pnpm -C apps/kimi-desktop run dist
```

In CI, run the **desktop-build** workflow with `sign-macos: true`; it reuses the
same Apple secrets / keychain action as the native build
(`APPLE_CERTIFICATE_P12`, `APPLE_NOTARIZATION_KEY_*`).

> An `Apple Development` certificate is **not** enough — it can sign for your own
> machine but cannot be notarized. You need a `Developer ID Application` cert.

## v1 scope / not done yet

- **Auto-update**: not implemented.
- **Windows / Linux signing**: unsigned (Windows shows a SmartScreen prompt).
  Only macOS is signed + notarized.
- **No preload / IPC**: the renderer talks to the daemon over same-origin HTTP.
  Anything needing the host (tray, global shortcut, native dialogs) has to add
  a preload/IPC channel.
