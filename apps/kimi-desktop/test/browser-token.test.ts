import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureBrowserToken } from '../src/main/browser-http';

describe('browser MCP bearer token', () => {
  it('creates a token only the owner can read', () => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    const token = ensureBrowserToken(home);
    expect(token).toHaveLength(64);
    const path = join(home, 'server', 'browser-mcp.token');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tightens a token file left world-readable by an earlier build', () => {
    // writeFileSync's `mode` applies only at creation, so a token that already
    // exists keeps its permissions. This file grants access to the browser, so
    // it must be repaired rather than trusted.
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    mkdirSync(join(home, 'server'), { recursive: true });
    const path = join(home, 'server', 'browser-mcp.token');
    const existing = 'b'.repeat(64);
    writeFileSync(path, existing, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(ensureBrowserToken(home)).toBe(existing);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reuses the token across calls so a running agent keeps working', () => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    expect(ensureBrowserToken(home)).toBe(ensureBrowserToken(home));
  });

  it('replaces a token that is too short to be safe', () => {
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'));
    mkdirSync(join(home, 'server'), { recursive: true });
    writeFileSync(join(home, 'server', 'browser-mcp.token'), 'short\n', { mode: 0o600 });
    const token = ensureBrowserToken(home);
    expect(token).not.toBe('short');
    expect(token).toHaveLength(64);
  });
});
