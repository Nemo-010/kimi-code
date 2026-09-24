# Kimi Code CLI

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/) <br>
[Documentation](https://moonshotai.github.io/kimi-code/en/) · [Issues](https://github.com/MoonshotAI/kimi-code/issues) · [中文](README.zh-CN.md)

![Demo of using Kimi Code](./docs/media/intro.gif)

## Fork notes

This is a fork of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
that makes subagent and swarm thinking/output detail reachable from the TUI.
The upstream feature requests this addresses:

- [#4007 Add config option to expand thinking blocks by default](https://github.com/MoonshotAI/kimi-code/issues/4007)
- [#2472 add display-level toggles to collapse/hide thinking and tool-call details](https://github.com/MoonshotAI/kimi-code/issues/2472)
- [#2131 Treat subagents as first-class observable sessions](https://github.com/MoonshotAI/kimi-code/issues/2131)
- [#2482 ACP: subagent work is invisible — forward lifecycle/streams](https://github.com/MoonshotAI/kimi-code/issues/2482)
- [#3362 Subagent observability and resilience](https://github.com/MoonshotAI/kimi-code/issues/3362)
- [#2140 per-call model and thinking_level in Agent/AgentSwarm](https://github.com/MoonshotAI/kimi-code/issues/2140)
- [#1957 Swarm无法查看进度](https://github.com/MoonshotAI/kimi-code/issues/1957)
- [#3015 Subagent panel shows completed subagents as "运行中"](https://github.com/MoonshotAI/kimi-code/issues/3015)
- [#2154 TUI subagent panel keeps completed subagents running](https://github.com/MoonshotAI/kimi-code/issues/2154)
- [#3839 Status bar shows base thinking effort](https://github.com/MoonshotAI/kimi-code/issues/3839)
- [#3190 Subagent thinking effort stuck at "high"](https://github.com/MoonshotAI/kimi-code/issues/3190)

### Exactly what is patched

Before this fork, main-agent thinking and tool cards expand with `Ctrl+O`, but a
solo `Agent` card was a fixed two-row window that `Ctrl+O` could not expand, the
`/tasks` background-agent detail view recorded only assistant text (never
thinking), and the `AgentSwarm` panel merged thinking and output into one
single-line label with no expansion.

| File | Change |
| --- | --- |
| `apps/kimi-code/src/tui/controllers/subagent-activity-store.ts` | Record `thinking.delta` into a new `SubagentStepActivity.thinkingTail`, bounded by `SUBAGENT_STEP_TEXT_TAIL_CHARS`. |
| `apps/kimi-code/src/tui/components/dialogs/agent-activity-viewer.ts` | Render each step's thinking with `ThinkingComponent`, expandable by the viewer's `Ctrl+O`; include it in the plain-text preview. |
| `apps/kimi-code/src/tui/components/messages/tool-call.ts` | Solo `Agent` card: `hasHiddenContent()` reports the child thinking/text/error; the active and result windows render the full content when expanded and prepend the thinking trace. |
| `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts` | `setExpanded` / `isExpanded` / `hasHiddenContent`; per-member `latestThinkingText` and `latestText`; an expanded per-member trace with `~`-prefixed thinking and output. |
| `apps/kimi-code/src/tui/controllers/subagent-event-handler.ts` | Pass `kind: 'thinking' \| 'text'` to the swarm panel's `appendModelDelta`. |
| `apps/kimi-code/test/tui/subagent-thinking-detail.test.ts` | New behaviour tests. |
| `apps/kimi-code/test/tui/components/messages/tool-call.test.ts`, `apps/kimi-code/test/tui/components/dialogs/agent-activity-viewer.test.ts` | Updated for the new expand/thinking behaviour. |

After the patch: `Ctrl+O` expands a solo `Agent` card to the full child stream
and its thinking trace; `/tasks` → open an agent shows thinking per step; the
`AgentSwarm` panel expands to a per-member thinking/output trace while keeping
its collapsed one-line label. Swarm members still do not register background
tasks, so per-member stop/attach remains out of scope (see #2131).

### How to build

Requires Node.js >= 24.15.0 and pnpm 10.33.0 (`corepack enable`).

```sh
pnpm install
pnpm run build
node apps/kimi-code/dist/main.mjs --version
```

To build only the CLI app:

```sh
pnpm -C apps/kimi-code run build
```

### How to verify

```sh
pnpm install
pnpm -C apps/kimi-code exec vitest run test/tui/subagent-thinking-detail.test.ts
```

The focused suite asserts: main thinking expands; a solo `Agent` card advertises
hidden content and reveals the full trace on expand; the activity store records
thinking separately from assistant text; and the swarm path routes thinking and
output with their kind and renders both when expanded.

Run the whole app suite with:

```sh
pnpm -C apps/kimi-code exec vitest run
```

### CI and binaries

The upstream `.github/workflows/ci.yml` runs `pnpm run build` and the sharded
test suite on every push to `main`; it is enabled on this fork. Native binaries
are built from `apps/kimi-code` with `pnpm -C apps/kimi-code run build:native:sea`
(`build:native:release` for the signed release profile); released assets are
attached to the fork's GitHub Releases.

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal — it can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI’s Kimi models and can also be configured to use other compatible providers.

## Install

Install with the official script. No Node.js required.

- **macOS or Linux**:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows (PowerShell)**:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Kimi Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Then, run it with a new shell session:

```sh
kimi --version
```

For npm install, upgrade, uninstall, see [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started).

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
kimi
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Moonshot AI Open Platform API key. After login, try your first task:

```
Take a look at this project and explain its main directories.
```

## Key Features

- **Single-binary distribution.** Install with one command: no Node.js setup, PATH gymnastics, or global module conflicts.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so starting a session never feels heavy.
- **Purpose-built TUI.** A carefully tuned interface, optimized end to end for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat and let the agent watch what is hard to describe in words — turn a reference clip into a LUT, a long video into a short, a screen recording into working code, and more.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally with `/mcp-config`, without hand-editing JSON.
- **Rich plugin ecosystem.** Install skills, MCP servers, and data sources from the marketplace or any GitHub repo, with each install's trust level surfaced up front.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, and `plan` subagents in isolated contexts while keeping the main conversation clean.
- **Lifecycle hooks.** Run local commands at key points to gate risky tool calls, audit decisions, trigger desktop notifications, or connect to your own automation.
- **Editor & IDE integration (ACP).** Drive a Kimi Code CLI session straight from Zed, JetBrains, or any [Agent Client Protocol](https://agentclientprotocol.com/) client with `kimi acp`.

## Use it in your editor (ACP)

Kimi Code CLI speaks the [Agent Client Protocol](https://agentclientprotocol.com/), so ACP-compatible editors and IDEs (Zed, JetBrains, …) can drive a session over stdio. Log in once, then point your editor at the `kimi acp` subcommand — no extra login needed.

For Zed, add this to `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Then open a new conversation in Zed's Agent panel. See [Using in IDEs](https://moonshotai.github.io/kimi-code/en/guides/ides) for JetBrains setup and troubleshooting, and the [`kimi acp` reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) for the full capability matrix.

## Docs

- [Getting Started](https://moonshotai.github.io/kimi-code/en/guides/getting-started)
- [Interaction and approvals](https://moonshotai.github.io/kimi-code/en/guides/interaction)
- [Sessions](https://moonshotai.github.io/kimi-code/en/guides/sessions)
- [Using in IDEs (ACP)](https://moonshotai.github.io/kimi-code/en/guides/ides)
- [Configuration](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- [Command reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)

## Develop

Requirements: Node.js ≥ 24.15.0, pnpm 10.33.0.

```sh
git clone https://github.com/MoonshotAI/kimi-code.git
cd kimi-code
pnpm install
```

```sh
pnpm dev:cli    # run the CLI in dev mode
pnpm test       # run tests
pnpm typecheck  # TypeScript check
pnpm lint       # oxlint
pnpm build      # build all packages
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution guide.

## Community

- [Issues](https://github.com/MoonshotAI/kimi-code/issues)
- For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Acknowledgements

Our TUI is built on top of [`pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui). We thank the authors of `pi-tui` for their valuable work.

## License

Released under the [MIT License](LICENSE).
