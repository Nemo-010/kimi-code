// Register the desktop's browser as an MCP server for the bundled `kimi`.
//
// The agent's browser tool is `mcp__desktop_browser__run` — the committed web
// UI bundle renders exactly that name and parses its output as
// `kimi.browser/1.0.0`. So the browser the user sees in the panel and the
// browser the agent drives are the same thing, reached two ways: the panel over
// IPC, the agent over MCP.
//
// `kimi` reads MCP servers from `<KIMI_CODE_HOME>/mcp.json` (the user layer).
// The entry is rewritten on every launch because the port is ephemeral.
//
// The transport is HTTP, not stdio. A stdio entry would have to name a Node
// interpreter, and no such interpreter ships with the desktop: the AppImage's
// only executable is Electron, whose path is inside the AppImage mount. The
// main process serves the protocol itself (browser-http.ts) and the entry
// carries the loopback URL and the bearer token that reaches it.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MCP_SERVER_NAME } from './browser-mcp';

/** Marker so we only ever touch the entry this app installed. */
const MANAGED_BY = 'kimi-desktop';

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RegisterBrowserOptions {
  /** `<KIMI_CODE_HOME>`. */
  readonly kimiHome: string;
  /** Loopback MCP endpoint, e.g. `http://127.0.0.1:41234/mcp`. */
  readonly url: string;
  /** Bearer token the endpoint requires. */
  readonly token: string;
}

/** The whole entry, shared by the file write and the live-daemon call. */
function browserEntry(url: string, token: string): Record<string, unknown> {
  return {
    managedBy: MANAGED_BY,
    transport: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` },
    // The panel is already open in front of the user, so a slow first call is
    // acceptable; long pages need time to load.
    startupTimeoutMs: 20_000,
    toolTimeoutMs: 120_000,
  };
}

/**
 * Teach a running daemon about the endpoint through its own API.
 *
 * The daemon reads `mcp.json` once, at load, and nothing watches the file; its
 * config store only announces writes made through itself. `kimi web` is
 * normally already running by the time the desktop starts, so writing the file
 * alone would leave the browser tool missing until the daemon is restarted.
 * Creating the server over REST is what makes the tool appear in a live
 * process; adding an existing name is expected on relaunch, so it is treated as
 * done.
 */
export async function registerBrowserMcpWithServer(options: {
  /** Origin of the running daemon, e.g. `http://127.0.0.1:3789`. */
  readonly origin: string;
  /** Credential the web UI stores and sends as a bearer token. */
  readonly credential: string;
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${options.origin}/api/v1/mcp/servers`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.credential}`,
      },
      body: JSON.stringify({ name: MCP_SERVER_NAME, ...browserEntry(options.url, options.token) }),
    });
    if (response.ok) return true;
    // 400 means the name is already there, which is the normal case on a second
    // launch: the endpoint is new, so the entry still needs updating.
    return doFetch(`${options.origin}/api/v1/mcp/servers/${encodeURIComponent(MCP_SERVER_NAME)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.credential}`,
      },
      body: JSON.stringify(browserEntry(options.url, options.token)),
    }).then((updated) => updated.ok);
  } catch {
    // No daemon yet, or it is still starting: the file write still stands, and
    // a later launch will reach it.
    return false;
  }
}

export function mcpJsonPath(kimiHome: string): string {
  return join(kimiHome, 'mcp.json');
}

/**
 * Write (or refresh) the `desktop_browser` MCP entry.
 *
 * Everything else in the file is preserved: a user's own servers must survive
 * this being called on every launch.
 */
export function registerBrowserMcp(options: RegisterBrowserOptions): void {
  const path = mcpJsonPath(options.kimiHome);
  let document: McpJson = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      document = parsed as McpJson;
    }
  } catch {
    // No file yet, or unreadable — start from an empty document. A malformed
    // file is rewritten rather than left to break every MCP server.
  }

  const existing = document.mcpServers;
  const servers: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const current = servers[MCP_SERVER_NAME];
  const managed =
    typeof current === 'object' && current !== null && (current as { managedBy?: unknown })['managedBy'] === MANAGED_BY;
  if (current !== undefined && !managed) {
    // Somebody else owns this name; do not take it from them.
    return;
  }

  servers[MCP_SERVER_NAME] = browserEntry(options.url, options.token);

  const next: McpJson = { ...document, mcpServers: servers };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  // The token is in this file, so it must never be group- or world-readable.
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  // Rename so a crash mid-write cannot leave a half-written mcp.json, which
  // would take every other MCP server down with it.
  renameSync(temporary, path);
}

/** Remove the entry this app installed, leaving every other server alone. */
export function unregisterBrowserMcp(kimiHome: string): void {
  const path = mcpJsonPath(kimiHome);
  let document: McpJson;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    document = parsed as McpJson;
  } catch {
    return;
  }
  const servers = document.mcpServers;
  if (typeof servers !== 'object' || servers === null) return;
  const current = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (
    typeof current !== 'object' ||
    current === null ||
    (current as { managedBy?: unknown })['managedBy'] !== MANAGED_BY
  ) {
    return;
  }
  const next = { ...(servers as Record<string, unknown>) };
  delete next[MCP_SERVER_NAME];
  // Write an empty file rather than deleting: the update lands immediately and
  // a reader that races this cannot resurrect the old endpoint.
  // This one rewrites a file the daemon owns, so it already exists and `mode`
  // does nothing; the chmod is what actually keeps the bearer header private.
  writeFileSync(path, `${JSON.stringify({ ...document, mcpServers: next }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
