import { describe, expect, it } from 'vitest';

import { BROWSER_PROTOCOL, browserError, browserOk } from '../src/main/browser-protocol';
import { MCP_TOOL_NAME } from '../src/main/browser-mcp';
import { handleMcpHttpRequest } from '../src/main/browser-http';

/**
 * The panel's own readers, copied from the committed web bundle
 * (`apps/kimi-code/dist-web/assets/index-CiJ6FDOC.js`). They are reproduced
 * here so the contract is checked against the real logic rather than against
 * an assumption about it:
 *
 *   - `f4 = "mcp__desktop_browser__run"` — the tool name the panel matches.
 *   - `mbt = "kimi.browser/1.0.0"` — the protocol it accepts in the arguments.
 *   - `Dl` parses the arguments; it requires a non-array object.
 *   - `wR` flattens tool output into lines, splitting `{type:"text",text}`.
 *   - `iK` parses a JSON object out of the text, either as a whole or by brace
 *     matching, and `gbt` takes the first object whose `ok` is a boolean.
 */
const PANEL_TOOL_NAME = 'mcp__desktop_browser__run';
const PANEL_PROTOCOL = 'kimi.browser/1.0.0';

function panelParseArguments(raw: string | undefined): { protocol?: string } | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { protocol?: string })
      : null;
  } catch {
    return null;
  }
}

function panelFlattenOutput(output: unknown): string[] {
  if (output === null || output === undefined) return [];
  if (typeof output === 'string') return output.split('\n');
  if (!Array.isArray(output)) return [];
  const lines: string[] = [];
  for (const entry of output) {
    if (typeof entry === 'string') lines.push(...entry.split('\n'));
    else if (entry !== null && typeof entry === 'object') {
      const block = entry as { type?: string; text?: string };
      if (block.type === 'text' && typeof block.text === 'string') lines.push(...block.text.split('\n'));
    }
  }
  return lines;
}

/** The bundle's `iK`: a JSON object at the start of the text, brace-matched. */
function panelParseEnvelope(text: string): Record<string, unknown> | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if ((ch === '}' || ch === ']') && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed.slice(0, i + 1));
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The bundle's `gbt`: first parsed block whose `ok` is a boolean. */
function panelReadEnvelope(output: unknown): Record<string, unknown> | undefined {
  const lines = panelFlattenOutput(output);
  for (const line of lines) {
    const parsed = panelParseEnvelope(line);
    if (typeof parsed?.['ok'] === 'boolean') return parsed;
  }
  const joined = panelParseEnvelope(lines.join('\n'));
  if (typeof joined?.['ok'] === 'boolean') return joined;
  return undefined;
}

const outputOf = (result: Record<string, unknown>): unknown =>
  (((result['result'] as { content?: unknown } | undefined) ?? {}).content ?? undefined);

const TOKEN = 'c'.repeat(64);

async function callTool(
  arguments_: Record<string, unknown>,
  run: (request: Record<string, unknown>) => unknown = () => browserOk({}),
): Promise<Record<string, unknown>> {
  const reply = await handleMcpHttpRequest(
    {
      method: 'POST',
      path: '/mcp',
      authorization: `Bearer ${TOKEN}`,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: MCP_TOOL_NAME, arguments: arguments_ },
      }),
    },
    { token: TOKEN, run: (request) => Promise.resolve(run(request)), log: () => undefined },
  );
  return JSON.parse(reply.body) as Record<string, unknown>;
}

describe('the Browser panel can read what this server returns', () => {
  it('is the tool the panel matches on', () => {
    // `f4` in the bundle is this exact string, and `l1(e)` compares by name.
    expect(MCP_TOOL_NAME).toBe('run');
    expect(`mcp__desktop_browser__${MCP_TOOL_NAME}`).toBe(PANEL_TOOL_NAME);
  });

  it('carries a protocol the panel accepts in the call arguments', () => {
    expect(BROWSER_PROTOCOL).toBe(PANEL_PROTOCOL);
  });

  it('returns a result the panel parses into an envelope', async () => {
    // The panel reads the arguments off the tool-call frame (`e.arg`); what the
    // agent sends is what it will see.
    const arguments_ = { protocol: BROWSER_PROTOCOL, operation: 'browser.get_state' };
    expect(panelParseArguments(JSON.stringify(arguments_))?.protocol).toBe(PANEL_PROTOCOL);

    const called = await callTool(arguments_, () =>
      browserOk({ browser: { available: true, panelVisible: true, tabs: [] } }),
    );
    const envelope = panelReadEnvelope(outputOf(called));
    expect(envelope?.['ok']).toBe(true);
    expect(envelope?.['browser']).toMatchObject({ available: true, panelVisible: true });
  });

  it('renders an error envelope, so a failed call shows a reason', async () => {
    const called = await callTool(
      { protocol: BROWSER_PROTOCOL, operation: 'tab.get_state', tabId: 'gone' },
      () => browserError('TAB_NOT_FOUND', 'No such tab.'),
    );
    const envelope = panelReadEnvelope(outputOf(called));
    expect(envelope?.['ok']).toBe(false);
    expect((envelope?.['error'] as { code: string }).code).toBe('TAB_NOT_FOUND');
  });

  it('keeps every response readable after flattening to lines', async () => {
    // The panel splits text into lines before trying the whole blob, so a
    // multi-line payload must survive both paths.
    const called = await callTool(
      { protocol: BROWSER_PROTOCOL, operation: 'page.elements.snapshot' },
      () =>
        browserOk({
          elements: {
            snapshotId: 's1',
            total: 2,
            elements: [
              { ref: 'e1', role: 'button', name: 'Sign in', bounds: { x: 1, y: 2, width: 3, height: 4 } },
              { ref: 'e2', role: 'link', name: 'Docs' },
            ],
          },
        }),
    );
    const envelope = panelReadEnvelope(outputOf(called));
    expect(envelope?.['ok']).toBe(true);
    const elements = (envelope?.['elements'] as { elements: unknown[] }).elements;
    expect(elements).toHaveLength(2);
  });

  it('never emits an envelope the panel would skip for lacking a boolean ok', async () => {
    for (const response of [
      browserOk({}),
      browserOk({ tab: { tabId: 't1' } }),
      browserError('INVALID_REQUEST', 'bad'),
    ]) {
      const called = await callTool(
        { protocol: BROWSER_PROTOCOL, operation: 'browser.get_state' },
        () => response,
      );
      expect(typeof panelReadEnvelope(outputOf(called))?.['ok']).toBe('boolean');
    }
  });
});
