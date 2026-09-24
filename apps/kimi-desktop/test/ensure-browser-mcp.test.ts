import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mcpJsonPath, registerBrowserMcp, unregisterBrowserMcp } from '../src/main/ensure-browser-mcp';

let home: string;
const options = {
  url: 'http://127.0.0.1:41234/mcp',
  token: 'a'.repeat(64),
};

function read(): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(mcpJsonPath(home), 'utf-8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kimi-mcp-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('browser MCP registration', () => {
  it('writes an http server on loopback, not a spawned command', () => {
    registerBrowserMcp({ kimiHome: home, ...options });
    const entry = read().mcpServers['desktop_browser'];
    // No interpreter is available to spawn in the AppImage, so the entry must
    // point at the endpoint this process serves.
    expect(entry).toMatchObject({
      transport: 'http',
      url: options.url,
      headers: { Authorization: `Bearer ${options.token}` },
    });
    expect(entry).not.toHaveProperty('command');
  });

  it('names a loopback address only', () => {
    registerBrowserMcp({ kimiHome: home, ...options });
    const url = read().mcpServers['desktop_browser']?.['url'];
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('leaves the user\'s own MCP servers alone', () => {
    writeFileSync(
      mcpJsonPath(home),
      JSON.stringify({ mcpServers: { mine: { transport: 'stdio', command: 'node', args: ['x.js'] } }, other: 1 }),
    );
    registerBrowserMcp({ kimiHome: home, ...options });
    const doc = read();
    expect(doc.mcpServers['mine']).toMatchObject({ command: 'node' });
    expect(doc.mcpServers['desktop_browser']).toBeDefined();
    expect((doc as unknown as { other: number }).other).toBe(1);
  });

  it('refreshes its own entry on every launch, because the port is ephemeral', () => {
    registerBrowserMcp({ kimiHome: home, ...options });
    registerBrowserMcp({ kimiHome: home, ...options, url: 'http://127.0.0.1:59999/mcp' });
    expect(read().mcpServers['desktop_browser']).toMatchObject({
      url: 'http://127.0.0.1:59999/mcp',
    });
  });

  it('does not take a name somebody else already owns', () => {
    writeFileSync(
      mcpJsonPath(home),
      JSON.stringify({ mcpServers: { desktop_browser: { transport: 'stdio', command: 'theirs' } } }),
    );
    registerBrowserMcp({ kimiHome: home, ...options });
    // The user's own server answers to that name, so the token must not be
    // published into a file they control.
    expect(read().mcpServers['desktop_browser']).toMatchObject({ command: 'theirs' });
    expect(JSON.stringify(read())).not.toContain(options.token);
  });

  it('recovers from a corrupt file instead of failing the launch', () => {
    writeFileSync(mcpJsonPath(home), '{ not json');
    expect(() => registerBrowserMcp({ kimiHome: home, ...options })).not.toThrow();
    expect(read().mcpServers['desktop_browser']).toBeDefined();
  });

  it('removes only its own entry on quit', () => {
    writeFileSync(
      mcpJsonPath(home),
      JSON.stringify({ mcpServers: { mine: { transport: 'stdio', command: 'node' } } }),
    );
    registerBrowserMcp({ kimiHome: home, ...options });
    unregisterBrowserMcp(home);
    const doc = read();
    expect(doc.mcpServers['desktop_browser']).toBeUndefined();
    expect(doc.mcpServers['mine']).toBeDefined();
  });

  it('writes the file with owner-only permissions', () => {
    registerBrowserMcp({ kimiHome: home, ...options });
    // The entry names a socket the browser trusts, so the file must not be
    // world-writable.
    if (process.platform === 'win32') return;
    const mode = statSync(mcpJsonPath(home)).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
