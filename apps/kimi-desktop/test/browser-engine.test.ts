import { describe, expect, it } from 'vitest';

import { BrowserEngine, type BrowserHost, type BrowserSurface } from '../src/main/browser-engine';
import { BROWSER_PROTOCOL, type BrowserRequest } from '../src/main/browser-protocol';

/** A surface that records what it was asked to do. */
class FakeSurface implements BrowserSurface {
  readonly calls: string[] = [];
  private state = { url: 'https://example.com/', title: 'Example', loading: false, back: true, forward: false };
  constructor(readonly id: string, private readonly evaluateImpl: (script: string) => unknown = () => ({})) {}

  url(): string {
    return this.loaded.length > 0 ? this.loaded : this.state.url;
  }
  title(): string {
    return this.state.title;
  }
  loading(): boolean {
    return this.state.loading;
  }
  canGoBack(): boolean {
    return this.state.back;
  }
  canGoForward(): boolean {
    return this.state.forward;
  }
  loaded = '';
  async loadURL(url: string): Promise<void> {
    this.calls.push(`loadURL:${url}`);
    this.loaded = url;
    this.state = { ...this.state, url };
  }
  goBack(): void {
    this.calls.push('goBack');
  }
  goForward(): void {
    this.calls.push('goForward');
  }
  reload(): void {
    this.calls.push('reload');
  }
  stop(): void {
    this.calls.push('stop');
  }
  async evaluate<T>(script: string): Promise<T> {
    this.calls.push('evaluate');
    return this.evaluateImpl(script) as T;
  }
  async capture(): Promise<string> {
    this.calls.push('capture');
    return 'data:image/png;base64,AAAA';
  }
  /** Records the applied profile so a no-op implementation cannot pass. */
  appliedDevice: unknown = undefined;
  async setDevice(profile: unknown): Promise<void> {
    this.calls.push(`setDevice:${profile === null ? 'none' : 'profile'}`);
    this.appliedDevice = profile;
  }
  setBounds(): void {}
  focus(): void {}
}

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://example.com/',
    title: 'Example',
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    readyState: 'complete',
    text: 'hello world',
    elements: [
      {
        ref: 'e1',
        role: 'button',
        name: 'Go',
        tagName: 'button',
        clickable: true,
        disabled: false,
        bounds: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    ...overrides,
  };
}

function makeEngine(
  surface: BrowserSurface,
  options: { canCreate?: boolean } = {},
): {
  engine: BrowserEngine;
  host: BrowserHost;
  shown: string[];
  closed: string[];
  live: BrowserSurface[];
} {
  const shown: string[] = [];
  const closed: string[] = [];
  const live: BrowserSurface[] = [surface];
  const host: BrowserHost = {
    surfaces: () => live,
    showPanel: (tabId) => shown.push(tabId),
    createTab: (url) => {
      if (options.canCreate === false) return Promise.reject(new Error('too many tabs'));
      const created = new FakeSurface('t2');
      created.loaded = url;
      live.push(created);
      return Promise.resolve(created);
    },
    closeTab: (tabId) => {
      closed.push(tabId);
      const index = live.findIndex((s) => s.id === tabId);
      if (index >= 0) live.splice(index, 1);
    },
    deviceProfiles: () => [
      { profileId: 'desktop-1280', label: 'Desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
    ],
    history: () => [],
    downloads: () => [],
    notify: () => undefined,
  };
  return { engine: new BrowserEngine(host), host, shown, closed, live };
}

function request(partial: Partial<BrowserRequest> & { operation: BrowserRequest['operation'] }): BrowserRequest {
  return { protocol: BROWSER_PROTOCOL, tabId: 't1', ...partial };
}

describe('BrowserEngine', () => {
  it('rejects another protocol version', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run({ protocol: 'kimi.browser/0.9.0', operation: 'browser.get_state' } as never);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an unknown operation', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run({ protocol: BROWSER_PROTOCOL, operation: 'page.visual.explode' } as never);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('INVALID_REQUEST');
  });

  it('answers an unknown tab with TAB_NOT_FOUND', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'tab.get_state', tabId: 'other' }));
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('TAB_NOT_FOUND');
  });

  it('reports tab state from the surface', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'tab.get_state' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['tab']).toMatchObject({ tabId: 't1', url: 'https://example.com/', canGoBack: true });
  });

  it('hands the panel the tab when asked to activate it', async () => {
    const { engine, shown } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.activate_panel' }));
    expect(response.ok).toBe(true);
    expect(shown).toStrictEqual(['t1']);
  });

  it('returns element refs bound to a snapshot id', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.elements.snapshot' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    const elements = response['elements'] as { snapshotId: string; elements: { ref: string }[] };
    expect(elements.snapshotId).toMatch(/^s/);
    expect(elements.elements[0]?.ref).toBe('e1');
  });

  it('uses a fresh snapshot for element actions and refuses an expired one', async () => {
    const surface = new FakeSurface('t1', (script) => (script.includes('const el =') ? true : page()));
    const { engine } = makeEngine(surface);
    const snapshot = await engine.run(request({ operation: 'page.elements.snapshot' }));
    if (!snapshot.ok) throw new Error('expected success');
    const snapshotId = (snapshot['elements'] as { snapshotId: string }).snapshotId;

    const clicked = await engine.run(
      request({ operation: 'page.element.click', snapshotId, ref: 'e1' }),
    );
    expect(clicked.ok).toBe(true);

    const stale = await engine.run(
      request({ operation: 'page.element.click', snapshotId: 'gone', ref: 'e1' }),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('expected a failure');
    expect(stale.error.code).toBe('SNAPSHOT_EXPIRED');
  });

  it('reports a missing element ref', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const snapshot = await engine.run(request({ operation: 'page.elements.snapshot' }));
    if (!snapshot.ok) throw new Error('expected success');
    const snapshotId = (snapshot['elements'] as { snapshotId: string }).snapshotId;
    const response = await engine.run(
      request({ operation: 'page.element.click', snapshotId, ref: 'nope' }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('ELEMENT_NOT_FOUND');
  });

  it('performs a drag instead of only reporting its endpoints', async () => {
    // A drag that returns {from, to} without touching the page tells the agent
    // something happened when nothing moved.
    const scripts: string[] = [];
    const surface = new FakeSurface('t1', (script) => {
      scripts.push(script);
      return true;
    });
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.visual.drag', from: { x: 1, y: 2 }, to: { x: 30, y: 40 } }));
    expect(response.ok).toBe(true);
    const script = scripts.join('\n');
    expect(script).toContain('mousedown');
    expect(script).toContain('mousemove');
    expect(script).toContain('mouseup');
    expect(script).toContain('"x":1');
    expect(script).toContain('"x":30');
  });

  it('rejects a drag without two usable points', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    for (const partial of [{}, { from: { x: 1, y: 2 } }, { from: { x: 'a' }, to: { x: 1, y: 1 } }]) {
      const response = await engine.run(request({ operation: 'page.visual.drag', ...partial } as never));
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error('expected a failure');
      expect(response.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('refuses a click outside the viewport', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.visual.click', x: 99999, y: 5 }));
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('COORDINATE_OUT_OF_BOUNDS');
  });

  it('reports no target when a coordinate click hits nothing interactive', async () => {
    const surface = new FakeSurface('t1', () => page({ elements: [] }));
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.visual.click_if_interactive', x: 5, y: 5 }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['outcome']).toBe('no_target');
  });

  it('screenshots and returns a visual block plus an element snapshot id', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.visual.snapshot' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['screenshot']).toMatch(/^data:image\/png/);
    expect(response['visual']).toMatchObject({ width: 1280, height: 800 });
  });

  it('pages the page text with a cursor', async () => {
    const surface = new FakeSurface('t1', () => page({ text: 'abcdef' }));
    const { engine } = makeEngine(surface);
    const response = await engine.run(request({ operation: 'page.text.snapshot', maxChars: 3 }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['text']).toBe('abc');
    expect(response['truncated']).toBe(true);
    expect(response['nextCursor']).toBe('3');
  });

  it('refuses a navigation with no url', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'tab.navigate' }));
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('INVALID_REQUEST');
  });

  it('turns a bare host into https and a search phrase into a query', async () => {
    const surface = new FakeSurface('t1');
    const { engine } = makeEngine(surface);
    await engine.run(request({ operation: 'tab.navigate', url: 'example.com/docs' }));
    await engine.run(request({ operation: 'tab.search', query: 'kimi code' }));
    expect(surface.calls[0]).toBe('loadURL:https://example.com/docs');
    expect(surface.calls[1]).toContain('https://www.google.com/search?q=kimi%20code');
  });

  it('stops driving the page once the user takes over', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    engine.markUserTakeover();
    const response = await engine.run(request({ operation: 'page.element.click', snapshotId: 's1', ref: 'e1' }));
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('BROWSER_USER_TAKEOVER');
  });

  it('actually opens a tab for browser.create_tab', async () => {
    // This used to route through navigate(), which requires an existing tab,
    // so the agent's first move always failed with TAB_NOT_FOUND.
    const { engine, shown, live } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.create_tab', url: 'https://example.com' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(live).toHaveLength(2);
    expect(response['tab']).toMatchObject({ tabId: 't2', url: 'https://example.com' });
    // The panel is shown on the tab that was just created.
    expect(shown).toStrictEqual(['t2']);
  });

  it('opens a blank tab when create_tab is called without a url', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.create_tab' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['tab']).toMatchObject({ url: 'about:blank' });
  });

  it('reports a failure when a tab cannot be opened', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'), { canCreate: false });
    const response = await engine.run(request({ operation: 'browser.create_tab', url: 'https://example.com' }));
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('INVALID_REQUEST');
  });

  it('tears the tab down on browser.close_tab', async () => {
    // Closing used to only forget the id, leaving the page running.
    const { engine, closed, live } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.close_tab', tabId: 't1' }));
    expect(response.ok).toBe(true);
    expect(closed).toStrictEqual(['t1']);
    expect(live).toHaveLength(0);
  });

  it('keeps the tab open on browser.release_tab', async () => {
    const { engine, closed, live } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.release_tab', tabId: 't1' }));
    expect(response.ok).toBe(true);
    expect(closed).toStrictEqual([]);
    expect(live).toHaveLength(1);
  });

  it('forgets the snapshots of a closed tab, so its refs cannot be reused', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const snapshot = await engine.run(request({ operation: 'page.elements.snapshot' }));
    if (!snapshot.ok) throw new Error('expected success');
    const snapshotId = (snapshot['elements'] as { snapshotId: string }).snapshotId;
    await engine.run(request({ operation: 'browser.close_tab', tabId: 't1' }));
    // The tab is gone, so that is the first thing reported; either way the old
    // ref must not resolve to a live element.
    const response = await engine.run(
      request({ operation: 'page.element.click', snapshotId, ref: 'e1', tabId: 't1' }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(['TAB_NOT_FOUND', 'SNAPSHOT_EXPIRED']).toContain(response.error.code);
  });

  it('expires a snapshot taken in a tab that is still open', async () => {
    const surface = new FakeSurface('t1', () => page());
    const { engine } = makeEngine(surface);
    const response = await engine.run(
      request({ operation: 'page.element.click', snapshotId: 'never-issued', ref: 'e1' }),
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected a failure');
    expect(response.error.code).toBe('SNAPSHOT_EXPIRED');
  });

  it('lists the device profiles the panel offers', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.get_device_profiles' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['deviceProfiles']).toHaveLength(1);
  });
});
