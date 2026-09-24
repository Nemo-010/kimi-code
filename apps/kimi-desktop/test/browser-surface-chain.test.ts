/**
 * The chain from an engine operation to the `<webview>`.
 *
 * The engine is in the main process and the element is in the renderer, so
 * every read, write and screenshot crosses that boundary. It is the easiest
 * place for the panel to look like it works while answering nothing, so the
 * envelope shape is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { RemoteBrowserSurface } from '../src/main/browser-surface';
import type { DeviceProfile } from '../src/main/browser-engine';

/** A transport that records the envelope it was handed. */
function recordingTransport(answer: unknown = 'x'): {
  sent: { tabId: string; request: Record<string, unknown> }[];
  request: (tabId: string, request: Record<string, unknown>) => Promise<unknown>;
} {
  const sent: { tabId: string; request: Record<string, unknown> }[] = [];
  return {
    sent,
    request: async (tabId, request) => {
      sent.push({ tabId, request });
      return answer;
    },
  };
}

const PROFILE: DeviceProfile = {
  profileId: 'iphone-16-pro',
  label: 'iPhone 16 Pro',
  width: 402,
  height: 874,
  deviceScaleFactor: 3,
  mobile: true,
  touch: true,
};

describe('engine operation -> renderer surface', () => {
  it('carries the tab id in the envelope, not inside the operation', () => {
    // The renderer resolves the surface from the envelope's `tabId`. When the
    // operation object was searched for it instead, every call answered
    // TAB_NOT_FOUND and screenshots, text and element reads were all dead.
    const transport = recordingTransport('data:image/png;base64,AA');
    const surface = new RemoteBrowserSurface('t7', transport, () => undefined);
    void surface.setBounds({ x: 1, y: 2, width: 3, height: 4 });
    expect(transport.sent[0]?.tabId).toBe('t7');
    expect(transport.sent[0]?.request).toStrictEqual({
      operation: 'setBounds',
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it('does not put the tab id inside the operation payload', () => {
    const transport = recordingTransport();
    const surface = new RemoteBrowserSurface('t7', transport, () => undefined);
    void surface.capture();
    expect(Object.hasOwn(transport.sent[0]?.request ?? {}, 'tabId')).toBe(false);
  });

  it('returns the screenshot the renderer produced', async () => {
    const transport = recordingTransport('data:image/png;base64,ZZZ');
    const surface = new RemoteBrowserSurface('t1', transport, () => undefined);
    await expect(surface.capture()).resolves.toBe('data:image/png;base64,ZZZ');
  });

  it('returns the evaluated value rather than the envelope', async () => {
    const transport = recordingTransport({ title: 'Example' });
    const surface = new RemoteBrowserSurface('t1', transport, () => undefined);
    await expect(surface.evaluate('document.title')).resolves.toStrictEqual({ title: 'Example' });
  });

  it('sends the device profile to the renderer and remembers it', async () => {
    const transport = recordingTransport({ ok: true });
    const surface = new RemoteBrowserSurface('t1', transport, () => undefined);
    await surface.setDevice(PROFILE);
    expect(transport.sent[0]?.request).toStrictEqual({ operation: 'setDevice', profile: PROFILE });
    expect(surface.deviceProfile()).toStrictEqual(PROFILE);
  });

  it('clears emulation when asked for no profile', async () => {
    const transport = recordingTransport({ ok: true });
    const surface = new RemoteBrowserSurface('t1', transport, () => undefined);
    await surface.setDevice(PROFILE);
    await surface.setDevice(null);
    expect(transport.sent[1]?.request).toStrictEqual({ operation: 'setDevice', profile: null });
    expect(surface.deviceProfile()).toBeNull();
  });

  it('rejects when the renderer never answers', async () => {
    // The window can be closed mid-operation; the engine must not hang forever.
    const surface = new RemoteBrowserSurface('t1', { request: () => new Promise(() => undefined) }, () => undefined);
    await expect(
      Promise.race([
        surface.capture(),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('timed out')), 40_000)),
      ]),
    ).rejects.toThrow();
  }, 45_000);

  it('reports bounds back to its caller', () => {
    const seen: unknown[] = [];
    const surface = new RemoteBrowserSurface('t1', recordingTransport(), (bounds) => seen.push(bounds));
    surface.setBounds({ x: 4, y: 5, width: 6, height: 7 });
    expect(seen).toStrictEqual([{ x: 4, y: 5, width: 6, height: 7 }]);
  });
});
