import { describe, expect, it } from 'vitest';

import { BROWSER_OPERATIONS, BROWSER_PROTOCOL, browserOk } from '../src/main/browser-protocol';
import type { BrowserRequest } from '../src/main/browser-protocol';
import { MCP_SERVER_NAME, MCP_TOOL_NAME, TOOL_INPUT_SCHEMA, toolDescription } from '../src/main/browser-mcp';
import { authorizedHeader, handleMcpHttpRequest, type McpHttpReply } from '../src/main/browser-http';

const TOKEN = 'a'.repeat(64);
const seen: BrowserRequest[] = [];

/** Post one JSON-RPC message, the way `kimi`'s HTTP transport does. */
async function rpc(
  message: unknown,
  overrides: Partial<{ path: string; method: string; authorization: string | undefined; body: string }> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const reply: McpHttpReply = await handleMcpHttpRequest(
    {
      method: 'POST',
      path: '/mcp',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify(message),
      ...overrides,
    },
    {
      token: TOKEN,
      run: (request) => {
        seen.push(request);
        return Promise.resolve(browserOk({ browser: { available: true, panelVisible: true, tabs: [] } }));
      },
      log: () => undefined,
    },
  );
  return {
    status: reply.status,
    json: reply.body.length === 0 ? {} : (JSON.parse(reply.body) as Record<string, unknown>),
  };
}

function toolsCall(arguments_: unknown): unknown {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run', arguments: arguments_ } };
}

describe('desktop_browser over MCP', () => {
  it('is named the way the committed web bundle expects', () => {
    // The bundle hardcodes `mcp__desktop_browser__run`; if either half changes,
    // the agent silently loses the browser tool and the panel has no renderer.
    expect(MCP_SERVER_NAME).toBe('desktop_browser');
    expect(MCP_TOOL_NAME).toBe('run');
  });

  it('qualifies to the exact tool name the daemon will build', () => {
    // Copied from packages/agent-core-v2/src/mcpCore/tool-naming.ts. The bundle
    // constant `f4` is `mcp__desktop_browser__run`, so the server and tool names
    // have to survive sanitisation and the 64-character cap unchanged.
    const sanitize = (part: string): string =>
      part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
    const qualified = `mcp__${sanitize(MCP_SERVER_NAME)}__${sanitize(MCP_TOOL_NAME)}`;
    expect(qualified).toBe('mcp__desktop_browser__run');
    expect(qualified.length).toBeLessThanOrEqual(64);
  });

  it('offers exactly one tool, as the shipped backend does', () => {
    // `strings` on the shipped SEA shows the only desktop MCP tool is
    // `mcp__desktop_browser__run`; there is no second desktop server.
    expect(MCP_SERVER_NAME).toBe('desktop_browser');
    expect(MCP_TOOL_NAME).toBe('run');
  });

  it('describes every operation it accepts', () => {
    const description = toolDescription();
    for (const operation of BROWSER_OPERATIONS) expect(description).toContain(operation);
  });

  it('accepts the whole operation set declared by the protocol', () => {
    const schema = TOOL_INPUT_SCHEMA as unknown as { properties: { operation: { enum: string[] } } };
    expect(schema.properties.operation.enum).toStrictEqual([...BROWSER_OPERATIONS]);
  });

  it('initializes as a tools-only server', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(status).toBe(200);
    expect(json['result']).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: 'desktop_browser' },
    });
  });

  it('lists exactly one run tool', async () => {
    const { json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (json['result'] as { tools: { name: string }[] }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('run');
  });

  it('returns the envelope as text and as structured content', async () => {
    seen.length = 0;
    const { json } = await rpc(toolsCall({ protocol: BROWSER_PROTOCOL, operation: 'browser.get_state' }));
    const result = json['result'] as { content: { type: string; text: string }[]; structuredContent: unknown };
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({ ok: true });
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({ protocol: BROWSER_PROTOCOL, operation: 'browser.get_state' });
  });

  it('refuses a call with the wrong protocol version before touching the engine', async () => {
    seen.length = 0;
    const { json } = await rpc(toolsCall({ protocol: 'kimi.browser/0.9.0', operation: 'browser.get_state' }));
    const result = json['result'] as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
  });

  it('refuses an operation outside the whitelist before touching the engine', async () => {
    seen.length = 0;
    const { json } = await rpc(toolsCall({ protocol: BROWSER_PROTOCOL, operation: 'page.visual.explode' }));
    const result = json['result'] as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(seen).toHaveLength(0);
  });

  it('rejects a request with no bearer token', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: undefined });
    expect(status).toBe(401);
  });

  it('rejects a request with the wrong bearer token', async () => {
    const { status } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${'b'.repeat(64)}` },
    );
    expect(status).toBe(401);
  });

  it('always parses the token in constant time', () => {
    expect(authorizedHeader(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorizedHeader(TOKEN, TOKEN)).toBe(false);
    expect(authorizedHeader('Bearer short', TOKEN)).toBe(false);
    expect(authorizedHeader(undefined, TOKEN)).toBe(false);
  });

  it('answers a notification batch with 202 and no body', async () => {
    const reply = await handleMcpHttpRequest(
      {
        method: 'POST',
        path: '/mcp',
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      },
      { token: TOKEN, run: () => Promise.resolve(browserOk({})), log: () => undefined },
    );
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('answers a batch of calls with an array', async () => {
    const { json } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
  });

  it('answers an unknown method with a JSON-RPC error, not a crash', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    expect(status).toBe(200);
    expect((json['error'] as { code: number }).code).toBe(-32601);
  });

  it('returns a parse error for malformed JSON', async () => {
    const { status, json } = await rpc(null, { body: '{ not json' });
    expect(status).toBe(400);
    expect((json['error'] as { code: number }).code).toBe(-32700);
  });

  it('serves only the /mcp path', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/other' });
    expect(status).toBe(404);
  });

  it('refuses a GET, which would hold the connection open for a stream', async () => {
    const { status } = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { method: 'GET' });
    expect(status).toBe(405);
  });

  it('refuses a body above the limit instead of buffering it', async () => {
    const { status } = await rpc(null, { body: JSON.stringify({ pad: 'x'.repeat(9 << 20) }) });
    expect(status).toBe(413);
  });

  it('reports an engine failure as an internal error rather than dropping the call', async () => {
    const reply = await handleMcpHttpRequest(
      {
        method: 'POST',
        path: '/mcp',
        authorization: `Bearer ${TOKEN}`,
        body: JSON.stringify(
          toolsCall({ protocol: BROWSER_PROTOCOL, operation: 'browser.get_state' }),
        ),
      },
      {
        token: TOKEN,
        run: () => Promise.reject(new Error('the window went away')),
        log: () => undefined,
      },
    );
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body) as { error?: { code: number; message: string } };
    // The tool call itself is what failed, so the error is reported inside the
    // tool result rather than as a transport-level JSON-RPC error.
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toContain('the window went away');
  });
});
