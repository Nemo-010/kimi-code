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

## Fonts (desktop only)

`quick-sharun` copies `/etc/fonts/fonts.conf` into the AppDir but not its
`conf.d` rules, and it only bundles `/usr/share/fonts` when a deployed binary
hardcodes that path — Electron does not. `sharun` then only sets
`FONTCONFIG_FILE`, and only when the host has no `/etc/fonts/fonts.conf`. On a
host with no working fontconfig that leaves Chromium without a resolvable
`sans` family, and the whole UI renders with no text at all.

`make-appimage.sh` therefore ships `etc/fonts/conf.d`, a DejaVu font and its own
`fonts.conf`, and `10-fontconfig.hook` points `FONTCONFIG_PATH` at them so the
`conf.d` include resolves inside the AppDir on every host.

## Version

`get-dependencies.sh` writes the version to `~/version`; `appimagetool` reads it
when `VERSION` is not set, so the scripts do not set `VERSION` themselves.
