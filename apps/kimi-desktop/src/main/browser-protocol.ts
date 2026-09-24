// The `kimi.browser/1.0.0` wire protocol.
//
// The web UI already speaks this: it is the shape the browser tool result is
// parsed into for the transcript (`apps/kimi-code/dist-web`, the
// `kimi.browser/1.0.0` args tag and the error-code table). The desktop shell
// answers it, so the agent's browser tool and the panel render the same run.
//
// Every request carries `protocol`, `operation`, `tabId`, `snapshotId`, `ref`
// and so on; every response is `{ ok: true, ... }` or `{ ok: false, error }`.

export const BROWSER_PROTOCOL = 'kimi.browser/1.0.0';

export const BROWSER_OPERATIONS = [
  'browser.get_state',
  'browser.activate_panel',
  'browser.create_tab',
  'browser.activate_tab',
  'browser.switch_tab',
  'browser.release_tab',
  'browser.close_tab',
  'browser.get_history',
  'browser.get_downloads',
  'browser.get_device_profiles',
  'tab.get_state',
  'tab.navigate',
  'tab.search',
  'tab.go_back',
  'tab.go_forward',
  'tab.reload',
  'tab.stop_loading',
  'tab.wait_for_load',
  'tab.set_device_mode',
  'page.wait_for',
  'page.visual.snapshot',
  'page.visual.crop',
  'page.visual.click',
  'page.visual.click_if_interactive',
  'page.visual.hover',
  'page.visual.scroll',
  'page.visual.drag',
  'page.visual.type_text',
  'page.visual.press_key',
  'page.text.snapshot',
  'page.elements.snapshot',
  'page.element.click',
  'page.element.hover',
  'page.element.fill',
  'page.element.type_text',
  'page.element.press_key',
  'page.element.select_option',
  'page.element.set_checked',
  'page.element.scroll_into_view',
] as const;

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];

const OPERATION_SET: ReadonlySet<string> = new Set(BROWSER_OPERATIONS);

export function isBrowserOperation(value: unknown): value is BrowserOperation {
  return typeof value === 'string' && OPERATION_SET.has(value);
}

/** Error codes the transcript understands; anything else renders as raw text. */
export type BrowserErrorCode =
  | 'SNAPSHOT_EXPIRED'
  | 'OUTPUT_LIMIT'
  | 'BROWSER_USER_TAKEOVER'
  | 'INVALID_REQUEST'
  | 'BROWSER_UNAVAILABLE'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_ACTIVE'
  | 'NAVIGATION_FAILED'
  | 'CANNOT_GO_BACK'
  | 'CANNOT_GO_FORWARD'
  | 'WAIT_TIMEOUT'
  | 'OPERATION_ABORTED'
  | 'STALE_SNAPSHOT'
  | 'COORDINATE_OUT_OF_BOUNDS'
  | 'PAGE_NOT_READY'
  | 'STALE_ELEMENT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'UNSUPPORTED_ELEMENT'
  | 'INTERNAL_ERROR';

export interface BrowserRequest {
  readonly protocol: typeof BROWSER_PROTOCOL;
  readonly operation: BrowserOperation;
  readonly tabId?: string;
  readonly snapshotId?: string;
  readonly ref?: string;
  readonly url?: string;
  readonly query?: string;
  readonly x?: number;
  readonly y?: number;
  readonly text?: string;
  readonly keys?: readonly string[];
  readonly cursor?: string;
  readonly timeoutMs?: number;
  readonly stableForMs?: number;
  readonly maxChars?: number;
  readonly limit?: number;
  readonly [key: string]: unknown;
}

export type BrowserResponse =
  | ({ readonly ok: true } & Record<string, unknown>)
  | { readonly ok: false; readonly error: { readonly code: BrowserErrorCode; readonly message: string } };

export function browserOk(payload: Record<string, unknown> = {}): BrowserResponse {
  return { ok: true, ...payload };
}

export function browserError(code: BrowserErrorCode, message: string): BrowserResponse {
  return { ok: false, error: { code, message } };
}

/**
 * Fields that are part of the envelope rather than the operation. The web UI
 * strips these when it compares two calls to decide whether one retried the
 * other, so they must stay stable.
 */
const ENVELOPE_FIELDS = new Set([
  'protocol',
  'operation',
  'tabId',
  'snapshotId',
  'ref',
  'url',
  'cursor',
  'timeoutMs',
  'stableForMs',
  'maxChars',
  'limit',
]);

export function isEnvelopeField(name: string): boolean {
  return ENVELOPE_FIELDS.has(name);
}
