import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal reader for the kap-server instance registry.
 *
 * Each live server writes `<KIMI_CODE_HOME>/server/instances/<serverId>.json`
 * and heartbeats it every 15s (packages/kap-server/src/instanceRegistry.ts).
 * The desktop reads the same files instead of importing kap-server: the whole
 * server would otherwise be bundled into the Electron main process for the
 * sake of a `{ host, port }` lookup.
 *
 * A server that is starting up registers *before* it binds, so the port in the
 * file can briefly be the requested one rather than the bound one; the file is
 * rewritten once `listen()` succeeds. Callers must therefore health-check the
 * origin rather than trust a single read.
 */
export interface ServerInstanceInfo {
  readonly serverId: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
  readonly heartbeatAt: number;
  readonly serverVersion?: string;
}

interface ServerInstanceDisk {
  server_id?: unknown;
  pid?: unknown;
  host?: unknown;
  port?: unknown;
  started_at?: unknown;
  heartbeat_at?: unknown;
  host_version?: unknown;
}

export function instancesDir(homeDir: string): string {
  return join(homeDir, 'server', 'instances');
}

export function decodeInstance(raw: string): ServerInstanceInfo | undefined {
  let parsed: ServerInstanceDisk;
  try {
    parsed = JSON.parse(raw) as ServerInstanceDisk;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.server_id !== 'string' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.host !== 'string' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.started_at !== 'number' ||
    typeof parsed.heartbeat_at !== 'number'
  ) {
    return undefined;
  }
  return {
    serverId: parsed.server_id,
    pid: parsed.pid,
    host: parsed.host,
    port: parsed.port,
    startedAt: parsed.started_at,
    heartbeatAt: parsed.heartbeat_at,
    ...(typeof parsed.host_version === 'string' ? { serverVersion: parsed.host_version } : {}),
  };
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM means the pid exists but belongs to another user.
    return true;
  }
}

/**
 * Live instances, oldest first. Files whose process is gone are skipped; the
 * server sweeps them itself, so the desktop leaves them on disk.
 */
export function readLiveInstances(
  homeDir: string,
  isAlive: (pid: number) => boolean = isPidAlive,
): ServerInstanceInfo[] {
  const dir = instancesDir(homeDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const live: ServerInstanceInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const info = decodeInstance(raw);
    if (info === undefined || !isAlive(info.pid)) continue;
    live.push(info);
  }
  live.sort((a, b) => a.startedAt - b.startedAt);
  return live;
}

/** `http://host:port`, mapping a wildcard bind to loopback. */
export function originFromInstance(info: Pick<ServerInstanceInfo, 'host' | 'port'>): string {
  const host =
    info.host === '' || info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
  const bracketed = host.includes(':') ? `[${host}]` : host;
  return `http://${bracketed}:${info.port}`;
}
