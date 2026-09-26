// Thin W3C WebDriver / Appium HTTP client. No retries: a lost response means the outcome is unknown.
// Every 2xx body is decoded as a W3C envelope and every typed command checks the value shape it promises;
// anything else is transport-class (`uncertain`), never a silent success.
import { z } from 'zod';
import type { ActionStatus, Point, Rect } from '../core/types.ts';

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/**
 * The request may or may not have reached the device: connection dropped, no response in time, or an answer
 * that is not a valid W3C response for the command (`malformed`).
 */
export class AppiumTransportError extends Error {
  readonly kind: 'transport' | 'timeout' | 'malformed';
  constructor(kind: 'transport' | 'timeout' | 'malformed', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppiumTransportError';
    this.kind = kind;
  }
}

/** The server answered with a W3C error object. */
export class AppiumProtocolError extends Error {
  readonly httpStatus: number;
  /** W3C error code, e.g. "no such element", "invalid session id", "unknown error". */
  readonly code: string;
  constructor(httpStatus: number, code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AppiumProtocolError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

// Every W3C error code (WebDriver §6.6) plus Appium's `not implemented`. A code outside this set is not a W3C error.
const W3C_ERROR_CODES = new Set([
  'element click intercepted',
  'element not interactable',
  'insecure certificate',
  'invalid argument',
  'invalid cookie domain',
  'invalid element state',
  'invalid selector',
  'invalid session id',
  'javascript error',
  'move target out of bounds',
  'no such alert',
  'no such cookie',
  'no such element',
  'no such frame',
  'no such shadow root',
  'no such window',
  'detached shadow root',
  'script timeout',
  'session not created',
  'stale element reference',
  'timeout',
  'unable to capture screen',
  'unable to set cookie',
  'unexpected alert open',
  'unknown command',
  'unknown error',
  'unknown method',
  'unsupported operation',
  'not implemented',
]);

// W3C codes that prove the command was refused before it touched the device. A `Set`: the code is server-supplied text,
// so inherited object keys (`constructor`, `__proto__`) must never count as a refusal.
const REFUSED_CODES = new Set([
  'invalid argument',
  'invalid selector',
  'invalid session id',
  'invalid element state',
  'element not interactable',
  'element click intercepted',
  'move target out of bounds',
  'no such element',
  'no such window',
  'no such alert',
  'stale element reference',
  'session not created',
  'unknown command',
  'unknown method',
  'unsupported operation',
  'not implemented',
]);

/** A W3C error value: a known code, and `message` / `stacktrace` strings when present. */
const W3CErrorValue = z.looseObject({
  error: z.string().refine((code) => W3C_ERROR_CODES.has(code)),
  message: z.string().optional(),
  stacktrace: z.string().optional(),
});

/**
 * Maps a failure to an action status.
 * `rejected` only when the W3C error code proves nothing was dispatched; everything else (transport loss,
 * timeouts, `unknown error` from a broken UIA2/WDA hop or a half-performed gesture) is `uncertain` and must
 * never be retried automatically.
 */
export function actionStatusOf(err: unknown): Exclude<ActionStatus, 'completed'> {
  return err instanceof AppiumProtocolError && REFUSED_CODES.has(err.code) ? 'rejected' : 'uncertain';
}

/** The protocol error a W3C error value describes (first message line only), or null when `value` is not one. */
function w3cError(httpStatus: number, value: unknown): AppiumProtocolError | null {
  const r = W3CErrorValue.safeParse(value);
  if (!r.success) return null;
  const message = r.data.message === undefined ? `HTTP ${httpStatus}` : r.data.message.split('\n')[0]!.slice(0, 500);
  return new AppiumProtocolError(httpStatus, r.data.error, message);
}

/** Parses a WebDriver error response body. A body that is not a valid W3C error value becomes `unknown error` with the text kept. */
export function parseW3CError(httpStatus: number, body: string): AppiumProtocolError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // not JSON: keep the raw text below
  }
  const err = typeof parsed === 'object' && parsed !== null && 'value' in parsed ? w3cError(httpStatus, parsed.value) : null;
  return err ?? new AppiumProtocolError(httpStatus, 'unknown error', body.slice(0, 500) || `HTTP ${httpStatus}`);
}

/**
 * A 2xx answer that is not what the command promises. The command may still have run, so this is transport-class
 * (`uncertain`). Only the value's type is quoted: responses can carry screen text.
 */
export function unexpectedResponse(what: string, value: unknown): AppiumTransportError {
  const shape = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  return new AppiumTransportError('malformed', `${what}: unexpected response (${shape})`);
}

/**
 * Decodes a 2xx body: it must be a JSON object with a `value`; a `value.error` is a W3C error only when the value is a
 * valid W3C error (known code, string `message` / `stacktrace` when present). Any other `error`, or a missing/garbled
 * envelope, is `malformed`.
 */
function decodeW3CResponse(httpStatus: number, body: string, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppiumTransportError('malformed', `${what}: response is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('value' in parsed)) {
    throw new AppiumTransportError('malformed', `${what}: response has no W3C value`);
  }
  const value = parsed.value;
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'error')) {
    throw w3cError(httpStatus, value) ?? new AppiumTransportError('malformed', `${what}: response has an invalid W3C error`);
  }
  return value;
}

/** Command-specific value check; a mismatch is `malformed` (see `unexpectedResponse`). */
function decode<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw unexpectedResponse(what, value);
  return r.data;
}

const RectValue = z.looseObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const StatusValue = z.looseObject({ ready: z.boolean(), build: z.looseObject({ version: z.string().optional() }).optional() });
const NewSessionValue = z.looseObject({ sessionId: z.string().min(1), capabilities: z.record(z.string(), z.unknown()) });
/** W3C element reference (or the legacy JSONWP `ELEMENT` key) → element id. */
const ElementRef = z.union([
  z.looseObject({ [W3C_ELEMENT_KEY]: z.string().min(1) }).transform((r) => r[W3C_ELEMENT_KEY]),
  z.looseObject({ ELEMENT: z.string().min(1) }).transform((r) => r.ELEMENT),
]);
const Base64 = z.string().regex(/^[A-Za-z0-9+/\r\n]+={0,2}\s*$/);
const PNG_MAGIC = 0x89504e47;
/**
 * The only success answer of a mutating command (`/actions`, element click/clear/value, `/keys`): W3C `value: null`.
 * Checked against the pinned stack — every one of these answers exactly null, never `true`/`""`:
 * - Appium base-driver 10.8.1 turns a command's `undefined` result into null (`lib/protocol/helpers.ts:15-18`
 *   `formatResponseValue`, applied at `lib/protocol/protocol.ts:518` and to proxied bodies at `lib/jsonwp-proxy/proxy.ts:417`).
 * - UiAutomator2 8.7.0 serves all four in the driver (no-proxy list, `lib/driver.ts:155,172`) and returns `Promise<void>`:
 *   `performActions` (`lib/commands/actions.ts:62`), `click` / `clear` (`lib/commands/element.ts:122,139`), `setValue`
 *   (appium-android-driver 14.2.0 `lib/commands/element.ts:150`).
 * - XCUITest 12.13.2 returns `Promise<void>` from `performActions` (`lib/commands/gesture.ts:66`), `setValue` / `keys` /
 *   `clear` (`lib/commands/element.ts:234,287,298`); a native element click is proxied to WDA 16.12.10, whose
 *   `handleClick` answers `FBResponseWithOK()` (`WebDriverAgentLib/Commands/FBElementCommands.m:251`) = `value: NSNull`
 *   (`WebDriverAgentLib/Routing/FBResponsePayload.m:96`).
 * - Desktop browsers: WebDriver Navigate To / Back / Perform Actions "return success with data null" (W3C WebDriver
 *   §10.1, §10.3, §15.7); appium-chromium-driver 3.1.1 and appium-safari-driver 5.0.10 proxy chromedriver/safaridriver
 *   bodies unchanged.
 * - Delete Session: base-driver 10.8.1 never proxies it (`lib/protocol/protocol.ts:298-302`) and answers null whatever the
 *   driver returned (`lib/protocol/protocol.ts:521-528`); W3C WebDriver §8.2 "return success with data null".
 */
const Done = z.null();

/**
 * Documented success answer of every mutating `mobile:` script the drivers run; anything else is `malformed`.
 * `/execute/sync` is served by the driver itself (UiAutomator2 8.7.0 no-proxy list `lib/driver.ts:190` → appium-android-driver
 * 14.2.0 `lib/commands/execute.ts:21-25`; XCUITest 12.13.2 `lib/commands/execute.ts:20-23`), base-driver 10.8.0
 * `executeMethod` returns the command's own result (`lib/basedriver/commands/execute.ts:43-44`), and a `void` command
 * answers null (see `Done`).
 */
const MOBILE_RESULTS = {
  // UiAutomator2 8.7.0 `mobilePressKey`: Promise<void> (`lib/execute-method-map.ts:151`, `lib/commands/keyboard.ts:53-67`).
  'mobile: pressKey': Done,
  // UiAutomator2 8.7.0 `setClipboard`: Promise<void> (`lib/execute-method-map.ts:186`, `lib/commands/clipboard.ts:21-32`).
  'mobile: setClipboard': Done,
  // XCUITest 12.13.2 `mobileLaunchApp`: Promise<void> (`lib/execute-method-map.ts:182`, `lib/commands/app-management.ts:109-127`).
  'mobile: launchApp': Done,
  // XCUITest 12.13.2 `mobileTerminateApp` returns WDA's answer (`lib/execute-method-map.ts:189`, `lib/commands/app-management.ts:136-138`):
  // WDA 16.12.10 `FBSessionCommands.m:144-147` `@(result)`, true = terminated, false = was not running (`FBSession.m:417-428`).
  'mobile: terminateApp': z.boolean(),
  // XCUITest 12.13.2 `mobileHideKeyboard`: Promise<void> (`lib/execute-method-map.ts:591`, `lib/commands/keyboard.ts:28-32`);
  // WDA answers a keyboard it could not dismiss with `invalid element state` (`FBCustomCommands.m:140-148`).
  'mobile: hideKeyboard': Done,
} satisfies Record<string, z.ZodType>;

/** `mobile:` scripts that change the device; their answer is always validated (`AppiumClient.execute`). */
export type MutatingScript = keyof typeof MOBILE_RESULTS;
/** Read-only `mobile:` scripts; callers check the shape they use (`AppiumClient.query`). */
export type QueryScript = 'mobile: getCurrentPackage' | 'mobile: isKeyboardShown' | 'mobile: activeAppInfo';

export interface W3CPointerAction {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' | 'mouse' };
  actions: Record<string, unknown>[];
}

export interface W3CKeyAction {
  type: 'key';
  id: string;
  actions: Record<string, unknown>[];
}

export interface W3CWheelAction {
  type: 'wheel';
  id: string;
  actions: Record<string, unknown>[];
}

export type W3CInputSource = W3CPointerAction | W3CKeyAction | W3CWheelAction;

/** WebDriver special keys (W3C WebDriver §17.4.2 "Keyboard actions"). */
export const W3C_KEYS = {
  backspace: '\uE003',
  tab: '\uE004',
  enter: '\uE007',
  escape: '\uE00C',
  arrowDown: '\uE015',
  meta: '\uE03D',
} as const;

const move = (p: Point, duration: number) => ({ type: 'pointerMove', duration, x: Math.round(p.x), y: Math.round(p.y), origin: 'viewport' });

/** move → down → pause → up; `mouse` = left-button click at viewport CSS px (desktop browsers). */
export function tapGesture(p: Point, pressMs = 60, pointerType: 'touch' | 'mouse' = 'touch'): W3CPointerAction[] {
  return [
    {
      type: 'pointer',
      id: pointerType === 'mouse' ? 'mouse' : 'finger1',
      parameters: { pointerType },
      actions: [move(p, 0), { type: 'pointerDown', button: 0 }, { type: 'pause', duration: pressMs }, { type: 'pointerUp', button: 0 }],
    },
  ];
}

/** Mouse wheel at `at` scrolling by `delta` CSS px (positive y = content moves up, like a swipe from bottom to top). */
export function wheelScroll(at: Point, delta: Point, durationMs: number, id = 'wheel'): W3CWheelAction[] {
  return [
    {
      type: 'wheel',
      id,
      actions: [{ type: 'scroll', origin: 'viewport', x: Math.round(at.x), y: Math.round(at.y), deltaX: Math.round(delta.x), deltaY: Math.round(delta.y), duration: Math.max(0, Math.round(durationMs)) }],
    },
  ];
}

/**
 * Keyboard strokes: each stroke presses its keys in order and releases them in reverse (e.g. `[W3C_KEYS.meta, 'a']` =
 * ⌘A). A key is one code point: a character to type or a `W3C_KEYS` value.
 */
export function keyStrokes(strokes: readonly (readonly string[])[]): W3CKeyAction[] {
  const actions = strokes.flatMap((keys) => [...keys.map((value) => ({ type: 'keyDown', value })), ...keys.toReversed().map((value) => ({ type: 'keyUp', value }))]);
  return [{ type: 'key', id: 'keyboard', actions }];
}

/** Drag with a hold before lift so lists do not fling (inertia). */
export function swipeGesture(from: Point, to: Point, moveMs = 450, holdMs = 350): W3CPointerAction[] {
  return [
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [
        move(from, 0),
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 50 },
        move(to, Math.max(1, Math.round(moveMs))),
        { type: 'pause', duration: holdMs },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ];
}

export interface Locator {
  using: 'xpath' | 'id' | 'accessibility id' | 'class name' | '-android uiautomator' | '-ios predicate string' | '-ios class chain';
  value: string;
}

export interface ClientOptions {
  /** Default per-request timeout. */
  timeoutMs?: number;
}

export class AppiumClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  sessionId: string | null = null;

  constructor(baseUrl: string, opts: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Raw request relative to the server root. Returns the decoded W3C `value` (see `decodeW3CResponse`).
   * `x-appium-is-sensitive` makes Appium mask every request/response body it would log, even on a reused server
   * started with a verbose log level.
   */
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'x-appium-is-sensitive': 'true', ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AppiumTransportError('timeout', `${method} ${path}: no response in ${timeoutMs}ms`, { cause: err });
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new AppiumTransportError('transport', `${method} ${path}: ${cause?.code ?? cause?.message ?? (err as Error).message}`, { cause: err });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new AppiumTransportError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport', `${method} ${path}: response body lost`, { cause: err });
    }
    if (!res.ok) throw parseW3CError(res.status, text);
    return decodeW3CResponse(res.status, text, `${method} ${path}`);
  }

  private sid(): string {
    if (!this.sessionId) throw new AppiumProtocolError(0, 'invalid session id', 'no open session');
    return this.sessionId;
  }

  /** Session-scoped request: `path` is appended to /session/:id. */
  cmd(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    return this.request(method, `/session/${this.sid()}${path}`, body, timeoutMs);
  }

  async status(timeoutMs = 3000): Promise<{ ready: boolean; build?: { version?: string } }> {
    return decode(StatusValue, await this.request('GET', '/status', undefined, timeoutMs), 'GET /status');
  }

  async createSession(capabilities: Record<string, unknown>, timeoutMs = 240_000): Promise<Record<string, unknown>> {
    const value = await this.request('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, timeoutMs);
    const session = decode(NewSessionValue, value, 'POST /session');
    this.sessionId = session.sessionId;
    return session.capabilities;
  }

  /** Ends the session; completes only with W3C `null` (a failed, timed-out or garbled DELETE throws — the session may live on). */
  async deleteSession(timeoutMs = 30_000): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    decode(Done, await this.request('DELETE', `/session/${id}`, undefined, timeoutMs), 'DELETE /session');
  }

  async source(): Promise<string> {
    return decode(z.string().min(1), await this.cmd('GET', '/source'), 'GET /source');
  }

  /** PNG bytes; a value that is not base64 of a PNG is `malformed`. */
  async screenshot(): Promise<Uint8Array> {
    const value = await this.cmd('GET', '/screenshot');
    const png = Buffer.from(decode(Base64, value, 'GET /screenshot'), 'base64');
    if (png.length < 8 || png.readUInt32BE(0) !== PNG_MAGIC) throw unexpectedResponse('GET /screenshot', value);
    return png;
  }

  async windowRect(): Promise<Rect> {
    const { x, y, width, height } = decode(RectValue, await this.cmd('GET', '/window/rect'), 'GET /window/rect');
    return { x, y, width, height };
  }

  /** Resizes/moves the browser window; W3C answers the resulting window rect. */
  async setWindowRect(rect: Partial<Rect>): Promise<Rect> {
    const { x, y, width, height } = decode(RectValue, await this.cmd('POST', '/window/rect', rect), 'POST /window/rect');
    return { x, y, width, height };
  }

  async performActions(actions: W3CInputSource[], timeoutMs?: number): Promise<void> {
    decode(Done, await this.cmd('POST', '/actions', { actions }, timeoutMs), 'POST /actions');
  }

  /** Browser navigation; the driver answers once the page load strategy is satisfied. */
  async navigate(url: string, timeoutMs?: number): Promise<void> {
    decode(Done, await this.cmd('POST', '/url', { url }, timeoutMs), 'POST /url');
  }

  async currentUrl(): Promise<string> {
    return decode(z.string(), await this.cmd('GET', '/url'), 'GET /url');
  }

  /** Browser history back. */
  async back(timeoutMs?: number): Promise<void> {
    decode(Done, await this.cmd('POST', '/back', {}, timeoutMs), 'POST /back');
  }

  /** Page script (`/execute/sync`), undecoded: callers zod-validate the shape they use. */
  executeScript(script: string, args: unknown[] = [], timeoutMs?: number): Promise<unknown> {
    return this.cmd('POST', '/execute/sync', { script, args }, timeoutMs);
  }

  /** Entries of a legacy log buffer (`/se/log`, chromedriver: `browser` = console); reading drains the buffer. */
  async logEntries(type: string): Promise<{ timestamp: number; level: string; message: string }[]> {
    return decode(z.array(z.looseObject({ timestamp: z.number(), level: z.string(), message: z.string() })), await this.cmd('POST', '/se/log', { type }), 'POST /se/log');
  }

  /** Mutating `mobile:` script; completes only with that script's documented answer (`MOBILE_RESULTS`), else `malformed`. */
  async execute(script: MutatingScript, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<void> {
    const schema: z.ZodType = MOBILE_RESULTS[script];
    decode(schema, await this.cmd('POST', '/execute/sync', { script, args: [args] }, timeoutMs), script);
  }

  /** Read-only `mobile:` script result, undecoded: callers check the shape they use. */
  query(script: QueryScript, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return this.cmd('POST', '/execute/sync', { script, args: [args] }, timeoutMs);
  }

  async updateSettings(settings: Record<string, unknown>): Promise<void> {
    await this.cmd('POST', '/appium/settings', { settings });
  }

  async getSettings(): Promise<Record<string, unknown>> {
    return decode(z.record(z.string(), z.unknown()), await this.cmd('GET', '/appium/settings'), 'GET /appium/settings');
  }

  /** Element id, or null when nothing matches. */
  async findElement(loc: Locator): Promise<string | null> {
    try {
      return decode(ElementRef, await this.cmd('POST', '/element', loc), 'POST /element');
    } catch (err) {
      if (err instanceof AppiumProtocolError && err.code === 'no such element') return null;
      throw err;
    }
  }

  async findElements(loc: Locator): Promise<string[]> {
    const list = decode(z.array(z.unknown()), await this.cmd('POST', '/elements', loc), 'POST /elements');
    return list.map((v) => decode(ElementRef, v, 'POST /elements'));
  }

  /** Focused element, or null when nothing has focus. */
  async activeElement(): Promise<string | null> {
    try {
      return decode(ElementRef, await this.cmd('GET', '/element/active'), 'GET /element/active');
    } catch (err) {
      if (err instanceof AppiumProtocolError && (err.code === 'no such element' || err.httpStatus === 404)) return null;
      throw err;
    }
  }

  async click(id: string): Promise<void> {
    decode(Done, await this.cmd('POST', `/element/${id}/click`, {}), 'POST /element/:id/click');
  }

  async clear(id: string): Promise<void> {
    decode(Done, await this.cmd('POST', `/element/${id}/clear`, {}), 'POST /element/:id/clear');
  }

  async setValue(id: string, text: string): Promise<void> {
    decode(Done, await this.cmd('POST', `/element/${id}/value`, { text, value: [...text] }), 'POST /element/:id/value');
  }

  async elementText(id: string): Promise<string> {
    return decode(z.string(), await this.cmd('GET', `/element/${id}/text`), 'GET /element/:id/text');
  }

  async elementAttribute(id: string, name: string): Promise<string | null> {
    return decode(z.string().nullable(), await this.cmd('GET', `/element/${id}/attribute/${encodeURIComponent(name)}`), `GET /element/:id/attribute/${name}`);
  }

  async elementRect(id: string): Promise<Rect> {
    const { x, y, width, height } = decode(RectValue, await this.cmd('GET', `/element/${id}/rect`), 'GET /element/:id/rect');
    return { x, y, width, height };
  }

  /** XCUITest only: XCTest typeText at the caret via WDA `/wda/keys` (Appium route `/keys`; Unicode-safe, no clipboard). */
  async wdaKeys(text: string): Promise<void> {
    decode(Done, await this.cmd('POST', '/keys', { value: [text] }), 'POST /keys');
  }
}
