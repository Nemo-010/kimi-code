# Fork tooling

Instruments for keeping this fork rebased on upstream and for verifying releases.
See [`../../MAINTAIN_AGENTS.md`](../../MAINTAIN_AGENTS.md) for the full playbook.

| Script | What it does |
| --- | --- |
| `reconcile.mjs` | Compares the fork to any upstream ref; lists needed/obsolete patches, upstream drift, and broken assumptions. Can rebase. |
| `validate-artifacts.mjs` | Pre-publish gate: fails if the downloaded build artifacts are incomplete or too small. |
| `verify-release.mjs` | Post-publish check: lists a release's assets, verifies checksums, and (with `--smoke`) extracts and runs the AppImages. |
| `release-assets.mjs` | Shared list of what a complete release contains. Edit this when the release layout changes. |
| `fork-manifest.json` | The fork's patches and the upstream assumptions ("anchors") they depend on. |

## Reconcile

```sh
node tools/fork/reconcile.mjs status
node tools/fork/reconcile.mjs status --upstream '@moonshot-ai/kimi-code@2.1.0'
node tools/fork/reconcile.mjs diff --patch desktop-restore
node tools/fork/reconcile.mjs rebase --upstream upstream/main
node tools/fork/reconcile.mjs verify
```

`status` classifies every fork commit as **needed** (upstream does not have it)
or **obsolete** (upstream already does), reports upstream commits that touch
files a fork patch owns, and evaluates the anchors in `fork-manifest.json`.

An **anchor** is an assumption a fork patch makes about upstream — for example
"the server still exposes `/api/v1/healthz`" or "`apps/kimi-desktop` is still
absent upstream". If an anchor fails on the upstream side, the patch that
depends on it needs updating before the next release. If it fails on the fork
side, the working tree has drifted from the assumption.

When upstream changes:

1. `reconcile.mjs status` — read the verdict.
2. `reconcile.mjs diff --patch <id>` — see what upstream changed in the files
   that patch owns.
3. `reconcile.mjs rebase --upstream <ref>` — backs up the branch to
   `fork-backup/<timestamp>` and rebases.
4. Resolve conflicts, drop obsolete patches, update anchors in
   `fork-manifest.json`, run `reconcile.mjs verify`.

## Verify a release

```sh
node tools/fork/validate-artifacts.mjs --dir dist-release
node tools/fork/verify-release.mjs --tag continuous
node tools/fork/verify-release.mjs --tag v2.1.0-fork.2 --smoke
```
