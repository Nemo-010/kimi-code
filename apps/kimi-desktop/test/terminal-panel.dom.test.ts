// @vitest-environment jsdom
/**
 * The panel is the part the user actually sees. These tests drive it in a DOM
 * and assert on the rendered rows, so a panel that mounts but paints nothing
 * fails here rather than being described as working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPanel } from '../src/renderer/terminal-panel';

/** A fake WebSocket that records what the panel sends and can push frames. */
class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /** Push a daemon frame to the panel. */
  push(frame: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  /** The control messages the panel sent. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** A document scope where `fetch` reports a session list and a terminal. */
function installFetch(): { requests: { method: string; url: string; body?: unknown }[] } {
  const requests: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        url,
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      });
      if (url.includes('/api/v1/sessions') && method === 'GET') {
        return new Response(JSON.stringify({ code: 0, msg: 'success', data: { items: [{ id: 'sess-1' }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/terminals') && method === 'POST') {
        return new Response(
          JSON.stringify({ code: 0, msg: 'success', data: { id: 'term-1', shell: '/bin/bash' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { requests };
}

/** The rendered text of the panel's viewport. */
function screenText(): string {
  const panel = document.querySelector('.kimi-terminal-panel');
  const viewport = panel?.lastElementChild;
  return viewport?.textContent?.replaceAll('\u00A0', ' ') ?? '';
}

describe('TerminalPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makePanel(): TerminalPanel {
    const panel = new TerminalPanel({ origin: 'http://127.0.0.1:9999', token: () => 'tok' });
    panel.install();
    return panel;
  }

  it('mounts into the document and starts hidden', () => {
    const panel = makePanel();
    expect(document.querySelector('.kimi-terminal-panel')).not.toBeNull();
    expect(panel.visible).toBe(false);
  });

  it('opens a terminal for the newest session and attaches to it', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    expect(panel.tabCount).toBe(1);
    expect(panel.visible).toBe(true);
    const socket = FakeSocket.instances[0];
    const attach = socket?.frames().find((f) => f['type'] === 'terminal_attach');
    expect(attach).toBeDefined();
    expect((attach?.['payload'] as Record<string, unknown>)['terminal_id']).toBe('term-1');
  });

  it('sends the daemon credential as a websocket subprotocol', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    const socket = FakeSocket.instances[0];
    expect(socket?.protocols).toStrictEqual(['kimi-code.bearer.tok']);
    expect(socket?.url).toBe('ws://127.0.0.1:9999/api/v1/ws');
  });

  it('paints output the daemon sends', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    FakeSocket.instances[0]?.push({
      type: 'terminal_output',
      seq: 1,
      session_id: 'sess-1',
      terminal_id: 'term-1',
      timestamp: new Date().toISOString(),
      payload: { data: 'hello world' },
    });
    expect(screenText()).toContain('hello world');
  });

  it('ignores output for a terminal it does not have', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    FakeSocket.instances[0]?.push({
      type: 'terminal_output',
      terminal_id: 'someone-else',
      payload: { data: 'should not appear' },
    });
    expect(screenText()).not.toContain('should not appear');
  });

  it('marks a tab as exited when the process ends', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    FakeSocket.instances[0]?.push({
      type: 'terminal_exit',
      session_id: 'sess-1',
      terminal_id: 'term-1',
      timestamp: new Date().toISOString(),
      payload: { exit_code: 0 },
    });
    expect(screenText()).toContain('process exited');
    expect(document.querySelector('.kimi-terminal-panel')?.textContent).toContain('exited');
  });

  it('forwards typed keys to the daemon', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    const viewport = document.querySelector('.kimi-terminal-panel')?.lastElementChild as HTMLElement;
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    const input = FakeSocket.instances[0]
      ?.frames()
      .find((f) => f['type'] === 'terminal_input');
    expect((input?.['payload'] as Record<string, unknown>)['data']).toBe('a');
  });

  it('encodes control characters for the pty', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    const viewport = document.querySelector('.kimi-terminal-panel')?.lastElementChild as HTMLElement;
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    const sent = FakeSocket.instances[0]
      ?.frames()
      .filter((f) => f['type'] === 'terminal_input')
      .map((f) => (f['payload'] as Record<string, unknown>)['data']);
    expect(sent).toStrictEqual(['\r', '\u0003']);
  });

  it('detaches and closes the tab through the daemon', async () => {
    const { requests } = installFetch();
    const panel = makePanel();
    await panel.open();
    await panel.closeTab('term-1');
    expect(panel.tabCount).toBe(0);
    const detach = FakeSocket.instances[0]?.frames().find((f) => f['type'] === 'terminal_detach');
    expect(detach).toBeDefined();
    expect(requests.some((r) => r.url.endsWith('/terminals/term-1:close'))).toBe(true);
  });

  it('toggles visibility without piling up terminals', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    expect(panel.toggle()).toBe(false);
    expect(panel.visible).toBe(false);
    expect(panel.toggle()).toBe(true);
    expect(panel.tabCount).toBe(1);
  });

  it('explains itself when there is no session to open a terminal in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 0, msg: 'success', data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const panel = makePanel();
    await panel.open();
    expect(panel.tabCount).toBe(0);
    expect(screenText()).toContain('session');
  });

  it('removes itself from the document when disposed', () => {
    const panel = makePanel();
    panel.dispose();
    expect(document.querySelector('.kimi-terminal-panel')).toBeNull();
  });

  it('unbinds its window listener so a disposed panel is not kept alive', () => {
    // Count the bindings directly: jsdom does not expose a reliable listener
    // count, and the resize handler is bound to `window`, so removing the
    // panel's element does not remove it.
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    const addSpy = vi.spyOn(window, 'addEventListener').mockImplementation((type, handler, options) => {
      if (type === 'resize') added.push(handler);
      realAdd(type, handler as EventListener, options);
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener').mockImplementation((type, handler, options) => {
      if (type === 'resize') removed.push(handler);
      realRemove(type, handler as EventListener, options);
    });
    try {
      const panel = makePanel();
      expect(added.length).toBeGreaterThan(0);
      panel.dispose();
      expect(removed).toStrictEqual(added);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('closes its terminals on the daemon when disposed', async () => {
    // A terminal is a process on the daemon: removing the panel must not leave
    // a shell running that nobody can reach.
    const { requests } = installFetch();
    const panel = makePanel();
    await panel.open();
    panel.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests.some((r) => r.url.endsWith('/terminals/term-1:close'))).toBe(true);
  });

  it('does not reopen the socket after disposal', async () => {
    installFetch();
    const panel = makePanel();
    await panel.open();
    const socket = FakeSocket.instances[0];
    panel.dispose();
    expect(socket?.readyState).not.toBe(FakeSocket.OPEN);
  });
});
