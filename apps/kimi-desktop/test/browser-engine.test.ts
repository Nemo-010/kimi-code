import { describe, expect, it } from 'vitest';

import { BrowserEngine, type BrowserHost, type BrowserSurface } from '../src/main/browser-engine';
import { BROWSER_PROTOCOL, type BrowserRequest } from '../src/main/browser-protocol';

/** A surface that records what it was asked to do. */
class FakeSurface implements BrowserSurface {
  readonly calls: string[] = [];
  private state = { url: 'https://example.com/', title: 'Example', loading: false, back: true, forward: false };
  constructor(readonly id: string, private readonly evaluateImpl: (script: string) => unknown = () => ({})) {}

  url(): string {
    return this.state.url;
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
  async loadURL(url: string): Promise<void> {
    this.calls.push(`loadURL:${url}`);
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

function makeEngine(surface: BrowserSurface): { engine: BrowserEngine; host: BrowserHost; shown: string[] } {
  const shown: string[] = [];
  const host: BrowserHost = {
    surfaces: () => [surface],
    showPanel: (tabId) => shown.push(tabId),
    deviceProfiles: () => [
      { profileId: 'desktop-1280', label: 'Desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
    ],
    history: () => [],
    downloads: () => [],
    notify: () => undefined,
  };
  return { engine: new BrowserEngine(host), host, shown };
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

  it('lists the device profiles the panel offers', async () => {
    const { engine } = makeEngine(new FakeSurface('t1'));
    const response = await engine.run(request({ operation: 'browser.get_device_profiles' }));
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected success');
    expect(response['deviceProfiles']).toHaveLength(1);
  });
});
