import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerBrowserMcp, registerBrowserMcpWithServer } from '../src/main/ensure-browser-mcp';

const URL_UNDER_TEST = 'http://127.0.0.1:41234/mcp';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'kimi-mcp-'));
}

describe('desktop_browser MCP registration', () => {
  it('writes the entry with the bearer header and keeps other servers', () => {
    const dir = home();
    const path = join(dir, 'mcp.json');
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { mine: { transport: 'stdio', command: 'echo' } } }),
    );
    registerBrowserMcp({ kimiHome: dir, url: URL_UNDER_TEST, token: 'tok' });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.mcpServers.mine).toStrictEqual({ transport: 'stdio', command: 'echo' });
    expect(written.mcpServers.desktop_browser.transport).toBe('http');
    expect(written.mcpServers.desktop_browser.url).toBe(URL_UNDER_TEST);
    expect(written.mcpServers.desktop_browser.headers.Authorization).toBe('Bearer tok');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an entry it does not manage', () => {
    const dir = home();
    const path = join(dir, 'mcp.json');
    const theirs = { transport: 'http', url: 'http://example.invalid/mcp' };
    writeFileSync(path, JSON.stringify({ mcpServers: { desktop_browser: theirs } }));
    registerBrowserMcp({ kimiHome: dir, url: URL_UNDER_TEST, token: 'tok' });
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.desktop_browser).toStrictEqual(theirs);
  });

  it('registers with a running daemon over REST', async () => {
    const calls: { method: string; url: string; body: string; auth: string }[] = [];
    const fetchImpl = (url: string, init: RequestInit = {}): Promise<Response> => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ method: init.method ?? 'GET', url, body: String(init.body ?? ''), auth: headers['authorization'] ?? '' });
      return Promise.resolve({ ok: true } as Response);
    };
    const registered = await registerBrowserMcpWithServer({
      origin: 'http://127.0.0.1:3789',
      credential: 'cred',
      url: URL_UNDER_TEST,
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(registered).toBe(true);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:3789/api/v1/mcp/servers');
    expect(calls[0]?.auth).toBe('Bearer cred');
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(body.name).toBe('desktop_browser');
    expect(body.transport).toBe('http');
    expect(body.headers.Authorization).toBe('Bearer tok');
  });

  it('updates the existing entry when the name is already taken', async () => {
    const calls: string[] = [];
    const fetchImpl = (url: string, init: RequestInit = {}): Promise<Response> => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return Promise.resolve({ ok: init.method === 'PUT' } as Response);
    };
    const registered = await registerBrowserMcpWithServer({
      origin: 'http://127.0.0.1:3789',
      credential: 'cred',
      url: URL_UNDER_TEST,
      token: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(registered).toBe(true);
    expect(calls).toStrictEqual([
      'POST http://127.0.0.1:3789/api/v1/mcp/servers',
      'PUT http://127.0.0.1:3789/api/v1/mcp/servers/desktop_browser',
    ]);
  });

  it('reports failure instead of throwing when no daemon answers', async () => {
    const fetchImpl = (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      registerBrowserMcpWithServer({
        origin: 'http://127.0.0.1:3789',
        credential: 'cred',
        url: URL_UNDER_TEST,
        token: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);
  });
});
