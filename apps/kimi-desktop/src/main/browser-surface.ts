// A `BrowserSurface` implemented by proxy to the renderer.
//
// The engine lives in the main process but the `<webview>` lives in the
// renderer, so every operation is a request over IPC that the preload's
// `window.kimiBrowserSurface.execute` answers. The proxy exists so the engine
// can be written against a plain interface and unit tested without Electron.
import type { BrowserSurface, DeviceProfile } from './browser-engine';

const REQUEST_TIMEOUT_MS = 30_000;

export interface RendererTransport {
  /** Send a request to the renderer and resolve its answer. */
  request(tabId: string, request: Record<string, unknown>): Promise<unknown>;
}

interface SurfaceState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export class RemoteBrowserSurface implements BrowserSurface {
  /** The device profile applied to this surface, if any. */
  private device: DeviceProfile | null = null;

  private state: SurfaceState = {
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };

  constructor(
    readonly id: string,
    private readonly transport: RendererTransport,
    private readonly onBounds: (bounds: { x: number; y: number; width: number; height: number }) => void,
  ) {}

  /** Called when the renderer reports a navigation or title change. */
  observe(update: Partial<SurfaceState>): void {
    this.state = { ...this.state, ...update };
  }

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
    return this.state.canGoBack;
  }

  canGoForward(): boolean {
    return this.state.canGoForward;
  }

  private async call<T>(request: Record<string, unknown>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return (await Promise.race([
        this.transport.request(this.id, request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('The window did not answer in time.'));
          }, REQUEST_TIMEOUT_MS);
        }),
      ])) as T;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async loadURL(url: string): Promise<void> {
    const result = await this.call<{ url?: string; title?: string }>({ operation: 'loadURL', url });
    if (result !== null && typeof result === 'object' && typeof result.url === 'string') {
      this.state = { ...this.state, url: result.url, title: result.title ?? '' };
    }
  }

  goBack(): void {
    void this.call({ operation: 'goBack' });
  }

  goForward(): void {
    void this.call({ operation: 'goForward' });
  }

  reload(): void {
    void this.call({ operation: 'reload' });
  }

  stop(): void {
    void this.call({ operation: 'stop' });
  }

  async evaluate<T>(script: string): Promise<T> {
    return this.call<T>({ operation: 'evaluate', script });
  }

  async capture(): Promise<string> {
    return this.call<string>({ operation: 'capture' });
  }

  async setDevice(profile: DeviceProfile | null): Promise<void> {
    await this.call({ operation: 'setDevice', profile });
    this.device = profile;
  }

  /** The profile currently applied, for `tab.get_state`. */
  deviceProfile(): DeviceProfile | null {
    return this.device;
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    void this.call({ operation: 'setBounds', bounds });
    this.onBounds(bounds);
  }

  focus(): void {
    void this.call({ operation: 'focus' });
  }
}
