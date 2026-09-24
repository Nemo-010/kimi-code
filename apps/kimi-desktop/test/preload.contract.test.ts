import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The preload is the only place the renderer's expectations about
// `window.kimiDesktop` / `window.kimiBrowser` are met. Issue #1 shipped a
// desktop whose quick open list offered a Browser panel that could never open,
// so the contract is asserted here rather than discovered in a release.
//
// The assertions run against the source, not the build output: CI's test job
// does not build the desktop package, and a test that reads `out/` would fail
// there for a missing file rather than a real regression. When the bundle does
// exist (locally, or after a packaging build) the emitted file is checked too,
// because that is what actually ships.
const source = readFileSync(join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8');
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
const bundlePath = join(__dirname, '..', 'out', 'preload', 'index.cjs');

describe('desktop preload', () => {
  it('exposes both bridge objects the web UI probes for', () => {
    expect(source).toContain("exposeInMainWorld('kimiDesktop'");
    expect(source).toContain("exposeInMainWorld('kimiBrowser'");
  });

  it('carries the browser surface the Browser panel needs', () => {
    // `webview` is the only surface whose bounds can be masked, moved and
    // scrolled by the page; BrowserView cannot be.
    expect(source).toContain("createElement('webview')");
    for (const method of ['setBounds', 'navigate', 'destroy', 'onEvent']) {
      expect(source).toContain(method);
    }
  });

  it('validates ids and urls before touching the surface', () => {
    expect(source).toContain('ID_PATTERN');
    expect(source).toContain('MAX_URL_LENGTH');
    expect(source).toContain('asBounds');
  });

  it('reports the theme through the main process instead of an injected console tag', () => {
    expect(source).toContain('kimi-browser:theme');
  });

  it('provides getPathForFile, which the composer gates drag and drop on', () => {
    // The bundle checks `typeof bridge.getPathForFile == "function"` before it
    // will resolve a dropped file to a path, so its absence removed the feature
    // without any error being raised.
    expect(source).toContain('getPathForFile');
    expect(source).toContain('webUtils.getPathForFile');
    expect(source).toContain('webUtils');
  });

  it('provides setOnboarded, which the web UI calls when onboarding ends', () => {
    expect(source).toContain('setOnboarded');
    expect(source).toContain("send('kimi-desktop:onboarded'");
    expect(MAIN).toContain("ipcMain.on('kimi-desktop:onboarded'");
  });

  it('carries the terminal panel and the daemon protocol it speaks', () => {
    // The shipped web bundle has no terminal, so the shell provides one; these
    // are the parts that must survive minification.
    expect(source).toContain('TerminalPanel');
    const panel = readFileSync(join(__dirname, '..', 'src', 'renderer', 'terminal-panel.ts'), 'utf8');
    for (const message of [
      'terminal_attach',
      'terminal_input',
      'terminal_resize',
      'terminal_output',
      'terminal_detach',
    ]) {
      expect(panel).toContain(message);
    }
    // The daemon reads its bearer token from the WebSocket subprotocol.
    expect(panel).toContain('kimi-code.bearer.');
  });
});

describe('desktop preload bundle', () => {
  // Skipped rather than failed when the build output is absent, so the test is
  // meaningful in CI and in a fresh checkout.
  it.skipIf(!existsSync(bundlePath))('emits the bridges and both panels', () => {
    const bundle = readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('exposeInMainWorld("kimiDesktop"');
    expect(bundle).toContain('exposeInMainWorld("kimiBrowser"');
    expect(bundle).toContain('createElement("webview")');
    expect(bundle).toContain('kimi-terminal-panel');
    expect(bundle).toContain('terminal_attach');
  });
});
