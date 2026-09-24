# Kimi Code CLI — subagent/swarm thinking fork

Fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).

- Upstream documentation: <https://moonshotai.github.io/kimi-code/en/>
- Upstream issues: <https://github.com/MoonshotAI/kimi-code/issues>
- This fork's releases: <https://github.com/Nemo-010/kimi-code/releases>

This fork adds nothing to the agent itself. It changes only the terminal UI so
that the thinking traces and tool detail of subagents and swarm members are
reachable, and so the detail views expand with `Ctrl+O`.

## Fork notes

### Before

Before this fork:

- Main-agent thinking and tool cards expand with `Ctrl+O`, scoped to the most
  recent turns (`KIMI_CODE_TUI_EXPAND_TURNS`, default 3).
- A solo `Agent` card was a fixed two-row window that `Ctrl+O` could not expand.
  The child's thinking was captured (`subagentThinkingText`) but only ever shown
  as a two-line live window, and never after the subagent finished.
- The `/tasks` background-agent detail view (`AgentActivityViewer`) recorded only
  `assistant.delta`; `thinking.delta` was dropped, so thinking never appeared
  there at all.
- The `AgentSwarm` panel merged `thinking.delta` and `assistant.delta` into one
  buffer and rendered a single line per member with no expansion.

### After

After this fork:

- `Ctrl+O` expands a solo `Agent` card to the full child stream and prepends the
  child's thinking trace; the collapsed card still shows the two-row window.
- `/tasks` → open an agent shows thinking per step, expandable with the viewer's
  `Ctrl+O`.
- The `AgentSwarm` panel is expandable (`Ctrl+O`) and keeps thinking distinct
  from output per member, with a `~` prefix on thinking rows. The collapsed
  one-line label is unchanged.

### Out of scope

Out of scope (still upstream-only): swarm members do not register background
tasks, so per-member stop/attach and per-member output buffers remain absent
(see upstream #2131).

## Upstream issues addressed

| # | Title |
| --- | --- |
| [#4007](https://github.com/MoonshotAI/kimi-code/issues/4007) | Add config option to expand thinking blocks by default (persist the Ctrl+O expanded state) |
| [#2472](https://github.com/MoonshotAI/kimi-code/issues/2472) | feat(tui): add display-level toggles to collapse/hide thinking and tool-call details |
| [#2131](https://github.com/MoonshotAI/kimi-code/issues/2131) | Treat subagents as first-class observable sessions: attach, monitor, manage individually |
| [#2482](https://github.com/MoonshotAI/kimi-code/issues/2482) | ACP: subagent work is invisible — forward subagent lifecycle and streams over session updates |
| [#3362](https://github.com/MoonshotAI/kimi-code/issues/3362) | Subagent observability and resilience — per-agent metrics, infra-failure resume, failure state report |
| [#2140](https://github.com/MoonshotAI/kimi-code/issues/2140) | feat: support per-call model and thinking_level parameters in Agent and AgentSwarm tools |
| [#1957](https://github.com/MoonshotAI/kimi-code/issues/1957) | Swarm无法查看进度 |
| [#3015](https://github.com/MoonshotAI/kimi-code/issues/3015) | Subagent panel shows completed subagents as "运行中" with ever-growing timers |
| [#2154](https://github.com/MoonshotAI/kimi-code/issues/2154) | [TUI] Subagent panel keeps completed foreground subagents listed as running indefinitely |
| [#3839](https://github.com/MoonshotAI/kimi-code/issues/3839) | [Bug] Status bar shows base thinking effort instead of forced effort from `KIMI_MODEL_THINKING_EFFORT` |
| [#3190](https://github.com/MoonshotAI/kimi-code/issues/3190) | Subagent thinking effort stuck at "high" for third-party models: `support_efforts` ignored and global/inherited effort always wins |

This patch is a display change only; it does not close the model-selection,
effort-inheritance, ACP-forwarding, or per-agent-lifecycle issues above.

## Exactly what is patched

| File | Change |
| --- | --- |
| `apps/kimi-code/src/tui/controllers/subagent-activity-store.ts` | `SubagentStepActivity` gains `thinkingTail`. `applyEvent` handles `thinking.delta` into it, capped by `SUBAGENT_STEP_TEXT_TAIL_CHARS`, alongside the existing `assistant.delta` → `textTail`. |
| `apps/kimi-code/src/tui/components/dialogs/agent-activity-viewer.ts` | `buildLines` renders each step's `thinkingTail` with `ThinkingComponent` (collapsed by default, expanded by the viewer's `Ctrl+O`). `formatSubagentActivityPreview` includes a `~ thinking` block for the plain-text tasks preview. |
| `apps/kimi-code/src/tui/components/messages/tool-call.ts` | For a solo `Agent` card, `computeHiddenContent()` returns true when the child has thinking, text, error, or a result summary. `buildSingleSubagentActiveWindow` and `buildSingleSubagentResultWindow` render the full content when expanded and the two-row window when collapsed. `buildSingleSubagentBlock` prepends the child's thinking trace when expanded. |
| `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts` | Adds `setExpanded` / `isExpanded` / `hasHiddenContent` so the panel participates in the global `Ctrl+O` toggle. `AgentSwarmMember` gains `latestThinkingText` and `latestText`; `appendModelDelta` accepts `kind`. `renderExpandedDetails` renders a labelled per-member trace, `~`-prefixed for thinking. |
| `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts` | `applySubagentEventToSwarmProgress` routes `thinking.delta` and `assistant.delta` to `appendModelDelta` with `kind: 'thinking'` / `'text'` instead of merging both. |
| `apps/kimi-code/test/tui/subagent-thinking-detail.test.ts` | New behaviour tests for all of the above. |
| `apps/kimi-code/test/tui/components/messages/tool-call.test.ts` | Updated: the subagent window now expands with `Ctrl+O`; the solo-subagent `hasHiddenContent()` contract is now "true once the child has streamed content". |
| `apps/kimi-code/test/tui/components/dialogs/agent-activity-viewer.test.ts` | Updated fixtures for the new `thinkingTail` field. |

Nothing outside `apps/kimi-code` (engine, protocol, SDK, server, web bundle) is
touched.

## Build

Requires Node.js >= 24.15.0 and pnpm 10.33.0 (`corepack enable`).

```sh
pnpm install
pnpm run build
node apps/kimi-code/dist/main.mjs --version   # 2.1.0
```

CLI app only:

```sh
pnpm -C apps/kimi-code run build
```

Native single executable (linux-x64):

```sh
pnpm -C apps/kimi-code run build:native:sea
pnpm -C apps/kimi-code run package:native
# apps/kimi-code/dist-native/artifacts/kimi-code-linux-x64.zip
```

## Verify

Focused suite:

```sh
pnpm -C apps/kimi-code exec vitest run test/tui/subagent-thinking-detail.test.ts
```

It asserts that main thinking expands; that a solo `Agent` card advertises
hidden content and reveals the full thinking trace on expand; that the activity
store keeps thinking and assistant text in separate tails; that the swarm path
routes thinking and output with their kind; and that the expanded swarm panel
renders both.

Surrounding suites:

```sh
pnpm -C apps/kimi-code exec vitest run \
  test/tui/components/messages/tool-call.test.ts \
  test/tui/components/messages/agent-swarm-progress.test.ts \
  test/tui/components/dialogs/agent-activity-viewer.test.ts \
  test/tui/controllers/subagent-event-handler.test.ts \
  test/tui/controllers/subagent-activity-store.test.ts
```

Whole app suite and typecheck:

```sh
pnpm -C apps/kimi-code exec vitest run
pnpm -C apps/kimi-code run typecheck
```

## CI

The upstream `.github/workflows/ci.yml` runs on `main`: `pnpm run build` plus
the smoke test, the sharded test suite, `pi-tui` on `node:test`, the v1-engine
VS Code suite, lint, and typecheck. It is enabled on this fork, and this fork
adds a `workflow_dispatch` trigger so it can also be run by hand:

```sh
gh workflow run CI -R Nemo-010/kimi-code
```

## Releases

Native binaries are attached to this fork's GitHub Releases, built from `main`
with the commands in [Build](#build). The current release is
[`v2.1.0-fork.1`](https://github.com/Nemo-010/kimi-code/releases/tag/v2.1.0-fork.1):

- `kimi-code-linux-x64.zip` — Node SEA single executable, linux-x64, unsigned.
- `kimi-code-linux-x64.zip.sha256`.

```sh
unzip kimi-code-linux-x64.zip
./kimi --version
sha256sum -c kimi-code-linux-x64.zip.sha256
```

The fork's release pipeline is `.github/workflows/fork-release.yml`
(`workflow_dispatch`): it builds the native bundles, the desktop installers and
the pkgforge AppImages, then attaches them to the release tag. The upstream
`release.yml` is gated to the `MoonshotAI` organisation, so it does not run on
this fork. Other platforms are produced by the upstream native-bundle workflow;
this fork publishes only what it builds.

## Desktop app

This fork restores the Electron desktop client (`apps/kimi-desktop`) that
upstream removed in
[#1849](https://github.com/MoonshotAI/kimi-code/pull/1849), ported to the
current server (`kimi web` foreground runner + the kap-server instance
registry instead of the removed single-instance lock). The desktop reuses a
running shared server or starts one with the bundled SEA, and reaps only the
server it started. See [`apps/kimi-desktop/README.md`](./apps/kimi-desktop/README.md)
and the porting notes in [KIMI_DESKTOP.md](./KIMI_DESKTOP.md).

Linux AppImages for the CLI and the desktop are built with pkgforge-dev's
`quick-sharun` in `.github/workflows/appimage.yml`; see
`packaging/appimage/`.

## License

MIT, unchanged from upstream. See [LICENSE](LICENSE).
