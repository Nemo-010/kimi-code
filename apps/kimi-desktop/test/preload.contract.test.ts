import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The preload is the only place the renderer's expectations about
// `window.kimiDesktop` / `window.kimiBrowser` are met. Issue #1 shipped a
// desktop whose quick open list offered a Browser panel that could never open,
// so the contract is asserted here rather than discovered in a release.
const bundle = readFileSync(join(__dirname, '..', 'out', 'preload', 'index.cjs'), 'utf8');

describe('desktop preload bundle', () => {
  it('exposes both bridge objects the web UI probes for', () => {
    expect(bundle).toContain('exposeInMainWorld("kimiDesktop"');
    expect(bundle).toContain('exposeInMainWorld("kimiBrowser"');
  });

  it('carries the browser surface the Browser panel needs', () => {
    // `webview` is the only surface whose bounds can be masked, moved and
    // scrolled by the page; BrowserView cannot be.
    expect(bundle).toContain('createElement("webview")');
    for (const method of ['setBounds', 'navigate', 'destroy', 'onEvent']) {
      expect(bundle).toContain(method);
    }
  });

  it('validates ids and urls before touching the surface', () => {
    expect(bundle).toContain('ID_PATTERN');
    expect(bundle).toContain('MAX_URL_LENGTH');
    expect(bundle).toContain('asBounds');
  });

  it('reports the theme through the main process instead of an injected console tag', () => {
    expect(bundle).toContain('kimi-browser:theme');
  });
});
