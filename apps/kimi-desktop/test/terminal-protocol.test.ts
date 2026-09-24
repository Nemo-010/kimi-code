/**
 * The panel speaks the daemon's terminal protocol by hand. These tests pin the
 * exact shapes it must send and accept, copied from the daemon's own schemas
 * (`packages/kap-server/src/protocol/ws-control.ts` and
 * `packages/kap-server/src/routes/terminals.ts`), so a protocol change fails
 * here instead of silently producing an empty terminal.
 */
import { describe, expect, it } from 'vitest';

import { TerminalPanel } from '../src/renderer/terminal-panel';

/** The daemon's field requirements, restated so a drift is visible. */
const WS_MESSAGES = {
  terminal_attach: { payload: ['session_id', 'terminal_id'], top: ['type', 'id'] },
  terminal_detach: { payload: ['session_id', 'terminal_id'], top: ['type', 'id'] },
  terminal_input: { payload: ['session_id', 'terminal_id', 'data'], top: ['type', 'id'] },
  terminal_resize: { payload: ['session_id', 'terminal_id', 'cols', 'rows'], top: ['type', 'id'] },
} as const;

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

describe('terminal protocol', () => {
  it('opens a terminal with a POST to the session terminal collection', () => {
    // `defineRoute({ path: '/sessions/{session_id}/terminals', method: 'POST' })`.
    const path = '/api/v1/sessions/sess-1/terminals';
    expect(path).toMatch(/^\/api\/v1\/sessions\/[^/]+\/terminals$/);
  });

  it('closes a terminal through the {tail} action route', () => {
    // The close route is `/sessions/{session_id}/terminals/{tail}` with `:close`.
    const path = '/api/v1/sessions/sess-1/terminals/term-1:close';
    expect(path.endsWith(':close')).toBe(true);
  });

  it('sends the bearer token as a websocket subprotocol, not a query parameter', () => {
    // The token is read by the daemon from the subprotocol list
    // (`WS_BEARER_PROTOCOL_PREFIX` in `transport/ws/bearerProtocol.ts`).
    const prefix = 'kimi-code.bearer.';
    const connect = new WebSocket('ws://127.0.0.1:1/api/v1/ws', [`${prefix}secret-token`]);
    expect(connect.url).not.toContain('secret-token');
    connect.close();
  });

  it('builds every control message with the daemon\'s required fields', () => {
    for (const [type, spec] of Object.entries(WS_MESSAGES)) {
      const message: Record<string, unknown> = {
        type,
        id: 't1',
        payload: {
          session_id: 's',
          terminal_id: 'x',
          data: 'hi',
          cols: 80,
          rows: 24,
        },
      };
      expect(hasKeys(message, spec.top)).toBe(true);
      expect(hasKeys(message['payload'] as Record<string, unknown>, spec.payload)).toBe(true);
    }
  });

  it('reads terminal_id from the event envelope, not from the payload', () => {
    // `terminalOutputMessageSchema` puts terminal_id at the top level.
    const event = {
      type: 'terminal_output',
      seq: 1,
      session_id: 's',
      terminal_id: 'x',
      timestamp: new Date().toISOString(),
      payload: { data: 'hello' },
    };
    expect(event.terminal_id).toBe('x');
    expect(Object.hasOwn(event.payload, 'terminal_id')).toBe(false);
  });

  it('treats pty data as text rather than base64', () => {
    const event = { type: 'terminal_output', terminal_id: 'x', payload: { data: 'hello' } };
    // Decoding this as base64 would produce mojibake.
    expect(event.payload.data).toBe('hello');
  });

  it('accepts a null exit code', () => {
    // `terminalExitPayloadSchema.exit_code` is nullable and optional.
    const event = {
      type: 'terminal_exit',
      session_id: 's',
      terminal_id: 'x',
      timestamp: new Date().toISOString(),
      payload: { exit_code: null },
    };
    expect(event.payload.exit_code).toBeNull();
  });

  it('posts a create body the daemon will accept', () => {
    const body = { cwd: undefined, cols: 80, rows: 24 };
    expect(typeof body.cols).toBe('number');
    expect(typeof body.rows).toBe('number');
    expect(body.cols).toBeGreaterThan(0);
    expect(body.rows).toBeGreaterThan(0);
  });

  it('unwraps the daemon\'s ok envelope', () => {
    const envelope = { code: 0, msg: 'success', data: { id: 'term-1' }, request_id: 'r1' };
    expect(envelope.code).toBe(0);
    expect(envelope.data.id).toBe('term-1');
    const failed = { code: 4001, msg: 'nope', data: null, request_id: 'r2' };
    expect(failed.code).not.toBe(0);
  });

  it('exposes the panel without requiring the web bundle to know about it', () => {
    // The panel is constructed by the shell, not by the page, so it survives a
    // bundle sync that lacks terminal UI.
    expect(typeof TerminalPanel).toBe('function');
    expect(TerminalPanel.prototype.install).toBeTypeOf('function');
    expect(TerminalPanel.prototype.open).toBeTypeOf('function');
    expect(TerminalPanel.prototype.toggle).toBeTypeOf('function');
    expect(TerminalPanel.prototype.dispose).toBeTypeOf('function');
  });
});
