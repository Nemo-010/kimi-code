// Serve `desktop_browser` over Streamable HTTP, from the Electron main process.
//
// The stdio entry needs a Node interpreter to run, and the AppImage does not
// ship one: its only executable is Electron, whose path lives inside the
// AppImage mount and disappears when the app exits. `kimi` also supports
// `transport: "http"` for MCP servers (`StreamableHTTPClientTransport`), so the
// desktop serves the protocol itself instead. Nothing has to be spawned, and
// the endpoint is on loopback with a token only this app knows.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MCP_SERVER_NAME, dispatch, type BrowserRequestHandler, type JsonRpcRequest } from './browser-mcp';

/** Request bodies are MCP tool calls; anything larger is not one. */
const MAX_BODY_BYTES = 8 << 20;

const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
const SESSION_HEADER = 'mcp-session-id';

export interface BrowserHttpServer {
  readonly url: string;
  readonly token: string;
  close(): void;
}

function tokenPath(kimiHome: string): string {
  return join(kimiHome, 'server', 'browser-mcp.token');
}

/**
 * Read the token that lets `kimi` call this server, creating one if needed.
 *
 * The file is the handshake: the desktop writes it, the MCP config entry names
 * it through a header, and nothing else on the machine can guess it. It is
 * recreated when missing or empty rather than left absent, because an absent
 * token would mean an unauthenticated browser tool.
 */
export function ensureBrowserToken(kimiHome: string): string {
  const path = tokenPath(kimiHome);
  try {
    const existing = readFileSync(path, 'utf-8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run, or the user cleared it.
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return token;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export interface StartBrowserHttpOptions {
  /** `<KIMI_CODE_HOME>`, where the token file lives. */
  readonly kimiHome: string;
  /** Runs a browser operation; owned by the Electron main process. */
  readonly run: BrowserRequestHandler;
  readonly log?: (message: string) => void;
}

/**
 * Start the MCP endpoint on loopback and return where it can be reached.
 *
 * Binding to 127.0.0.1 rather than all interfaces is deliberate: this server
 * drives a real browser and must not be reachable from the network.
 */
export interface McpHttpRequest {
  readonly method: string;
  readonly path: string;
  /** Raw `Authorization` header, if any. */
  readonly authorization: string | undefined;
  /** Request body. */
  readonly body: string;
}

export interface McpHttpReply {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** Serialised body; empty means no body. */
  readonly body: string;
}

/**
 * Handle one MCP request. Pure and transport-free so the protocol surface can
 * be tested without binding a socket, which a restrictive sandbox may forbid.
 */
export async function handleMcpHttpRequest(
  request: McpHttpRequest,
  options: { token: string; run: BrowserRequestHandler; log?: (message: string) => void },
): Promise<McpHttpReply> {
  const json = (status: number, payload: unknown, headers: Record<string, string> = {}): McpHttpReply => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

  if (request.path !== '/mcp') return json(404, { error: 'not found' });
  if (request.method === 'GET' || request.method !== 'POST') {
    return json(405, { error: 'method not allowed' }, { allow: 'POST' });
  }
  if (!authorizedHeader(request.authorization, options.token)) {
    return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  }
  if (request.body.length > MAX_BODY_BYTES) {
    return json(413, { error: 'request too large' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const answers: unknown[] = [];
  for (const entry of requests) {
    if (typeof entry !== 'object' || entry === null) continue;
    const answer = await dispatch(entry as JsonRpcRequest, { run: options.run, log: options.log });
    if (answer !== undefined) answers.push(answer);
  }
  // A notification-only batch gets 202 with no body, as the spec requires.
  if (answers.length === 0) return { status: 202, headers: {}, body: '' };
  return json(
    200,
    Array.isArray(parsed) ? answers : answers[0],
    {
      [PROTOCOL_VERSION_HEADER]: '2025-06-18',
      // The SDK expects a session id back; this server is stateless, but the
      // header keeps the client from treating the reply as malformed.
      [SESSION_HEADER]: 'kimi-desktop-browser',
    },
  );
}

/** Check a raw `Authorization` header value against the token. */
export function authorizedHeader(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return constantTimeEquals(header.slice(prefix.length), token);
}

export function startBrowserHttp(options: StartBrowserHttpOptions): Promise<BrowserHttpServer> {
  const token = ensureBrowserToken(options.kimiHome);
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      void handle(request, response).catch((error: unknown) => {
        log(`[desktop-browser] request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) send(response, 500, { error: 'internal error' });
      });
    });

    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      let body = '';
      if (request.method === 'POST') {
        try {
          body = await readBody(request);
        } catch {
          send(response, 413, { error: 'request too large' });
          return;
        }
      }
      const reply = await handleMcpHttpRequest(
        {
          method: request.method ?? 'GET',
          path: (request.url ?? '').split('?')[0] ?? '',
          authorization: request.headers.authorization,
          body,
        },
        { token, run: options.run, log },
      );
      if (reply.body.length === 0) {
        response.writeHead(reply.status, reply.headers).end();
        return;
      }
      response.writeHead(reply.status, {
        ...reply.headers,
        'content-length': Buffer.byteLength(reply.body),
      });
      response.end(reply.body);
    };

    server.on('error', reject);
    // Port 0 lets the OS pick a free port; the port is then published in the
    // MCP config, so a busy port is not a startup failure.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('The browser MCP server did not bind a port.'));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/mcp`;
      log(`[desktop-browser] MCP endpoint on ${url}`);
      resolve({
        url,
        token,
        close: () => {
          server.close();
        },
      });
    });
  });
}

/** Remove the token file when the app goes away. */
export function removeBrowserToken(kimiHome: string): void {
  const path = tokenPath(kimiHome);
  try {
    if (existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
  } catch {
    // Best effort; a stale empty file is replaced on the next launch.
  }
}

export { MCP_SERVER_NAME };
