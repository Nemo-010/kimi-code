# Maintaining this fork

This repository is [`MoonshotAI/kimi-code`](https://github.com/MoonshotAI/kimi-code)
plus a short series of fork commits. Upstream keeps moving; the job of a
maintainer (human or agent) is to replay those commits on top of upstream,
notice when upstream made one of them unnecessary or wrong, and cut a release.

Everything below is runnable. The two scripts that do the heavy lifting are:

- `tools/fork/reconcile.mjs` — compare/rebase the fork against any upstream ref.
- `tools/fork/verify-release.mjs` — prove a published release is complete and runs.

Start with:

```sh
pnpm fork:status          # or: node tools/fork/reconcile.mjs status
```

`pnpm fork:status`, `fork:diff`, `fork:rebase`, `fork:verify`,
`fork:validate` and `fork:verify-release` are thin aliases for the scripts.

## 1. What the fork actually changes

| Patch | Purpose |
| --- | --- |
| `tui-thinking-detail` | Expandable subagent/swarm thinking traces in the TUI. |
| `ci-manual` | `workflow_dispatch` on CI. |
| `readme-fork`, `fork-notes`, `desktop-guide` | Documentation of the fork. |
| `desktop-restore` | The Electron desktop client (`apps/kimi-desktop`), its release workflow, and the pkgforge AppImage packaging. |
| `deps-stable` | CI actions and dev tooling on current stable. |
| `fork-tooling` | `tools/fork/*` and this document. |
| `desktop-hardening` | Reconnect serialisation and space-free installer names. |
| `thinking-detail-test` | Regression test for the TUI thinking-detail patch. |

The authoritative list, with the upstream assumptions each patch relies on
("anchors"), is [`tools/fork/fork-manifest.json`](./tools/fork/fork-manifest.json).
If you add a patch, add an entry there — the reconcile tool will otherwise
report it as *unclassified*.

The desktop restore is the big one and has its own background document:
[`KIMI_DESKTOP.md`](./KIMI_DESKTOP.md) explains what upstream removed, what
changed since, and how the port works. The desktop app itself is documented in
[`apps/kimi-desktop/README.md`](./apps/kimi-desktop/README.md).

## 2. Reconcile with upstream

```sh
# See what needs attention. Accepts a branch, tag, release tag or commit.
node tools/fork/reconcile.mjs status
node tools/fork/reconcile.mjs status --upstream '@moonshot-ai/kimi-code@2.1.0'

# What did upstream change in the files a patch owns?
node tools/fork/reconcile.mjs diff --patch desktop-restore

# Back up the branch and rebase.
node tools/fork/reconcile.mjs rebase --upstream upstream/main

# Re-check, then run the local gates.
node tools/fork/reconcile.mjs status
node tools/fork/reconcile.mjs verify
```

`status` tells you, for every fork commit:

- **needed** — upstream does not have it; keep it.
- **obsolete** — upstream already contains an equivalent change; drop it while
  rebasing (delete the commit and its manifest entry).
- **upstream drift** — an upstream commit since the merge-base touched a file
  this patch owns; read `diff --patch <id>` and re-verify the patch.
- **anchor drift** — an assumption about upstream no longer holds (for example
  the instance-registry JSON keys changed). Update the patch *and* the anchor.

The verdict line is the summary: `CLEAN` means all patches are still needed, no
drift, all anchors hold. Anything else lists what to do.

## 3. Build and test

```sh
pnpm install --frozen-lockfile

# The desktop needs the SEA backend for the host platform first:
pnpm --filter @moonshot-ai/kimi-code run build:native:sea
pnpm -C apps/kimi-desktop run dev        # or: pnpm dev:desktop

pnpm run typecheck                       # all packages + apps
pnpm run lint                            # check-no-comments + oxlint --type-aware
pnpm run sherif
pnpm -C apps/kimi-desktop run test
pnpm test                                # full vitest suite (sharded in CI)
```

CI is [`.github/workflows/ci.yml`](./.github/workflows/ci.yml): typecheck,
lint, five test shards, a build, a Windows test job and a legacy VS Code job.
Run it on demand from the Actions tab (`workflow_dispatch`) — this fork's CI
allows it.

## 4. Package the AppImages

The Linux AppImages are built with pkgforge-dev's `quick-sharun`, not
electron-builder's AppImage target. The packaging lives in
[`packaging/appimage/`](./packaging/appimage/) and runs inside the Arch Linux
container in [`.github/workflows/appimage.yml`](./.github/workflows/appimage.yml).

Rules that are easy to get wrong:

- **Build on Arch Linux.** The pkgforge guide is explicit that other distros
  produce broken bundles; deploying anywhere but Arch is a very bad idea.
- **Install the app to `/usr` before deploying** when packaging a normal
  application. This monorepo builds from a checkout, so the scripts stage the
  built tree into the AppDir instead; that is the equivalent step.
- **Never copy libraries by hand.** Pass the application's binaries to
  `quick-sharun`; it finds the dlopened libraries itself.
- **`NO_STRIP=binaries` is required.** Stripping a Node SEA removes its dynamic
  section and produces `object file has no dynamic section`. Libraries are
  still stripped.
- The CLI `.desktop` must say `Exec=kimi` (the deployed binary name), or
  `quick-sharun`'s `_check_main_bin` fails.
- Don't take guidance from `docs.appimage`, `appimage-builder`,
  `appimagekit` or `linuxdeploy` — it is wrong for `quick-sharun`.

To reproduce a build locally (needs Arch):

```sh
cd packaging/appimage/kimi-code
KIMI_SEA=../../../apps/kimi-code/dist-native/bin/linux-x64/kimi \
KIMI_VERSION=2.1.0-fork.2 sh ./get-dependencies.sh
KIMI_SEA=../../../apps/kimi-code/dist-native/bin/linux-x64/kimi \
KIMI_VERSION=2.1.0-fork.2 sh ./make-appimage.sh
```

Then test it without FUSE by extracting it:

```sh
./dist/kimi-code-x86_64.AppImage --appimage-extract
./squashfs-root/bin/kimi --version
```

## 5. Release

Two workflows, one pipeline:

- [`fork-release.yml`](./.github/workflows/fork-release.yml) — the versioned
  release. `workflow_dispatch` with a `tag` (for example `v2.1.0-fork.2`).
  Also callable via `workflow_call`.
- [`continuous-release.yml`](./.github/workflows/continuous-release.yml) —
  calls the same pipeline with `tag=continuous`, always overwriting the rolling
  pre-release. Runs on push to `main`, on a daily schedule, and on demand.

A release builds:

1. the six native SEA bundles (`_native-build.yml`),
2. the desktop installers for macOS/Windows/Linux (`desktop-build.yml`),
3. the CLI and desktop AppImages (`appimage.yml`),

then the `release` job downloads everything, **validates the artifact set**,
creates or updates the release, and **smoke-tests the published assets**.

Guard rails, so a bad build cannot damage a good release:

- the publish job `needs` every build job, so a failed build never reaches it;
- `tools/fork/validate-artifacts.mjs` refuses to publish an incomplete or
  suspiciously small artifact set;
- a versioned tag is uploaded **without** `--clobber` unless `allow-overwrite`
  is set, so existing good assets are not replaced;
- `continuous` always clobbers (it is a rolling tag) but always smoke-tests.

Verify a release at any time:

```sh
node tools/fork/verify-release.mjs --tag continuous
node tools/fork/verify-release.mjs --tag v2.1.0-fork.2 --smoke
```

`--smoke` downloads the host-arch native zip and both AppImages, verifies the
`.sha256`, extracts the AppImages with `--appimage-extract`, runs the CLI and
the desktop's bundled backend with `--version`, and launches the desktop under
`xvfb-run` until it reports that it connected to its server.

### Cutting a versioned release

```sh
node tools/fork/reconcile.mjs status          # must be CLEAN
node tools/fork/reconcile.mjs verify
gh workflow run fork-release.yml -f tag=v2.1.0-fork.2
```

Then watch the run and confirm the verification job passes:

```sh
gh run watch
node tools/fork/verify-release.mjs --tag v2.1.0-fork.2 --smoke
```

### Refreshing the continuous release

```sh
gh workflow run continuous-release.yml
node tools/fork/verify-release.mjs --tag continuous --smoke
```

## 6. Dependencies

The repo pins exact versions. When bumping:

1. Update **every** `package.json` that pins the package (the version is often
   repeated across `apps/*` and `packages/*`); `pnpm run sherif` catches
   mismatches.
2. `pnpm install --no-frozen-lockfile`, then `pnpm install --frozen-lockfile` to
   confirm the lockfile is consistent.
3. Run `pnpm run typecheck && pnpm run lint && pnpm test`.

**Deferred majors** (bump them together, in their own PR, with CI green):

- `typescript` 6 → 7 is the native (Go) compiler; it changes the `tsc` binary
  and needs a full typecheck pass before landing.
- `vitest` 4 → 5 and `pnpm` 10 → 12 change config and lockfile formats; do them
  one at a time.
- `oxlint` 1.59 → 1.85 / `oxlint-tsgolint` 0.20 → 7 enable new rules that
  currently report ~1100 errors on this tree. Bump only after deciding whether
  to fix or disable each rule in `.oxlintrc.json`.

The GitHub Actions are pinned to major tags; keep them on current stable
(`checkout@v7`, `setup-node@v7`, `upload-artifact@v7`, `download-artifact@v8`,
`pnpm/action-setup@v6`, `github-script@v9`). Node is pinned by `.nvmrc`.

## 7. Gotchas

- **Nix hash.** `flake.nix` uses `pkgs.fetchPnpmDeps`; the `hash` must be
  refreshed whenever `pnpm-lock.yaml` changes. `nix-build.yml` runs on PRs and
  reports the correct `got:` hash; locally, run `nix build .#kimi-code` and copy
  the `got:` value from the error into `flake.nix`. Nix is not available in
  every environment, so this can stay stale until someone with Nix fixes it —
  it does not affect the release pipeline.
- **Web bundle.** `apps/kimi-code/dist-web` is committed (synced from the
  code-app repo). Packaging runs `node apps/kimi-code/scripts/check-web-assets.mjs`
  instead of building it; if the bundle is missing, that check fails.
- **Instance registry.** The desktop discovers servers by reading
  `<KIMI_CODE_HOME>/server/instances/*.json` directly. The JSON keys are the
  anchor `instance-registry`; if upstream renames them, the desktop must change.
- **`kimi server run`** is gone; the desktop spawns `kimi web --no-open`, which
  is a foreground server with no idle shutdown, so the desktop reaps only the
  child it started.
- **Husky hooks** can fail in restricted environments (`Permission denied`
  executing `.husky/_/*`). Commit/push with
  `git -c core.hooksPath=/tmp/nohooks ...` when that happens.
- **`pnpm install` rewrites `node_modules/.bin` shims.** In a sandbox that
  blocks execution outside the working tree, they have to be made executable
  again after every install.
