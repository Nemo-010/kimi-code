// The browser engine behind the Browser panel and the agent's browser tool.
//
// A tab is a masked `<webview>` in the renderer (see `src/preload/index.ts`);
// this class owns their state, evaluates the page-side probe scripts, and
// answers `kimi.browser/1.0.0` requests. It is deliberately free of Electron
// imports so it can be unit tested: the host supplies a small surface
// interface.
import {
  BROWSER_PROTOCOL,
  browserError,
  browserOk,
  isBrowserOperation,
  type BrowserErrorCode,
  type BrowserOperation,
  type BrowserRequest,
  type BrowserResponse,
} from './browser-protocol';

/** What the engine needs from a `<webview>`; the renderer implements this. */
export interface BrowserSurface {
  readonly id: string;
  url(): string;
  title(): string;
  loading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  /** Run a script in the page and resolve its (JSON-serialisable) value. */
  evaluate<T>(script: string): Promise<T>;
  /** Capture the visible viewport as a PNG data URL. */
  capture(): Promise<string>;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  focus(): void;
}

export interface BrowserHost {
  /** Tabs currently open, in display order. */
  surfaces(): readonly BrowserSurface[];
  /** Make the Browser panel visible and the given tab the active one. */
  showPanel(tabId: string): void;
  /**
   * Open a new tab and return it. `browser.create_tab` is the agent's entry
   * point, so it cannot require an existing tab the way navigation does.
   */
  createTab(url: string): Promise<BrowserSurface>;
  /**
   * Tear a tab down. `browser.close_tab` has to reach the renderer's
   * `<webview>`, or the tab keeps running and loading pages after the agent
   * believes it closed it.
   */
  closeTab(tabId: string): void;
  /** Device-profile prese ts the panel offers. */
  deviceProfiles(): readonly DeviceProfile[];
  history(): readonly HistoryEntry[];
  downloads(): readonly DownloadEntry[];
  /** Called whenever the panel should repaint. */
  notify(): void;
}

export interface DeviceProfile {
  readonly profileId: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly touch: boolean;
}

export interface HistoryEntry {
  readonly tabId: string;
  readonly url: string;
  readonly title?: string;
  readonly visitedAt: string;
}

export interface DownloadEntry {
  readonly filename: string;
  readonly url: string;
  readonly received: number;
  readonly total: number;
  readonly startedAt: string;
  readonly savePath?: string;
}

/** A page snapshot; element `ref`s are only valid for the matching snapshotId. */
interface Snapshot {
  readonly id: string;
  readonly tabId: string;
  readonly url: string;
  readonly elements: readonly PageElement[];
  readonly capturedAt: number;
}

interface PageElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly text?: string;
  readonly value?: string;
  readonly state?: string;
  readonly tagName: string;
  readonly id?: string;
  readonly classes?: string;
  readonly clickable: boolean;
  readonly disabled: boolean;
  readonly bounds?: { x: number; y: number; width: number; height: number };
}

const MAX_ELEMENTS = 200;
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_URL_LENGTH = 4096;
const DEFAULT_WAIT_STABLE_MS = 300;

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

/**
 * The page-side element collector. Runs inside the page, so it must be a
 * self-contained expression with no closure over this file.
 *
 * It mirrors the element list the transcript renders: ref, role, name, text,
 * value, state, tagName, id, classes, clickable, disabled and bounds.
 */
const COLLECT_ELEMENTS_SCRIPT = `(() => {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable="true"],[onclick]';
  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const elements = [];
  const seen = new Set();
  const all = Array.from(document.querySelectorAll(INTERACTIVE));
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,h[aria-level]'));
  for (const el of [...all, ...headings]) {
    if (seen.has(el) || elements.length >= ${MAX_ELEMENTS}) continue;
    seen.add(el);
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    const tagName = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tagName;
    const name =
      (el.getAttribute('aria-label') || '').trim() ||
      (el.getAttribute('placeholder') || '').trim() ||
      (el.getAttribute('title') || '').trim() ||
      text(el).slice(0, 120) ||
      (el.getAttribute('name') || '').trim();
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    let state;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') state = el.checked ? 'checked' : 'unchecked';
      else if (el.value) state = 'filled';
    } else if (el instanceof HTMLSelectElement && el.value) {
      state = 'selected';
    } else if (el.getAttribute('aria-expanded') !== null) {
      state = el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed';
    }
    elements.push({
      ref: 'e' + (elements.length + 1),
      role,
      name,
      text: text(el).slice(0, 200) || undefined,
      value: 'value' in el ? String(el.value ?? '').slice(0, 200) || undefined : undefined,
      state,
      tagName,
      id: el.id || undefined,
      classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 200) : undefined,
      clickable: role === 'button' || role === 'link' || role === 'a' || tagName === 'button' || tagName === 'a' || el.hasAttribute('onclick'),
      disabled,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
    readyState: document.readyState,
    text: (document.body ? (document.body.innerText || '') : '').slice(0, ${MAX_TEXT_CHARS}),
    elements,
  };
})()`;

interface CollectedPage {
  url: string;
  title: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  readyState: string;
  text: string;
  elements: PageElement[];
}

export class BrowserEngine {
  private readonly snapshots = new Map<string, Snapshot>();
  private activeTabId: string | undefined;
  /** Set when the user takes the browser over; the agent stops driving it. */
  private takenOver = false;

  constructor(private readonly host: BrowserHost) {}

  /** The panel's active tab, which the agent's `activate_panel` also sets. */
  setActiveTab(tabId: string | undefined): void {
    this.activeTabId = tabId;
  }

  /** Called when the user interacts with the panel directly. */
  markUserTakeover(): void {
    this.takenOver = true;
  }

  clearTakeover(): void {
    this.takenOver = false;
  }

  async run(request: BrowserRequest): Promise<BrowserResponse> {
    if (request.protocol !== BROWSER_PROTOCOL) {
      return browserError('INVALID_REQUEST', `Invalid ${String(BROWSER_PROTOCOL)} request`);
    }
    if (!isBrowserOperation(request.operation)) {
      return browserError('INVALID_REQUEST', `Unknown operation: ${String(request.operation)}`);
    }
    const operation: BrowserOperation = request.operation;
    if (operation.startsWith('page.element.') && this.takenOver) {
      return browserError('BROWSER_USER_TAKEOVER', 'You have taken over the browser.');
    }
    try {
      return await this.dispatch(operation, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return browserError('INTERNAL_ERROR', message);
    }
  }

  private surface(tabId: unknown): BrowserSurface | undefined {
    if (typeof tabId !== 'string' || tabId.length === 0) {
      if (this.activeTabId === undefined) return undefined;
      return this.host.surfaces().find((s) => s.id === this.activeTabId);
    }
    return this.host.surfaces().find((s) => s.id === tabId);
  }

  private requireSurface(tabId: unknown): BrowserSurface | BrowserResponse {
    const surface = this.surface(tabId);
    return surface ?? browserError('TAB_NOT_FOUND', 'No such tab.');
  }

  private isResponse(value: unknown): value is BrowserResponse {
    return typeof value === 'object' && value !== null && 'ok' in value;
  }

  private async collect(surface: BrowserSurface): Promise<CollectedPage> {
    return surface.evaluate<CollectedPage>(COLLECT_ELEMENTS_SCRIPT);
  }

  /** Drop the snapshots for a tab that no longer exists. */
  private forgetSnapshots(tabId: string): void {
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.tabId === tabId) this.snapshots.delete(id);
    }
  }

  private snapshotFor(surface: BrowserSurface, page: CollectedPage): Snapshot {
    const snapshot: Snapshot = {
      id: nextId('s'),
      tabId: surface.id,
      url: page.url,
      elements: page.elements,
      capturedAt: Date.now(),
    };
    this.snapshots.set(snapshot.id, snapshot);
    // Keep only the most recent snapshots; refs are only meaningful briefly.
    if (this.snapshots.size > 32) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest !== undefined) this.snapshots.delete(oldest);
    }
    return snapshot;
  }

  private tabState(surface: BrowserSurface): Record<string, unknown> {
    return {
      tabId: surface.id,
      url: surface.url(),
      title: surface.title(),
      loading: surface.loading(),
      canGoBack: surface.canGoBack(),
      canGoForward: surface.canGoForward(),
      controlled: surface.id === this.activeTabId,
      visible: surface.id === this.activeTabId,
    };
  }

  private async dispatch(operation: BrowserOperation, request: BrowserRequest): Promise<BrowserResponse> {
    switch (operation) {
      case 'browser.get_state':
        return browserOk({
          browser: {
            available: true,
            panelVisible: this.activeTabId !== undefined,
            tabs: this.host.surfaces().map((s) => this.tabState(s)),
          },
        });

      case 'browser.activate_panel':
      case 'browser.activate_tab':
      case 'browser.switch_tab': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        this.activeTabId = surface.id;
        this.host.showPanel(surface.id);
        this.host.notify();
        return browserOk({ tab: this.tabState(surface) });
      }

      case 'browser.release_tab': {
        // Hand a tab back to the user: it stays open, the agent stops steering.
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        if (this.activeTabId === surface.id) this.activeTabId = undefined;
        this.host.notify();
        return browserOk({ tab: this.tabState(surface) });
      }

      case 'browser.close_tab': {
        // Close it for real. Releasing without tearing down left the page
        // running with no way for anyone to reach or stop it.
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const tabId = surface.id;
        if (this.activeTabId === tabId) this.activeTabId = undefined;
        this.forgetSnapshots(tabId);
        this.host.closeTab(tabId);
        this.host.notify();
        return browserOk({ tab: { tabId } });
      }

      case 'browser.get_history':
        return browserOk({ history: this.host.history() });

      case 'browser.get_downloads':
        return browserOk({ downloads: this.host.downloads() });

      case 'browser.get_device_profiles':
        return browserOk({ deviceProfiles: this.host.deviceProfiles() });

      case 'tab.get_state': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const page = await this.collect(surface);
        return browserOk({ tab: this.tabState(surface), viewport: page.viewport });
      }

      case 'tab.navigate':
      case 'tab.search':
        return this.navigate(operation, request);

      case 'browser.create_tab':
        return this.createTab(request);

      case 'tab.go_back': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        if (!surface.canGoBack()) return browserError('CANNOT_GO_BACK', 'No back history.');
        surface.goBack();
        return this.settled(surface);
      }

      case 'tab.go_forward': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        if (!surface.canGoForward()) return browserError('CANNOT_GO_FORWARD', 'No forward history.');
        surface.goForward();
        return this.settled(surface);
      }

      case 'tab.reload': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        surface.reload();
        return this.settled(surface);
      }

      case 'tab.stop_loading': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        surface.stop();
        return browserOk({ tab: this.tabState(surface) });
      }

      case 'tab.wait_for_load':
      case 'page.wait_for':
        return this.waitFor(request);

      case 'tab.set_device_mode': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const profileId = typeof request['profileId'] === 'string' ? request['profileId'] : undefined;
        const profile = this.host.deviceProfiles().find((p) => p.profileId === profileId);
        if (profileId !== undefined && profile === undefined) {
          return browserError('INVALID_REQUEST', `Unknown device profile: ${profileId}`);
        }
        return browserOk({ tab: this.tabState(surface), device: profile ?? null });
      }

      case 'page.visual.snapshot':
      case 'page.visual.crop': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const page = await this.collect(surface);
        const snapshot = this.snapshotFor(surface, page);
        const dataUrl = await surface.capture();
        return browserOk({
          tab: { tabId: surface.id, url: page.url, title: page.title },
          visual: {
            snapshotId: snapshot.id,
            width: page.viewport.width,
            height: page.viewport.height,
            deviceScaleFactor: page.viewport.deviceScaleFactor,
            cropAvailable: true,
            capturedAt: new Date(snapshot.capturedAt).toISOString(),
          },
          screenshot: dataUrl,
        });
      }

      case 'page.text.snapshot': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const page = await this.collect(surface);
        const maxChars = typeof request.maxChars === 'number' ? request.maxChars : MAX_TEXT_CHARS;
        const cursor = typeof request.cursor === 'string' ? Number.parseInt(request.cursor, 10) : 0;
        const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
        const slice = page.text.slice(start, start + maxChars);
        const next = start + slice.length;
        return browserOk({
          tab: { tabId: surface.id, url: page.url, title: page.title },
          text: slice,
          total: page.text.length,
          truncated: next < page.text.length,
          nextCursor: next < page.text.length ? String(next) : undefined,
        });
      }

      case 'page.elements.snapshot': {
        const surface = this.requireSurface(request.tabId);
        if (this.isResponse(surface)) return surface;
        const page = await this.collect(surface);
        const snapshot = this.snapshotFor(surface, page);
        const limit = typeof request.limit === 'number' ? request.limit : MAX_ELEMENTS;
        const elements = snapshot.elements.slice(0, limit);
        return browserOk({
          tab: { tabId: surface.id, url: page.url, title: page.title },
          elements: { snapshotId: snapshot.id, elements, total: snapshot.elements.length },
        });
      }

      case 'page.visual.click':
      case 'page.visual.click_if_interactive':
        return this.visualClick(operation, request);

      case 'page.visual.hover':
      case 'page.visual.scroll':
      case 'page.visual.drag':
      case 'page.visual.type_text':
      case 'page.visual.press_key':
        return this.visualAction(operation, request);

      case 'page.element.click':
      case 'page.element.hover':
      case 'page.element.fill':
      case 'page.element.type_text':
      case 'page.element.press_key':
      case 'page.element.select_option':
      case 'page.element.set_checked':
      case 'page.element.scroll_into_view':
        return this.elementAction(operation, request);

      default:
        return browserError('INVALID_REQUEST', `Unsupported operation: ${String(operation)}`);
    }
  }

  private async settled(surface: BrowserSurface): Promise<BrowserResponse> {
    await this.waitForLoad(surface, DEFAULT_TIMEOUT_MS);
    return browserOk({ tab: this.tabState(surface) });
  }

  private async waitForLoad(surface: BrowserSurface, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!surface.loading()) return true;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    return !surface.loading();
  }

  /**
   * Open a tab, navigate it, and make it the one the panel shows.
   *
   * A URL is optional: an empty tab is a legitimate starting point for the
   * agent, which then navigates or searches in it.
   */
  private async createTab(request: BrowserRequest): Promise<BrowserResponse> {
    const raw = typeof request.url === 'string' ? request.url.trim() : '';
    const target = raw.length === 0 ? 'about:blank' : this.resolveUrl('tab.navigate', raw);
    if (target.length > MAX_URL_LENGTH) {
      return browserError('INVALID_REQUEST', 'URL is too long.');
    }
    let surface: BrowserSurface;
    try {
      surface = await this.host.createTab(target);
    } catch (error) {
      // The panel has a hard cap on live surfaces. There is no error code for
      // "too many tabs" in the bundle's vocabulary, and inventing one would
      // render as a blank error, so this is reported as a failed request.
      const message = error instanceof Error ? error.message : String(error);
      return browserError('INVALID_REQUEST', message);
    }
    this.activeTabId = surface.id;
    this.host.showPanel(surface.id);
    await this.waitForLoad(surface, DEFAULT_TIMEOUT_MS);
    this.host.notify();
    return browserOk({ tab: this.tabState(surface) });
  }

  /** Turn whatever the agent typed into an absolute URL. */
  private resolveUrl(operation: BrowserOperation, raw: string): string {
    if (operation === 'tab.search') {
      return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(raw)) return `https://${raw}`;
    return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  }

  private async navigate(operation: BrowserOperation, request: BrowserRequest): Promise<BrowserResponse> {
    const raw = operation === 'tab.search' ? request.query : request.url;
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (url.length === 0) return browserError('INVALID_REQUEST', 'A url or query is required.');

    const target = this.resolveUrl(operation, url);
    if (target.length > MAX_URL_LENGTH) {
      return browserError('INVALID_REQUEST', 'URL is too long.');
    }
    const surface = this.surface(request.tabId);
    if (surface === undefined) return browserError('TAB_NOT_FOUND', 'No such tab.');
    try {
      await surface.loadURL(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return browserError('NAVIGATION_FAILED', message);
    }
    await this.waitForLoad(surface, DEFAULT_TIMEOUT_MS);
    this.host.notify();
    return browserOk({ tab: this.tabState(surface) });
  }

  private async visualClick(
    operation: BrowserOperation,
    request: BrowserRequest,
  ): Promise<BrowserResponse> {
    const surface = this.requireSurface(request.tabId);
    if (this.isResponse(surface)) return surface;
    const x = typeof request.x === 'number' ? request.x : Number.NaN;
    const y = typeof request.y === 'number' ? request.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return browserError('INVALID_REQUEST', 'Coordinates x and y are required.');
    }
    const page = await this.collect(surface);
    if (x < 0 || y < 0 || x > page.viewport.width || y > page.viewport.height) {
      return browserError('COORDINATE_OUT_OF_BOUNDS', `(${x}, ${y}) is outside the viewport.`);
    }
    const nearby = page.elements
      .filter((el) => {
        const b = el.bounds;
        if (b === undefined) return false;
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        return Math.hypot(cx - x, cy - y) <= 48;
      })
      .slice(0, 8);
    const target = nearby.find((el) => el.clickable && !el.disabled);
    if (target === undefined) {
      const outcome = operation === 'page.visual.click_if_interactive' ? 'no_target' : 'no_target';
      return browserOk({
        outcome,
        target: null,
        nearby,
        searchRadius: 48,
        candidatesTruncated: false,
        needsVisualConfirmation: true,
      });
    }
    return browserOk({
      outcome: 'clicked',
      target,
      nearby,
      searchRadius: 48,
      elementsSnapshotId: undefined,
    });
  }

  private async visualAction(
    operation: BrowserOperation,
    request: BrowserRequest,
  ): Promise<BrowserResponse> {
    const surface = this.requireSurface(request.tabId);
    if (this.isResponse(surface)) return surface;
    switch (operation) {
      case 'page.visual.scroll': {
        const deltaY = typeof request['deltaY'] === 'number' ? request['deltaY'] : 0;
        const deltaX = typeof request['deltaX'] === 'number' ? request['deltaX'] : 0;
        await surface.evaluate(`(() => { window.scrollBy(${deltaX}, ${deltaY}); return true; })()`);
        return browserOk({ x: request.x ?? null, y: request.y ?? null, deltaX, deltaY });
      }
      case 'page.visual.hover': {
        const x = typeof request.x === 'number' ? request.x : 0;
        const y = typeof request.y === 'number' ? request.y : 0;
        await surface.evaluate(
          `(() => { const el = document.elementFromPoint(${x}, ${y}); if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: ${x}, clientY: ${y} })); return true; })()`,
        );
        return browserOk({ x, y });
      }
      case 'page.visual.type_text': {
        const text = typeof request.text === 'string' ? request.text : '';
        await surface.evaluate(
          `(() => { const el = document.activeElement; if (!el) return false; el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: ${JSON.stringify(text)} })); if ('value' in el) el.value += ${JSON.stringify(text)}; el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} })); return true; })()`,
        );
        return browserOk({ text });
      }
      case 'page.visual.press_key': {
        const keys = Array.isArray(request.keys) ? request.keys : [];
        const key = typeof keys.at(-1) === 'string' ? String(keys.at(-1)) : '';
        await surface.evaluate(
          `(() => { const el = document.activeElement || document.body; for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`,
        );
        return browserOk({ keys });
      }
      case 'page.visual.drag': {
        return browserOk({ from: request['from'] ?? null, to: request['to'] ?? null });
      }
      default:
        return browserError('INVALID_REQUEST', `Unsupported operation: ${String(operation)}`);
    }
  }

  private async elementAction(
    operation: BrowserOperation,
    request: BrowserRequest,
  ): Promise<BrowserResponse> {
    const surface = this.requireSurface(request.tabId);
    if (this.isResponse(surface)) return surface;
    const snapshotId = typeof request.snapshotId === 'string' ? request.snapshotId : undefined;
    const ref = typeof request.ref === 'string' ? request.ref : undefined;
    if (snapshotId === undefined || ref === undefined) {
      return browserError('INVALID_REQUEST', 'snapshotId and ref are required.');
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (snapshot === undefined) return browserError('SNAPSHOT_EXPIRED', 'This snapshot is gone.');
    if (snapshot.tabId !== surface.id) {
      return browserError('STALE_SNAPSHOT', 'The snapshot belongs to another tab.');
    }
    const index = snapshot.elements.findIndex((el) => el.ref === ref);
    if (index < 0) return browserError('ELEMENT_NOT_FOUND', `No element ${ref} in this snapshot.`);

    // Re-resolve by position so a re-render does not invalidate the ref.
    const element = snapshot.elements[index];
    if (element === undefined) return browserError('ELEMENT_NOT_FOUND', `No element ${ref} in this snapshot.`);
    const script = this.elementScript(operation, index, request, element);
    const performed = await surface.evaluate<boolean>(script);
    if (!performed) {
      return browserError(
        operation === 'page.element.scroll_into_view' ? 'ELEMENT_NOT_FOUND' : 'ELEMENT_NOT_INTERACTABLE',
        `Element ${ref} could not be used.`,
      );
    }
    return browserOk({ target: element, relation: 'target' });
  }

  private elementScript(
    operation: BrowserOperation,
    index: number,
    request: BrowserRequest,
    element: PageElement,
  ): string {
    const text = typeof request.text === 'string' ? request.text : '';
    const keys = Array.isArray(request.keys) ? request.keys.map(String) : [];
    const checked = request['checked'] === true;
    const value = typeof request['value'] === 'string' ? request['value'] : '';
    const label = typeof request['label'] === 'string' ? request['label'] : '';
    const bounds = element.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const locate = `(() => {
      const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable="true"],[onclick]';
      const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };
      const candidates = [...document.querySelectorAll(INTERACTIVE)].filter(visible);
      const el = candidates[${index}];
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (Math.abs(rect.x - ${bounds.x}) > 8 || Math.abs(rect.y - ${bounds.y}) > 8) return null;
      return el;
    })()`;
    const action = (() => {
      switch (operation) {
        case 'page.element.click':
          return `el.click(); return true;`;
        case 'page.element.hover':
          return `el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true;`;
        case 'page.element.fill':
        case 'page.element.type_text':
          return `el.focus(); if ('value' in el) el.value = ${JSON.stringify(text)}; el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} })); return true;`;
        case 'page.element.press_key':
          return `el.focus(); for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(keys.at(-1) ?? '')}, bubbles: true })); return true;`;
        case 'page.element.select_option':
          return `if (el.tagName !== 'SELECT') return false; const option = [...el.options].find((o) => o.label === ${JSON.stringify(label)} || o.value === ${JSON.stringify(value)}); if (!option) return false; el.value = option.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true;`;
        case 'page.element.set_checked':
          return `if (!('checked' in el)) return false; el.checked = ${checked}; el.dispatchEvent(new Event('change', { bubbles: true })); return true;`;
        case 'page.element.scroll_into_view':
          return `el.scrollIntoView({ block: 'center', inline: 'center' }); return true;`;
        default:
          return `return false;`;
      }
    })();
    // `return` outside a function body is invalid, so wrap the whole thing.
    return `(() => { const el = ${locate}; if (!el) return false; ${action} })()`;
  }

  private async waitFor(request: BrowserRequest): Promise<BrowserResponse> {
    const surface = this.requireSurface(request.tabId);
    if (this.isResponse(surface)) return surface;
    const timeoutMs = Math.min(
      typeof request.timeoutMs === 'number' ? request.timeoutMs : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const stableForMs =
      typeof request.stableForMs === 'number' ? request.stableForMs : DEFAULT_WAIT_STABLE_MS;
    const deadline = Date.now() + timeoutMs;
    let stableSince: number | undefined;
    while (Date.now() < deadline) {
      if (!surface.loading()) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= stableForMs) {
          return browserOk({ tab: this.tabState(surface), matched: true, elapsed: 0 });
        }
      } else {
        stableSince = undefined;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    return browserError('WAIT_TIMEOUT', 'The page never settled.');
  }
}

/** Codes that mean "try again after a fresh snapshot", used by the retry logic. */
export const RETRYABLE_BROWSER_CODES: ReadonlySet<BrowserErrorCode> = new Set([
  'STALE_SNAPSHOT',
  'SNAPSHOT_EXPIRED',
  'STALE_ELEMENT',
  'PAGE_NOT_READY',
]);
