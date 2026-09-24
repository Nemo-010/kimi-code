// `desktop_browser` — the MCP server the agent's browser tool talks to.
//
// The web UI renders `mcp__desktop_browser__run` (the name is part of the
// committed bundle: `f4 = "mcp__desktop_browser__run"`), and it parses that
// tool's output as `kimi.browser/1.0.0`. The desktop shell therefore has to
// offer an MCP server called `desktop_browser` exposing a single `run` tool,
// or the agent has no browser at all and the panel has nothing to show.
//
// This is the JSON-RPC 2.0 half of MCP — `initialize`, `tools/list`,
// `tools/call`, `ping` — with no transport of its own. `browser-http.ts` puts it
// on Streamable HTTP inside the Electron main process, which is what `<KIMI_CODE_HOME>/mcp.json`
// points `kimi` at.
//
// Implemented directly rather than through an SDK so the desktop shell stays
// dependency-free: the shell is bundled into the AppImage and anything it
// imports has to be packaged with it.
import {
  BROWSER_OPERATIONS,
  BROWSER_PROTOCOL,
  browserError,
  type BrowserRequest,
} from './browser-protocol';

export const MCP_SERVER_NAME = 'desktop_browser';
export const MCP_TOOL_NAME = 'run';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const JSON_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Human-readable description per operation. The model picks `run` and an
 * `operation`; without these it is guessing.
 */
const OPERATION_SUMMARY: Record<string, string> = {
  'browser.get_state': 'Report whether the browser is available and list its tabs.',
  'browser.activate_panel': 'Show the Browser panel.',
  'browser.create_tab': 'Open a new tab at a URL, or search when given a query.',
  'browser.activate_tab': 'Make a tab the controlled one.',
  'browser.switch_tab': 'Switch to a tab.',
  'browser.release_tab': 'Stop controlling a tab.',
  'browser.close_tab': 'Close a tab.',
  'browser.get_history': 'List browsing history.',
  'browser.get_downloads': 'List downloads.',
  'browser.get_device_profiles': 'List the device presets the panel can emulate.',
  'tab.get_state': 'Report a tab URL, title, loading state and viewport.',
  'tab.navigate': 'Navigate a tab to a URL.',
  'tab.search': 'Search the web in a tab.',
  'tab.go_back': 'Go back in a tab.',
  'tab.go_forward': 'Go forward in a tab.',
  'tab.reload': 'Reload a tab.',
  'tab.stop_loading': 'Stop loading a tab.',
  'tab.wait_for_load': 'Wait until a tab has finished loading.',
  'tab.set_device_mode': 'Emulate a device profile in a tab.',
  'page.wait_for': 'Wait until the page stops changing.',
  'page.visual.snapshot': 'Screenshot the page and return element refs for it.',
  'page.visual.crop': 'Screenshot a region of the page.',
  'page.visual.click': 'Click at viewport coordinates.',
  'page.visual.click_if_interactive': 'Click at coordinates only when an interactive element is there.',
  'page.visual.hover': 'Hover at viewport coordinates.',
  'page.visual.scroll': 'Scroll the page.',
  'page.visual.drag': 'Drag from one point to another.',
  'page.visual.type_text': 'Type into the focused element.',
  'page.visual.press_key': 'Send a key to the focused element.',
  'page.text.snapshot': 'Read the page text.',
  'page.elements.snapshot': 'List the interactive elements with stable refs.',
  'page.element.click': 'Click an element by snapshot ref.',
  'page.element.hover': 'Hover an element by snapshot ref.',
  'page.element.fill': 'Set the value of an element by snapshot ref.',
  'page.element.type_text': 'Type into an element by snapshot ref.',
  'page.element.press_key': 'Send a key to an element by snapshot ref.',
  'page.element.select_option': 'Choose an option in a select by snapshot ref.',
  'page.element.set_checked': 'Set a checkbox or radio by snapshot ref.',
  'page.element.scroll_into_view': 'Scroll an element into view by snapshot ref.',
};

export function toolDescription(): string {
  return [
    `Control the Kimi Code built-in browser (protocol ${BROWSER_PROTOCOL}).`,
    '',
    'Operations:',
    ...BROWSER_OPERATIONS.map((op) => `  - ${op}: ${OPERATION_SUMMARY[op] ?? ''}`.trimEnd()),
    '',
    'Element operations need a `snapshotId` and `ref` from `page.elements.snapshot`;',
    'they expire when the page changes, so take a fresh snapshot and retry.',
  ].join('\n');
}

export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    protocol: { type: 'string', enum: [BROWSER_PROTOCOL], description: 'Protocol version.' },
    operation: { type: 'string', enum: [...BROWSER_OPERATIONS], description: 'Operation to run.' },
    tabId: { type: 'string', description: 'Target tab.' },
    snapshotId: { type: 'string', description: 'Snapshot from page.elements.snapshot.' },
    ref: { type: 'string', description: 'Element ref from that snapshot.' },
    url: { type: 'string', description: 'URL for navigation.' },
    query: { type: 'string', description: 'Search query.' },
    x: { type: 'number', description: 'Viewport x coordinate.' },
    y: { type: 'number', description: 'Viewport y coordinate.' },
    text: { type: 'string', description: 'Text to type or fill.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Keys to press.' },
    cursor: { type: 'string', description: 'Continuation cursor for page.text.snapshot.' },
    timeoutMs: { type: 'number', description: 'Timeout for waiting operations.' },
    stableForMs: { type: 'number', description: 'How long the page must stay quiet.' },
    maxChars: { type: 'number', description: 'Maximum characters to return.' },
    limit: { type: 'number', description: 'Maximum elements to return.' },
  },
  required: ['protocol', 'operation'],
  additionalProperties: true,
} as const;

/**
 * Wrap a browser answer as an MCP tool result.
 *
 * The text is the `kimi.browser/1.0.0` envelope the web bundle parses; the
 * structured copy is there for clients that read `structuredContent`.
 */
function toolResult(value: unknown): {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function handleToolCall(params: Record<string, unknown> | undefined, run: BrowserRequestHandler): Promise<unknown> {
  const inner = (params?.['arguments'] ?? {}) as Record<string, unknown>;
  const operation = inner['operation'];
  const protocol = inner['protocol'];
  if (protocol !== BROWSER_PROTOCOL) {
    return toolResult(browserError('INVALID_REQUEST', `protocol must be ${BROWSER_PROTOCOL}`));
  }
  if (typeof operation !== 'string' || !(BROWSER_OPERATIONS as readonly string[]).includes(operation)) {
    return toolResult(browserError('INVALID_REQUEST', `Unknown operation: ${String(operation)}`));
  }
  const response = await run({
    ...inner,
    protocol: BROWSER_PROTOCOL,
    operation: operation as BrowserRequest['operation'],
  });
  return toolResult(response);
}

/** Runs one browser operation; implemented by the Electron main process. */
export interface BrowserRequestHandler {
  (request: BrowserRequest): Promise<unknown>;
}

export interface McpServerOptions {
  /** Runs a browser operation. */
  readonly run: BrowserRequestHandler;
  /** Where to write diagnostics; stdout is the MCP channel and must stay clean. */
  readonly log?: (message: string) => void;
}

/**
 * Answer one JSON-RPC request, or `undefined` when it is a notification and
 * has no reply. Shared by the stdio and HTTP servers so both surfaces can never
 * disagree about what the tool is called or does.
 */
export async function dispatch(
  request: JsonRpcRequest,
  options: McpServerOptions,
): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;
  const ok = (value: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result: value });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  try {
    switch (request.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: [
            {
              name: MCP_TOOL_NAME,
              description: toolDescription(),
              inputSchema: TOOL_INPUT_SCHEMA,
            },
          ],
        });
      case 'tools/call':
        return ok(await handleToolCall(request.params, options.run));
      default:
        return fail(JSON_RPC_ERROR.methodNotFound, `Unknown method: ${request.method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.log ?? ((text: string): void => void process.stderr.write(`${text}\n`)))(
      `[desktop-browser] ${request.method} failed: ${message}`,
    );
    return fail(JSON_RPC_ERROR.internal, message);
  }
}
