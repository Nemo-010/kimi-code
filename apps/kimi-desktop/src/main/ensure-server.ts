import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  isPidAlive,
  originFromInstance,
  readLiveInstances,
  type ServerInstanceInfo,
} from './instance-registry';

/** How long to wait for a freshly spawned `kimi web` to register and listen. */
const RUN_TIMEOUT_MS = 60_000;
/** Per-request budget for `/api/v1/healthz`. */
const HEALTH_TIMEOUT_MS = 1_000;
/** Delay between registry/health polls while waiting for a spawned server. */
const HEALTH_POLL_MS = 250;
/** Grace period between SIGTERM and SIGKILL when reaping a spawned server. */
const KILL_GRACE_MS = 5_000;

/** `<KIMI_CODE_HOME>` or `~/.kimi-code` — must match the server's `resolveKimiHome`. */
export function kimiHome(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), '.kimi-code');
}

/** Log file the desktop writes the spawned server's output to. */
export function serverLogPath(): string {
  return join(kimiHome(), 'server', 'kimi-desktop.log');
}

export interface EnsureServerResult {
  /** Origin of the shared server the desktop should load the web UI from. */
  origin: string;
  /**
   * The child process when the desktop started the server itself, so the caller
   * can reap it on quit. Undefined when an existing server was reused.
   */
  child?: ChildProcess;
}

export interface EnsureServerDeps {
  spawn?: typeof spawn;
  fetchImpl?: typeof fetch;
  listLive?: (homeDir: string) => ServerInstanceInfo[];
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openLog?: () => WriteStream | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultOpenLog(): WriteStream | undefined {
  try {
    const path = serverLogPath();
    mkdirSync(dirname(path), { recursive: true });
    return createWriteStream(path, { flags: 'a' });
  } catch {
    return undefined;
  }
}

export async function isHealthy(
  origin: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/api/v1/healthz`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { code?: unknown };
    return body.code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find an already-running shared daemon, or start one with the bundled SEA.
 *
 * The desktop participates in the same local-server ecosystem as the CLI, the
 * browser and the TUI: it reuses a registered server when one is live and
 * healthy, and otherwise runs `kimi web --no-open` (foreground, attached to
 * this process). `kimi web` always starts a new server rather than reusing an
 * existing one, so the reuse decision has to be made here from the registry.
 */
export async function ensureServer(
  seaPath: string,
  deps: EnsureServerDeps = {},
): Promise<EnsureServerResult> {
  const home = kimiHome();
  const spawnImpl = deps.spawn ?? spawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const listLive = deps.listLive ?? ((dir: string) => readLiveInstances(dir, deps.isAlive));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  for (const info of listLive(home)) {
    const origin = originFromInstance(info);
    if (await isHealthy(origin, HEALTH_TIMEOUT_MS, fetchImpl)) {
      return { origin };
    }
  }

  const known = new Set(listLive(home).map((info) => info.serverId));
  const log = (deps.openLog ?? defaultOpenLog)();
  const child = spawnImpl(seaPath, ['web', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => log?.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => log?.write(chunk));

  let spawnError: Error | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
  });

  const fail = (reason: string): never => {
    stopServer(child);
    log?.end();
    throw new Error(`${reason} See ${serverLogPath()}.`);
  };

  const deadline = now() + RUN_TIMEOUT_MS;
  while (now() < deadline) {
    if (spawnError !== undefined) {
      return fail(`Failed to start the bundled Kimi server: ${spawnError.message}.`);
    }
    if (exit !== undefined) {
      return fail(
        `The bundled Kimi server exited before it became ready (code ${String(exit.code)}, signal ${String(exit.signal)}).`,
      );
    }
    for (const info of listLive(home)) {
      if (known.has(info.serverId)) continue;
      const origin = originFromInstance(info);
      if (await isHealthy(origin, HEALTH_TIMEOUT_MS, fetchImpl)) {
        return { origin, child };
      }
    }
    await sleep(HEALTH_POLL_MS);
  }
  return fail(`The Kimi server did not become healthy within ${RUN_TIMEOUT_MS}ms.`);
}

/** Reap a server the desktop started, so quitting does not orphan it. */
export function stopServer(child: ChildProcess | undefined): void {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS);
  timer.unref();
}

export { isPidAlive };
