// Thin W3C WebDriver / Appium HTTP client. No retries: a lost response means the outcome is unknown.
import type { ActionStatus, Point, Rect } from '../core/types.ts';

export const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** The request may or may not have reached the device (connection dropped, no response in time). */
export class AppiumTransportError extends Error {
  readonly kind: 'transport' | 'timeout';
  constructor(kind: 'transport' | 'timeout', message: string, options?: { cause?: unknown }) {
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

// W3C codes that prove the command was refused before it touched the device.
const REFUSED_CODES: Record<string, true> = {
  'invalid argument': true,
  'invalid selector': true,
  'invalid session id': true,
  'invalid element state': true,
  'element not interactable': true,
  'element click intercepted': true,
  'move target out of bounds': true,
  'no such element': true,
  'no such window': true,
  'no such alert': true,
  'stale element reference': true,
  'session not created': true,
  'unknown command': true,
  'unknown method': true,
  'unsupported operation': true,
  'not implemented': true,
};

/**
 * Maps a failure to an action status.
 * `rejected` only when the W3C error code proves nothing was dispatched; everything else (transport loss,
 * timeouts, `unknown error` from a broken UIA2/WDA hop or a half-performed gesture) is `uncertain` and must
 * never be retried automatically.
 */
export function actionStatusOf(err: unknown): Exclude<ActionStatus, 'completed'> {
  return err instanceof AppiumProtocolError && REFUSED_CODES[err.code] ? 'rejected' : 'uncertain';
}

/** Parses a WebDriver error response body. Non-JSON / non-W3C bodies become `unknown error`. */
export function parseW3CError(httpStatus: number, body: string): AppiumProtocolError {
  let code = 'unknown error';
  let message = body.slice(0, 500) || `HTTP ${httpStatus}`;
  try {
    const parsed = JSON.parse(body) as { value?: { error?: unknown; message?: unknown } };
    const v = parsed.value;
    if (v && typeof v === 'object') {
      if (typeof v.error === 'string' && v.error) code = v.error;
      if (typeof v.message === 'string') message = v.message.split('\n')[0]!.slice(0, 500);
    }
  } catch {
    // keep raw text
  }
  return new AppiumProtocolError(httpStatus, code, message);
}

export interface W3CPointerAction {
  type: 'pointer';
  id: string;
  parameters: { pointerType: 'touch' };
  actions: Record<string, unknown>[];
}

const move = (p: Point, duration: number) => ({ type: 'pointerMove', duration, x: Math.round(p.x), y: Math.round(p.y), origin: 'viewport' });

/** move → down → pause → up. */
export function tapGesture(p: Point, pressMs = 60): W3CPointerAction[] {
  return [
    {
      type: 'pointer',
      id: 'finger1',
      parameters: { pointerType: 'touch' },
      actions: [move(p, 0), { type: 'pointerDown', button: 0 }, { type: 'pause', duration: pressMs }, { type: 'pointerUp', button: 0 }],
    },
  ];
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

  /** Raw request relative to the server root. Returns the W3C `value`. */
  async request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
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
    let parsed: { value?: unknown };
    try {
      parsed = JSON.parse(text) as { value?: unknown };
    } catch {
      throw new AppiumProtocolError(res.status, 'unknown error', `non-JSON response for ${method} ${path}`);
    }
    // Some drivers return HTTP 200 with a W3C error object.
    const v = parsed.value as { error?: unknown } | null | undefined;
    if (v && typeof v === 'object' && typeof v.error === 'string' && 'message' in v) throw parseW3CError(res.status, text);
    return parsed.value as T;
  }

  private sid(): string {
    if (!this.sessionId) throw new AppiumProtocolError(0, 'invalid session id', 'no open session');
    return this.sessionId;
  }

  /** Session-scoped request: `path` is appended to /session/:id. */
  cmd<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>(method, `/session/${this.sid()}${path}`, body, timeoutMs);
  }

  async status(timeoutMs = 3000): Promise<{ ready: boolean; build?: { version?: string } }> {
    return this.request('GET', '/status', undefined, timeoutMs);
  }

  async createSession(capabilities: Record<string, unknown>, timeoutMs = 240_000): Promise<Record<string, unknown>> {
    const value = await this.request<{ sessionId: string; capabilities: Record<string, unknown> }>(
      'POST',
      '/session',
      { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } },
      timeoutMs,
    );
    this.sessionId = value.sessionId;
    return value.capabilities;
  }

  async deleteSession(timeoutMs = 30_000): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = null;
    await this.request('DELETE', `/session/${id}`, undefined, timeoutMs);
  }

  source(): Promise<string> {
    return this.cmd<string>('GET', '/source');
  }

  async screenshot(): Promise<Uint8Array> {
    return Buffer.from(await this.cmd<string>('GET', '/screenshot'), 'base64');
  }

  windowRect(): Promise<Rect> {
    return this.cmd<Rect>('GET', '/window/rect');
  }

  async performActions(actions: W3CPointerAction[], timeoutMs?: number): Promise<void> {
    await this.cmd('POST', '/actions', { actions }, timeoutMs);
  }

  execute<T = unknown>(script: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cmd<T>('POST', '/execute/sync', { script, args: [args] }, timeoutMs);
  }

  async updateSettings(settings: Record<string, unknown>): Promise<void> {
    await this.cmd('POST', '/appium/settings', { settings });
  }

  getSettings(): Promise<Record<string, unknown>> {
    return this.cmd('GET', '/appium/settings');
  }

  /** Element id, or null when nothing matches. */
  async findElement(loc: Locator): Promise<string | null> {
    try {
      return elementId(await this.cmd('POST', '/element', loc));
    } catch (err) {
      if (err instanceof AppiumProtocolError && err.code === 'no such element') return null;
      throw err;
    }
  }

  async findElements(loc: Locator): Promise<string[]> {
    const list = await this.cmd<unknown[]>('POST', '/elements', loc);
    return list.map(elementId);
  }

  /** Focused element, or null when nothing has focus. */
  async activeElement(): Promise<string | null> {
    try {
      return elementId(await this.cmd('GET', '/element/active'));
    } catch (err) {
      if (err instanceof AppiumProtocolError && (err.code === 'no such element' || err.httpStatus === 404)) return null;
      throw err;
    }
  }

  async click(id: string): Promise<void> {
    await this.cmd('POST', `/element/${id}/click`, {});
  }

  async clear(id: string): Promise<void> {
    await this.cmd('POST', `/element/${id}/clear`, {});
  }

  async setValue(id: string, text: string): Promise<void> {
    await this.cmd('POST', `/element/${id}/value`, { text, value: [...text] });
  }

  elementText(id: string): Promise<string> {
    return this.cmd<string>('GET', `/element/${id}/text`);
  }

  elementAttribute(id: string, name: string): Promise<string | null> {
    return this.cmd<string | null>('GET', `/element/${id}/attribute/${encodeURIComponent(name)}`);
  }

  elementRect(id: string): Promise<Rect> {
    return this.cmd<Rect>('GET', `/element/${id}/rect`);
  }

  /** XCUITest only: XCTest typeText at the caret via WDA `/wda/keys` (Appium route `/keys`; Unicode-safe, no clipboard). */
  async wdaKeys(text: string): Promise<void> {
    await this.cmd('POST', '/keys', { value: [text] });
  }
}

function elementId(value: unknown): string {
  const v = value as Record<string, unknown> | null;
  const id = v?.[W3C_ELEMENT_KEY] ?? v?.ELEMENT;
  if (typeof id !== 'string') throw new AppiumProtocolError(200, 'unknown error', 'response is not an element reference');
  return id;
}
