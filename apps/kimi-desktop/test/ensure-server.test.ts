import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { ensureServer, stopServer, type EnsureServerDeps } from '../src/main/ensure-server';
import type { ServerInstanceInfo } from '../src/main/instance-registry';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.signalCode = signal ?? 'SIGTERM';
    return true;
  };
  return child;
}

function instance(serverId: string, port: number): ServerInstanceInfo {
  return {
    serverId,
    pid: 1000,
    host: '127.0.0.1',
    port,
    startedAt: 1,
    heartbeatAt: 1,
  };
}

const healthyFetch = (async () => ({
  ok: true,
  json: async () => ({ code: 0 }),
})) as unknown as typeof fetch;

const unhealthyFetch = (async () => ({
  ok: false,
  json: async () => ({ code: 1 }),
})) as unknown as typeof fetch;

describe('ensureServer', () => {
  it('reuses a live, healthy server and does not spawn', async () => {
    const spawn = vi.fn(() => {
      throw new Error('must not spawn when a server is healthy');
    });
    const deps: EnsureServerDeps = {
      fetchImpl: healthyFetch,
      listLive: () => [instance('existing', 58627)],
      spawn: spawn as unknown as EnsureServerDeps['spawn'],
    };
    const result = await ensureServer('/fake/kimi', deps);
    expect(result.origin).toBe('http://127.0.0.1:58627');
    expect(result.child).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('ignores a live but unhealthy server and spawns a fresh one', async () => {
    let spawned = false;
    const child = fakeChild();
    const deps: EnsureServerDeps = {
      fetchImpl: healthyFetch,
      listLive: () => (spawned ? [instance('fresh', 6000)] : []),
      spawn: (() => {
        spawned = true;
        return child;
      }) as unknown as EnsureServerDeps['spawn'],
      sleep: async () => {},
      openLog: () => undefined,
    };
    const result = await ensureServer('/fake/kimi', deps);
    expect(result.origin).toBe('http://127.0.0.1:6000');
    expect(result.child).toBe(child);
  });

  it('waits past an unhealthy instance until it becomes healthy', async () => {
    let spawned = false;
    let healthChecks = 0;
    const child = fakeChild();
    const fetchImpl = (async () => {
      healthChecks += 1;
      return { ok: healthChecks > 1, json: async () => ({ code: 0 }) };
    }) as unknown as typeof fetch;
    const deps: EnsureServerDeps = {
      fetchImpl,
      listLive: () => (spawned ? [instance('fresh', 6000)] : []),
      spawn: (() => {
        spawned = true;
        return child;
      }) as unknown as EnsureServerDeps['spawn'],
      sleep: async () => {},
      openLog: () => undefined,
    };
    const result = await ensureServer('/fake/kimi', deps);
    expect(result.origin).toBe('http://127.0.0.1:6000');
  });

  it('fails when the spawned server exits before becoming ready', async () => {
    const child = fakeChild();
    const deps: EnsureServerDeps = {
      fetchImpl: unhealthyFetch,
      listLive: () => [],
      spawn: (() => child) as unknown as EnsureServerDeps['spawn'],
      sleep: async () => {
        child.emit('exit', 1, null);
      },
      openLog: () => undefined,
    };
    await expect(ensureServer('/fake/kimi', deps)).rejects.toThrow(/exited before it became ready/);
    expect(child.killed).toBe(true);
  });

  it('fails after the startup budget elapses', async () => {
    let now = 0;
    const deps: EnsureServerDeps = {
      fetchImpl: unhealthyFetch,
      listLive: () => [],
      spawn: (() => fakeChild()) as unknown as EnsureServerDeps['spawn'],
      now: () => (now += 10_000),
      sleep: async () => {},
      openLog: () => undefined,
    };
    await expect(ensureServer('/fake/kimi', deps)).rejects.toThrow(/did not become healthy/);
  });
});

describe('stopServer', () => {
  it('sends SIGTERM to a running child', () => {
    const child = fakeChild();
    stopServer(child as unknown as ChildProcess);
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('does nothing for an already-exited child', () => {
    const child = fakeChild();
    child.exitCode = 0;
    stopServer(child as unknown as ChildProcess);
    expect(child.killed).toBe(false);
  });
});
