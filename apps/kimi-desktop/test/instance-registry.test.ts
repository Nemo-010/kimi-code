import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  decodeInstance,
  instancesDir,
  originFromInstance,
  readLiveInstances,
} from '../src/main/instance-registry';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-desktop-'));
  tempDirs.push(dir);
  return dir;
}

function writeInstance(home: string, name: string, body: unknown): void {
  const dir = instancesDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('decodeInstance', () => {
  it('accepts the kap-server disk shape', () => {
    expect(
      decodeInstance(
        JSON.stringify({
          server_id: 's1',
          pid: 42,
          host: '127.0.0.1',
          port: 58627,
          started_at: 100,
          heartbeat_at: 200,
          host_version: '2.1.0',
        }),
      ),
    ).toEqual({
      serverId: 's1',
      pid: 42,
      host: '127.0.0.1',
      port: 58627,
      startedAt: 100,
      heartbeatAt: 200,
      serverVersion: '2.1.0',
    });
  });

  it('rejects malformed and incomplete entries', () => {
    expect(decodeInstance('not json')).toBeUndefined();
    expect(decodeInstance(JSON.stringify({ server_id: 's1', pid: 1 }))).toBeUndefined();
    expect(decodeInstance(JSON.stringify({ port: 1, pid: 2 }))).toBeUndefined();
  });
});

describe('originFromInstance', () => {
  it('maps a wildcard bind to loopback', () => {
    expect(originFromInstance({ host: '0.0.0.0', port: 58627 })).toBe('http://127.0.0.1:58627');
    expect(originFromInstance({ host: '', port: 1 })).toBe('http://127.0.0.1:1');
  });

  it('brackets IPv6 hosts', () => {
    expect(originFromInstance({ host: '::1', port: 1234 })).toBe('http://[::1]:1234');
  });
});

describe('readLiveInstances', () => {
  it('returns live instances oldest first and skips dead pids', () => {
    const home = tempHome();
    writeInstance(home, 'a.json', {
      server_id: 'new',
      pid: 2,
      host: '127.0.0.1',
      port: 2,
      started_at: 200,
      heartbeat_at: 200,
    });
    writeInstance(home, 'b.json', {
      server_id: 'old',
      pid: 1,
      host: '127.0.0.1',
      port: 1,
      started_at: 100,
      heartbeat_at: 100,
    });
    writeInstance(home, 'c.json', {
      server_id: 'dead',
      pid: 3,
      host: '127.0.0.1',
      port: 3,
      started_at: 50,
      heartbeat_at: 50,
    });
    const live = readLiveInstances(home, (pid) => pid !== 3);
    expect(live.map((info) => info.serverId)).toEqual(['old', 'new']);
  });

  it('returns an empty list when the registry does not exist', () => {
    expect(readLiveInstances(tempHome(), () => true)).toEqual([]);
  });
});
