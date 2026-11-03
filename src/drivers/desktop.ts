// Desktop browser input and observation through an owned headless Chrome or prepared worker W3C endpoint.
// Page scripts observe only; actions use real WebDriver pointer, wheel and keyboard input in viewport CSS px.
import { appendFileSync, readFileSync } from 'node:fs';
import { arch, platform as hostPlatform, release } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppiumClient, keyStrokes, tapGesture, unexpectedResponse, W3C_ELEMENT_KEY, W3C_KEYS, wheelScroll } from '../appium/client.ts';
import type { DesktopPlatform } from '../appium/setup.ts';
import { ensureDir } from '../core/fsx.ts';
import { PATHS } from '../core/config.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { ProjectFixtureBootstrap } from '../core/project-fixture.ts';
import type { ActionOutcome, AppTarget, Driver, Point, Rect, ResetMode, Snapshot, TypeOutcome, WebTarget } from '../core/types.ts';
import { parseWebSource, WEB_EXTRACT_SCRIPT, webSourceFromExtract } from '../observe/web.ts';
import { navigationProblem, targetProblem } from './appid.ts';
import { afterInput, failureStatus, RefusedError, StepError, valueMatches, type DriverOptions, type Key, type LaunchOptions } from './base.ts';
import { sliceLog } from './logs.ts';
import type { ChromeOwnerLocator } from '../core/chrome-owner.ts';
import type { StartTargetRecording, TargetRecording } from '../core/recording.ts';
import { ChromeOwnerClient, type ChromeOwnerOptions } from './chrome-owner-client.ts';
import { resolveOwnedChromePage } from './chrome-page.ts';

/** The deepest element at viewport point `(x, y)` (`arguments`), through open shadow roots, in `el` (null: nothing there). */
const ELEMENT_AT = `
const [x, y] = arguments;
let el = document.elementFromPoint(x, y);
while (el && el.shadowRoot) {
  const inner = el.shadowRoot.elementFromPoint(x, y);
  if (!inner || inner === el) break;
  el = inner;
}`;

/**
 * `el` (ELEMENT_AT) and its ancestors, innermost first and out through open shadow roots (a shadow tree's host), each
 * with its bounding box `[left, top, width, height]`, in `chain`.
 */
const HIT_CHAIN = `${ELEMENT_AT}
const chain = [];
for (let n = el; n; ) {
  const r = n.getBoundingClientRect();
  chain.push([n, [r.left, r.top, r.width, r.height]]);
  const root = n.getRootNode();
  n = n.parentElement || (root instanceof ShadowRoot ? root.host : null);
}`;

/** The deepest focused element, through open shadow roots, in `active` (null or the body: nothing focused). */
const ACTIVE = `
let active = document.activeElement;
while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;`;

/**
 * Read-only page scripts (W3C `/execute/sync` bodies). `field`: the element given as argument, else the focused one
 * (through open shadow roots), when it takes typed text; a password's value never leaves the page (length only).
 * `element`: the element input at a point reaches and its ancestors, each as its W3C reference with its box; `hit`: those
 * boxes. `active`: the element keys go to (its W3C reference), null when nothing but the document is focused.
 */
export const DESKTOP_SCRIPTS = {
  viewport: 'return [window.innerWidth, window.innerHeight];',
  field: `${ACTIVE}
const wantSecure = arguments[1] === true;
const el = arguments[0] || active;
if (!el) return null;
const control = (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)) || el.tagName === 'TEXTAREA';
if (!(control ? !el.readOnly && !el.disabled : el.isContentEditable)) return null;
const value = control ? el.value : el.innerText;
const secure = wantSecure || (el.tagName === 'INPUT' && el.type === 'password');
return { el, secure, length: Array.from(value).length, value: secure ? null : value };`,
  active: `${ACTIVE}
return active && active !== document.body && active !== document.documentElement ? active : null;`,
  history: "return { length: history.length, canGoBack: typeof navigation === 'object' && navigation !== null ? navigation.canGoBack : null };",
  focused: 'return document.hasFocus();',
  element: `${HIT_CHAIN}
return chain;`,
  hit: `${HIT_CHAIN}
return chain.map((link) => link[1]);`,
  // The origin check runs in the same script as the fetch, so a navigation in between cannot move the credentialed request.
  fixtureWitness: `if (location.origin !== new URL(arguments[0]).origin) throw new Error('fixture_witness_origin');
return (async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(arguments[0], { credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body || response.url !== arguments[0]) throw new Error('fixture_witness_refused');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0, text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 262144) { await reader.cancel(); throw new Error('fixture_witness_size_limit'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { clearTimeout(timer); }
})();`,
} as const;

const Viewport = z.tuple([z.number(), z.number()]);
const ElementRef = z.looseObject({ [W3C_ELEMENT_KEY]: z.string().min(1) });
const ElementOrNone = z.union([z.null(), ElementRef]);
const FieldState = z.union([z.null(), z.object({ el: ElementRef, secure: z.boolean(), length: z.number().int().nonnegative(), value: z.string().nullable() })]);
const HistoryState = z.object({ length: z.number().int().nonnegative(), canGoBack: z.boolean().nullable() });
const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const HitBoxes = z.array(Box);
const HitChain = z.array(z.tuple([ElementRef, Box]));

/** A page box `[left, top, width, height]` is `target` within ±2 px (sub-pixel layout rounding). */
function sameBox([x, y, w, h]: z.infer<typeof Box>, target: Rect): boolean {
  return Math.abs(x - target.x) <= 2 && Math.abs(y - target.y) <= 2 && Math.abs(w - target.width) <= 2 && Math.abs(h - target.height) <= 2;
}

/** A focused text field: its W3C element reference (passed back to the read-back script) and value (secure: `•` × length). */
interface Field {
  ref: { [W3C_ELEMENT_KEY]: string };
  secure: boolean;
  value: string;
}

/** Keys `press` sends; `delete` = Backspace like the native drivers (KEYCODE_DEL / XCTest `\b`). */
const PRESS_KEYS: Record<Exclude<Key, 'back'>, string> = { enter: W3C_KEYS.enter, tab: W3C_KEYS.tab, escape: W3C_KEYS.escape, delete: W3C_KEYS.backspace };
/** ⌘A then Backspace: macOS select-all + delete. */
const CLEAR_STROKES = [[W3C_KEYS.meta, 'a'], [W3C_KEYS.backspace]];
/** ⌘↓: caret to the end of an input or textarea (macOS). */
const END_STROKE = [W3C_KEYS.meta, W3C_KEYS.arrowDown];
/** WebDriver special-key code points: typed text containing one would press that key (e.g. U+E007 = Enter). */
const SPECIAL_KEY = /[\uE000-\uE05D]/;

/** Browser page-load timeout; the HTTP wait is longer so the driver's own `timeout` error arrives first. */
const PAGE_LOAD_MS = 30_000;
const NAV_TIMEOUT_MS = 45_000;
const LOG_POLL_MS = 1000;
/** How long a raised Safari window may take to get focus (measured ≤ 350 ms). */
const RAISE_MS = 1500;
/** Chrome reports a crashed renderer on the next command. */
const TAB_CRASH = /tab crashed|page crash/i;

const elapsed = (t0: number) => Math.round(performance.now() - t0);

/** `YYYY-MM-DD HH:MM:SS.mmm` in host local time — the iOS compact-log stamp, so `sliceLog(…'ios'…)` slices console lines too. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

interface DesktopDriverOptions extends DriverOptions {
  onUncertain?: (reason: string) => void;
  nativeOwner?: () => Promise<Omit<ChromeOwnerOptions, 'deviceId'>>;
}

export class DesktopWebDriver implements Driver {
  readonly platform: DesktopPlatform;
  readonly deviceId: string;
  readonly #opts: DesktopDriverOptions;
  #client: AppiumClient | null = null;
  #target: WebTarget | null = null;
  /** Renderer crashes seen in command errors (Chrome answers the next command with "tab crashed"). */
  readonly #crashes: { at: string; message: string }[] = [];
  #logFile: string | null = null;
  readonly #sanitizers = new Set<(line: string) => string>();
  #logTimer: NodeJS.Timeout | null = null;
  #draining: Promise<void> | null = null;
  /** Wheel input sources used so far: Safari ignores every scroll after the first on a reused wheel source (measured). */
  #wheels = 0;
  /** Sticky uncertainty: the owned guest browser may remain open, so later starts and closes cannot release its lease. */
  #displayUnknown: string | null = null;
  #mutationGuard: (() => void) | undefined;
  #nativeOwnerObserver: ((locator: ChromeOwnerLocator) => void) | undefined;
  #ownedEndpoint: ChromeOwnerClient | null = null;
  #chromeAddress: string | null = null;
  #browserIdentity: Record<string, unknown> | null = null;

  constructor(platform: DesktopPlatform, deviceId: string, opts: DesktopDriverOptions = {}) {
    this.platform = platform;
    this.deviceId = deviceId;
    this.#opts = opts;
  }

  setMutationGuard(guard: () => void): void {
    this.#mutationGuard = guard;
  }

  setNativeOwnerObserver(observer: (locator: ChromeOwnerLocator) => void): void {
    if (this.#ownedEndpoint) throw new RefusedError('원 native 시작 후 복구 binding을 교체하지 않습니다.');
    this.#nativeOwnerObserver = observer;
  }

  protected beforeCommand(method: 'GET' | 'POST' | 'DELETE', path: string): void {
    if (this.#ownedEndpoint && method === 'DELETE' && /^\/session\/[^/]+$/.test(path)) return;
    this.#ownedEndpoint?.assertHealthy();
    this.#mutationGuard?.();
  }

  protected async ownedEndpoint(): Promise<{ url: string; chrome?: ChromeOwnerClient }> {
    if (this.platform !== 'desktop-chrome') throw new RefusedError('Safari는 준비된 실제 macOS worker에서만 실행할 수 있습니다.');
    if (this.#opts.serverUrl) throw new RefusedError('호스트 Chrome은 외부 W3C endpoint를 채택하지 않습니다.');
    const options = this.#opts.nativeOwner ? await this.#opts.nativeOwner() : { projectRoot: process.cwd() };
    const chrome = new ChromeOwnerClient({ ...options, deviceId: this.deviceId, onCreated: locator => {
      options.onCreated?.(locator);
      this.#nativeOwnerObserver?.(locator);
    } });
    this.#ownedEndpoint = chrome;
    await chrome.start();
    return { url: chrome.url, chrome };
  }

  get nativeOwnerLocator(): ChromeOwnerLocator | null { return this.#ownedEndpoint?.locator ?? null; }

  async startOwnedChromeRecording(input: Parameters<StartTargetRecording>[0]): Promise<TargetRecording> {
    if (!this.#ownedEndpoint) throw new RefusedError('소유한 Chrome native 세션이 없습니다.');
    return this.#ownedEndpoint.startRecording(input);
  }

  get ownedChromeIdentity(): Readonly<Record<string, unknown>> | null {
    return this.#browserIdentity;
  }

  ownedChromeConnection(): { identity: { browserSessionId: string; profile: string; browserVersion: string; osVersion: string }; assertHealthy(): void; stop(): Promise<void> } {
    const identity = z.object({ browserSessionId: z.string().min(1), profile: z.string().min(1), browserVersion: z.string().min(1), osVersion: z.string().min(1) }).parse(this.#browserIdentity);
    return { identity, assertHealthy: () => this.assertOwnedChromeHealthy(), stop: () => this.close() };
  }

  assertOwnedChromeHealthy(): void {
    if (!this.#ownedEndpoint || !this.#client?.sessionId || this.#displayUnknown) throw new RefusedError('소유한 Chrome native 세션이 준비되지 않았습니다.');
    this.#ownedEndpoint.assertHealthy();
  }

  async applyProjectFixture(bootstrap: ProjectFixtureBootstrap, entryURL: string): Promise<void> {
    const entry = new URL(entryURL);
    if (!this.#target?.origins.includes(bootstrap.origin) || entry.origin !== bootstrap.origin || entry.username || entry.password || entry.hash || entry.search || !['http:', 'https:'].includes(entry.protocol)) throw new RefusedError('fixture cookie와 bootstrap entry는 승인된 실제 context origin에 결합되어야 합니다.');
    await this.#api.navigate(entry.href, NAV_TIMEOUT_MS);
    const actualURL = await this.#api.cmd('GET', '/url');
    if (typeof actualURL !== 'string' || new URL(actualURL).origin !== entry.origin) throw new RefusedError('Bootstrap entry가 승인된 origin의 실제 문서로 열리지 않았습니다.');
    const cookie = { ...bootstrap.cookie, expiry: Math.floor(Date.parse(bootstrap.lease.expiresAt) / 1000) };
    try {
      const response = await this.#api.cmd('POST', '/cookie', { cookie });
      if (response !== null) throw unexpectedResponse('fixture cookie installation', response);
      const actual = z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.string().optional() }).parse(await this.#api.cmd('GET', `/cookie/${encodeURIComponent(cookie.name)}`));
      if (actual.name !== cookie.name || actual.value !== cookie.value || actual.domain !== entry.hostname || actual.path !== '/' || !actual.httpOnly || actual.secure !== cookie.secure || actual.sameSite !== 'Strict') throw new RefusedError('실제 browser cookie가 승인된 host-only fixture authority와 다릅니다.');
    } catch (error) {
      // An install that failed or answered unexpectedly may still have set the credential, and the page may have navigated
      // after the origin check; remove it from whichever host received it. The original failure stands either way, and
      // the caller keeps the bootstrap effect unknown.
      try { await this.#api.cmd('DELETE', `/cookie/${encodeURIComponent(cookie.name)}`); } catch { /* reported through the original failure */ }
      throw error;
    }
  }

  async projectFixtureWitness(url: string): Promise<unknown> {
    const witness = new URL(url);
    if (!this.#target?.origins.includes(witness.origin) || witness.username || witness.password || witness.hash || !['http:', 'https:'].includes(witness.protocol)) throw new RefusedError('fixture witness가 승인된 context origin 밖에 있습니다.');
    return this.#api.executeScript(DESKTOP_SCRIPTS.fixtureWitness, [witness.href], 10_000);
  }

  async ownedChromePage(): Promise<string> {
    if (!this.#ownedEndpoint || !this.#chromeAddress) throw new RefusedError('소유한 headless Chrome 세션이 없습니다.');
    return resolveOwnedChromePage(this.#ownedEndpoint, this.#api);
  }

  get #api(): AppiumClient {
    if (!this.#client?.sessionId) throw new Error('브라우저 세션이 열려 있지 않습니다. open() 또는 launch()를 먼저 호출하세요.');
    return this.#client;
  }

  #displayUnknownError(): StepError {
    return new StepError({ status: 'uncertain', ms: 0, error: `브라우저 창이 화면에 남았을 수 있어 세션을 열거나 닫지 않습니다 (${this.#displayUnknown})` });
  }

  /** The target as a web profile for this browser, validated like every driver's (`targetProblem`: http(s) start URL without credentials, inside its origins); anything else is refused. */
  #web(app: AppTarget): WebTarget {
    const problem = targetProblem(this.platform, app);
    if (problem !== null || app.kind !== 'web') throw new RefusedError(problem ?? `${PLATFORM_INFO[this.platform].label}에서는 웹 대상만 실행할 수 있습니다`);
    return app;
  }

  #capabilities(): Record<string, unknown> {
    // Prompts are never answered on the runner's behalf: an open alert fails the next command instead.
    const common = { timeouts: { pageLoad: PAGE_LOAD_MS, script: 15_000 }, unhandledPromptBehavior: 'ignore' };
    if (this.platform === 'desktop-safari') return { ...common, platformName: 'mac', browserName: 'safari' };
    return {
      ...common,
      platformName: 'mac',
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen', '--lang=ko-KR'],
        prefs: { credentials_enable_service: false, profile: { password_manager_enabled: false, password_manager_leak_detection: false }, translate: { enabled: false } },
      },
      'goog:loggingPrefs': { browser: 'ALL' },
    };
  }

  /** A failed creation is unknown until guest termination is confirmed; an HTTP error is not proof that no browser opened. */
  async #startSession(target: WebTarget): Promise<void> {
    if (this.#displayUnknown !== null) throw this.#displayUnknownError();
    const t0 = performance.now();
    const endpoint = await this.ownedEndpoint();
    const url = endpoint.url;
    this.#ownedEndpoint = endpoint.chrome ?? null;
    const client = new AppiumClient(url, { beforeCommand: (method, path) => this.beforeCommand(method, path), ...(endpoint.chrome ? { nativeOwner: endpoint.chrome.credentials } : {}) });
    const capabilities = this.#capabilities();
    if (endpoint.chrome) {
      capabilities['goog:chromeOptions'] = { debuggerAddress: endpoint.chrome.debuggerAddress };
    }
    try {
      const actual = await client.createSession(capabilities);
      if (endpoint.chrome) {
        const options = actual['goog:chromeOptions'];
        const address = typeof options === 'object' && options !== null && 'debuggerAddress' in options ? options.debuggerAddress : null;
        if (typeof address !== 'string' || address !== endpoint.chrome.debuggerAddress) throw new Error('소유 Chrome debugger identity가 원 native browser와 다릅니다.');
        this.#chromeAddress = address;
        if (typeof actual.browserVersion !== 'string' || !actual.browserVersion || !client.sessionId) throw new Error('실제 Chrome 버전·세션 identity가 없습니다.');
        const commandLine = z.object({ arguments: z.array(z.string().min(1)).max(512) }).parse(await client.cmd('POST', '/goog/cdp/execute', { cmd: 'Browser.getBrowserCommandLine', params: {} }));
        if (commandLine.arguments.filter(argument => argument.startsWith('--user-data-dir=')).length !== 1 || !commandLine.arguments.includes(`--user-data-dir=${endpoint.chrome.profile}`) || !commandLine.arguments.includes('--headless=new')) throw new Error('실제 Chrome 실행 인자가 원 소유 profile·headless 실행과 다릅니다.');
        this.#browserIdentity = { browserSessionId: client.sessionId, browserVersion: actual.browserVersion, osVersion: release(), capabilities: actual, binary: endpoint.chrome.binary, profile: endpoint.chrome.profile, args: commandLine.arguments, os: { platform: hostPlatform(), release: release(), arch: arch() }, viewport: target.viewport };
      }
    } catch (err) {
      const message = (err as Error).message;
      this.#displayUnknown = `브라우저 세션을 만들지 못했습니다(창이 남았을 수 있음): ${message}`;
      throw new StepError({ status: 'uncertain', ms: elapsed(t0), error: this.#displayUnknown });
    }
    this.#client = client;
    this.#target = target;
    try {
      await this.#fitViewport(client, target.viewport);
      if (this.#browserIdentity) {
        const observed = await client.executeScript('return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, userAgent: navigator.userAgent, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };');
        const identity = z.object({ width: z.number().positive(), height: z.number().positive(), dpr: z.number().positive(), userAgent: z.string().min(1), language: z.string().min(1), timezone: z.string().min(1) }).parse(observed);
        this.#browserIdentity = { ...this.#browserIdentity, observed: identity };
      }
    } catch (err) {
      await this.#endSession();
      throw new RefusedError((err as Error).message);
    }
    if (this.#logFile) this.#logTimer ??= setInterval(() => void this.#drainLogs().catch(() => undefined), LOG_POLL_MS).unref();
  }

  /** Owned Chrome's CSS viewport must not depend on the host display; Safari keeps its real guest window. */
  async #fitViewport(client: AppiumClient, want: { width: number; height: number }): Promise<void> {
    if (this.#ownedEndpoint) {
      await client.cmd('POST', '/goog/cdp/execute', {
        cmd: 'Emulation.setDeviceMetricsOverride',
        params: { width: want.width, height: want.height, deviceScaleFactor: 1, mobile: false, screenWidth: want.width, screenHeight: want.height },
      });
      const actual = Viewport.safeParse(await client.executeScript(DESKTOP_SCRIPTS.viewport));
      if (!actual.success || actual.data[0] !== want.width || actual.data[1] !== want.height) throw new Error('소유 Chrome의 실제 CSS viewport가 요청한 가상 화면과 다릅니다.');
      if (this.#browserIdentity) this.#browserIdentity = { ...this.#browserIdentity, viewportMode: 'owned-chrome-desktop-metrics', deviceScaleFactor: 1 };
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const raw = await client.executeScript(DESKTOP_SCRIPTS.viewport);
      const measured = Viewport.safeParse(raw);
      if (!measured.success) throw unexpectedResponse('viewport', raw);
      const [width, height] = measured.data;
      if (width === want.width && height === want.height) return;
      if (attempt === 3) throw new Error(`브라우저 뷰포트를 ${want.width}×${want.height}로 맞추지 못했습니다 (현재 ${width}×${height}). 더 큰 디스플레이에서 실행하거나 프로필의 web.viewport를 줄이세요.`);
      const outer = await client.windowRect();
      await client.setWindowRect({ x: 0, y: 0, width: outer.width + want.width - width, height: outer.height + want.height - height });
    }
  }

  /**
   * Drops the session. A DELETE that fails, times out or answers anything but W3C `null` leaves the browser (and its
   * window on the shared display) in an unknown state: it is remembered and thrown as an `uncertain` StepError
   * instead of reporting an end — and so is every later end while that state lasts.
   */
  async #endSession(): Promise<void> {
    if (this.#logTimer) clearInterval(this.#logTimer);
    this.#logTimer = null;
    await this.#drainLogs().catch(() => undefined);
    const client = this.#client;
    this.#client = null;
    if (!client) {
      if (this.#displayUnknown !== null) throw this.#displayUnknownError();
      return;
    }
    try {
      await client.deleteSession();
      await this.#ownedEndpoint?.close();
      this.#ownedEndpoint = null;
      this.#chromeAddress = null;
      this.#browserIdentity = null;
    } catch (err) {
      this.#displayUnknown = `브라우저 세션 종료를 확인하지 못했습니다: ${(err as Error).message}`;
      throw new StepError({ status: 'uncertain', ms: 0, error: this.#displayUnknown });
    }
  }

  #noteFailure(err: unknown): void {
    const message = (err as Error).message ?? String(err);
    if (TAB_CRASH.test(message)) this.#crashes.push({ at: new Date().toISOString(), message: message.slice(0, 2000) });
  }

  /** Runs `fn`; failures are mapped by `failureStatus`. */
  async #act(fn: () => Promise<void>): Promise<ActionOutcome> {
    const t0 = performance.now();
    try {
      this.#mutationGuard?.();
      await fn();
      return { status: 'completed', ms: elapsed(t0) };
    } catch (err) {
      this.#noteFailure(err);
      const outcome: ActionOutcome = { status: failureStatus(err), ms: elapsed(t0), error: (err as Error).message };
      if (outcome.status === 'uncertain') this.#opts.onUncertain?.('guest_action_unknown');
      return outcome;
    }
  }

  /**
   * Real input (`fn` dispatches it). Safari drops WebDriver input while another app is in front (measured, Safari
   * 26.6: the click reached nothing), so on Safari an unfocused page gets its window raised before every input and must
   * gain focus within RAISE_MS, else the input is refused unsent. A refusal after the same action's click was sent
   * (the keys and Enter of type/clear) is `uncertain` there (`afterInput`).
   */
  #input(fn: () => Promise<void>): Promise<ActionOutcome> {
    return this.#act(async () => {
      if (this.platform === 'desktop-safari' && !(await this.#focused())) {
        await this.#api.raiseWindow();
        const deadline = performance.now() + RAISE_MS;
        while (!(await this.#focused())) {
          if (performance.now() >= deadline) throw new RefusedError('guest 안의 Safari 창이 활성화되지 않아 입력을 보내지 않았습니다. 호스트의 창·포커스·자동화 설정은 변경하지 않습니다.');
          await delay(100);
        }
      }
      await fn();
    });
  }

  async #focused(): Promise<boolean> {
    const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.focused);
    if (typeof raw !== 'boolean') throw unexpectedResponse('focused', raw);
    return raw;
  }

  /** A new session for `app`; a session still open from an earlier target is ended first (its browser window would linger) — an unconfirmed end, now or earlier, refuses to open a second one. */
  async open(app: AppTarget): Promise<void> {
    const target = this.#web(app);
    await this.#endSession();
    await this.#startSession(target);
  }

  /**
   * Ends the session and drops local state (log file, sanitizers, log timer) whatever the outcome; an unconfirmed
   * DELETE — this one or any earlier one — is thrown as the `uncertain` StepError: the window may still be on the
   * shared display.
   */
  async close(): Promise<void> {
    try {
      await this.#endSession();
    } finally {
      this.#logFile = null;
      this.#sanitizers.clear();
    }
  }

  /** The sticky reason a window may still be on the display (`#displayUnknown`), as soon as it is known. */
  displayProblem(): string | null {
    return this.#displayUnknown;
  }

  async snapshot(opts: { screenshot?: boolean } = {}): Promise<Snapshot> {
    const api = this.#api;
    const takenAt = new Date().toISOString();
    try {
      const [extract, png] = await Promise.all([api.executeScript(WEB_EXTRACT_SCRIPT, [], 30_000), opts.screenshot ? api.screenshot() : null]);
      const { xml, screen, pageUrl, truncated } = webSourceFromExtract(extract);
      return {
        platform: this.platform,
        surface: 'web',
        takenAt,
        screen,
        nodes: parseWebSource(xml, screen),
        rawSource: xml,
        screenshotPng: png,
        foregroundApp: this.#target!.appId,
        pageUrl,
        keyboardShown: false,
        maxDepth: null,
        depthCapped: truncated,
      };
    } catch (err) {
      this.#noteFailure(err);
      throw err;
    }
  }

  screenshot(): Promise<Uint8Array> {
    return this.#api.screenshot();
  }

  tap(p: Point): Promise<ActionOutcome> {
    return this.#input(() => this.#api.performActions(tapGesture(p, 60, 'mouse')));
  }

  longPress(p: Point, holdMs: number): Promise<ActionOutcome> {
    return this.#input(() => this.#api.performActions(tapGesture(p, Math.max(0, Math.round(holdMs)), 'mouse'), 30_000 + holdMs));
  }

  /**
   * Wheel at `from` by (from − to): the content moves the way a finger dragging from `from` to `to` would move it. Each
   * scroll uses a new wheel input source — on Safari 26 a reused source scrolled once, then never again.
   */
  swipe(from: Point, to: Point, durationMs: number): Promise<ActionOutcome> {
    const id = `wheel-${++this.#wheels}`;
    return this.#input(() => this.#api.performActions(wheelScroll(from, { x: from.x - to.x, y: from.y - to.y }, durationMs, id)));
  }

  /** The text field `ref` (else the focused element), or null when it does not take typed text. Secure values stay masked. */
  async #readField(ref: Field['ref'] | null, secure: boolean): Promise<Field | null> {
    const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.field, [ref, secure]);
    const r = FieldState.safeParse(raw);
    if (!r.success) throw unexpectedResponse('field', raw);
    if (!r.data) return null;
    const { el, length, value } = r.data;
    const masked = secure || r.data.secure;
    if (!masked && value === null) throw unexpectedResponse('field', raw);
    return { ref: { [W3C_ELEMENT_KEY]: el[W3C_ELEMENT_KEY] }, secure: masked, value: masked ? '•'.repeat(length) : value! };
  }

  /** Waits (≤ timeoutMs) for the tap to focus a text field. */
  async #waitField(secure: boolean, timeoutMs = 1500): Promise<Field | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const field = await this.#readField(null, secure);
      if (field || Date.now() >= deadline) return field;
      await delay(150);
    }
  }

  /** Polls the field until it reads `expected` (frameworks may re-render asynchronously) or time runs out; returns the last read. */
  async #readBack(field: Field, expected: string, timeoutMs = 1500): Promise<Field | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = await this.#readField(field.ref, field.secure);
      if ((now && valueMatches(expected, now.value, now.secure)) || Date.now() >= deadline) return now;
      await delay(150);
    }
  }

  /**
   * Tap `at`, require a focused text field, clear it with ⌘A + Backspace (or move the caret to the end when appending),
   * type `text` as key actions in the same dispatch (through the same foreground guard as the click), then read the value
   * back. Mismatch → `INPUT_UNVERIFIED`. Once the click was sent nothing is `rejected` (`afterInput`): a click that
   * focused no text field, or a refused field lookup, raise or key dispatch, is `uncertain`.
   */
  async #fill(at: Point, text: string, opts: { secure?: boolean; append?: boolean }): Promise<TypeOutcome> {
    const t0 = performance.now();
    let secure = opts.secure ?? false;
    const mask = (v: string) => (secure ? '•'.repeat([...v].length) : v);
    const done = (o: ActionOutcome, read: Field | null = null): TypeOutcome => ({ ...o, ms: elapsed(t0), readBack: read ? mask(read.value) : null, path: 'keys' });
    if (SPECIAL_KEY.test(text)) return done({ status: 'rejected', ms: 0, error: '입력 텍스트에 WebDriver 특수 키 문자(U+E000–U+E05D)가 있어 거부합니다' });
    const tapped = await this.tap(at);
    if (tapped.status !== 'completed') return done(tapped);
    let field: Field | null = null;
    const focus = await this.#act(async () => {
      field = await this.#waitField(secure);
      if (!field) throw new StepError({ status: 'uncertain', ms: 0, error: '클릭은 보냈지만 편집 가능한 입력 포커스가 생기지 않았습니다 (클릭의 효과를 알 수 없음)' });
    });
    const target = field as Field | null;
    if (focus.status !== 'completed' || !target) return done(afterInput(focus));
    secure = target.secure;
    const expected = opts.append ? target.value + text : text;
    const chars = [...text];
    const strokes = [...(opts.append ? [END_STROKE] : CLEAR_STROKES), ...chars.map((c) => [c])];
    const typed = await this.#input(() => this.#api.performActions(keyStrokes(strokes), 30_000 + 20 * chars.length));
    if (typed.status !== 'completed') return done(afterInput(typed));
    let after: Field | null;
    try {
      after = await this.#readBack(target, expected);
    } catch (err) {
      this.#noteFailure(err);
      const status = failureStatus(err);
      const message = (err as Error).message;
      // The keys were delivered: a refused read (field removed, page navigated) leaves the value unverified, never "rejected".
      return done(status === 'uncertain' ? { status, ms: 0, error: message } : { status: 'completed', ms: 0, error: `INPUT_UNVERIFIED: 입력 후 값을 읽지 못했습니다 (${message})` });
    }
    if (!after) return done({ status: 'completed', ms: 0, error: 'INPUT_UNVERIFIED: 입력 후 필드를 더 이상 편집할 수 없습니다' });
    if (!valueMatches(expected, after.value, secure)) {
      const error = text === '' && !opts.append ? `INPUT_UNVERIFIED: 지운 뒤 값 "${mask(after.value)}"` : `INPUT_UNVERIFIED: 기대 "${mask(expected)}", 실제 "${mask(after.value)}"`;
      return done({ status: 'completed', ms: 0, error }, after);
    }
    return done({ status: 'completed', ms: 0 }, after);
  }

  async typeText(at: Point, text: string, opts: { secure?: boolean; append?: boolean; submit?: boolean } = {}): Promise<TypeOutcome> {
    const t0 = performance.now();
    const typed = await this.#fill(at, text, opts);
    if (typed.status !== 'completed' || typed.error || !opts.submit) return typed;
    const pressed = await this.press('enter');
    return { ...typed, ...afterInput(pressed), ms: elapsed(t0) };
  }

  clearText(at: Point): Promise<TypeOutcome> {
    return this.#fill(at, '', {});
  }

  press(key: Key): Promise<ActionOutcome> {
    if (key === 'back') return this.back();
    return this.#input(() => this.#api.performActions(keyStrokes([[PRESS_KEYS[key]]])));
  }

  /**
   * History back, refused when there is nothing to go back to within the site: `history.length ≤ 1`, or the Navigation
   * API reports no earlier same-origin entry (the entry before the start URL is the session's blank page).
   */
  back(): Promise<ActionOutcome> {
    return this.#act(async () => {
      const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.history);
      const h = HistoryState.safeParse(raw);
      if (!h.success) throw unexpectedResponse('history', raw);
      if (h.data.length <= 1 || h.data.canGoBack === false) throw new RefusedError('브라우저 기록에 돌아갈 이전 페이지가 없어 뒤로 가기를 거부합니다');
      await this.#api.back(NAV_TIMEOUT_MS);
    });
  }

  /** Desktop browsers have no soft keyboard. */
  async hideKeyboard(): Promise<ActionOutcome> {
    return { status: 'completed', ms: 0 };
  }

  /** Opens a session when none is live, then navigates to the start URL. */
  launch(app: AppTarget, opts: LaunchOptions = {}): Promise<ActionOutcome> {
    return this.#act(async () => {
      const target = this.#web(app);
      if (opts.permissions && Object.keys(opts.permissions).length) throw new RefusedError('데스크톱 브라우저에서는 권한 설정을 지원하지 않습니다');
      if (opts.arguments?.length) throw new RefusedError('데스크톱 브라우저에서는 실행 인자를 지원하지 않습니다');
      if (!this.#client?.sessionId) await this.#startSession(target);
      await this.#api.navigate(target.url, NAV_TIMEOUT_MS);
    });
  }

  /** Ends the browser session (the browser quits; its temporary profile is discarded). */
  terminate(app: AppTarget): Promise<ActionOutcome> {
    return this.#act(async () => {
      this.#web(app);
      await this.#endSession();
    });
  }

  /**
   * relaunch = reload the start URL in the same session (cookies and storage kept, page state reset); clear = a new
   * session (fresh browser profile) then the start URL; reinstall has no browser equivalent.
   */
  async reset(app: AppTarget, mode: ResetMode): Promise<ActionOutcome> {
    const t0 = performance.now();
    if (mode === 'none') return { status: 'completed', ms: 0 };
    if (mode === 'reinstall') return { status: 'rejected', ms: 0, error: '웹 대상은 재설치(reinstall) 초기화를 지원하지 않습니다' };
    if (mode === 'clear') {
      const stopped = await this.terminate(app);
      if (stopped.status !== 'completed') return { ...stopped, ms: elapsed(t0) };
    }
    const launched = await this.launch(app);
    return { ...launched, ms: elapsed(t0) };
  }

  openUrl(app: AppTarget, url: string): Promise<ActionOutcome> {
    return this.#act(async () => {
      const problem = navigationProblem(this.#web(app), url);
      if (problem) throw new RefusedError(problem);
      await this.#api.navigate(url, NAV_TIMEOUT_MS);
    });
  }

  setLocation(_lat: number, _lon: number): Promise<ActionOutcome> {
    return this.#act(async () => {
      throw new RefusedError('데스크톱 브라우저에서는 위치 설정을 지원하지 않습니다');
    });
  }

  async foregroundApp(): Promise<string | null> {
    return this.#client?.sessionId ? (this.#target?.appId ?? null) : null;
  }

  /** Whether the element `elementFromPoint` finds at `p`, or one of its ancestors, occupies `target` (±2 px). */
  async isHittable(p: Point, target: Rect | null): Promise<boolean | undefined> {
    if (!target) return undefined;
    const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.hit, [Math.round(p.x), Math.round(p.y)]);
    const boxes = HitBoxes.safeParse(raw);
    if (!boxes.success) throw unexpectedResponse('elementFromPoint', raw);
    return boxes.data.some((box) => sameBox(box, target));
  }

  /**
   * W3C reference ids (JSON array) of the elements on the `elementFromPoint` chain at `p` (the element found and its
   * ancestors, out through open shadow roots) whose box is `box` (±2 px, as `isHittable`): the target element itself,
   * with any child or wrapper of exactly its box. The element input reaches may be a child of the target that
   * outlives it; the target is identified by its own reference. `box` null (OCR text: no element box): the whole
   * chain. null = no element there with that box.
   */
  async elementIdAt(p: Point, box: Rect | null): Promise<string | null> {
    const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.element, [Math.round(p.x), Math.round(p.y)]);
    const chain = HitChain.safeParse(raw);
    if (!chain.success) throw unexpectedResponse('elementFromPoint', raw);
    const ids = chain.data.flatMap(([ref, b]) => (box === null || sameBox(b, box) ? [ref[W3C_ELEMENT_KEY]] : []));
    return ids.length === 0 ? null : JSON.stringify(ids);
  }

  /** W3C reference id of the element keys go to (the deepest `document.activeElement`); null = nothing focused. */
  async focusedElementId(): Promise<string | null> {
    const raw = await this.#api.executeScript(DESKTOP_SCRIPTS.active);
    const ref = ElementOrNone.safeParse(raw);
    if (!ref.success) throw unexpectedResponse('activeElement', raw);
    return ref.data === null ? null : ref.data[W3C_ELEMENT_KEY];
  }

  /**
   * Chrome: the browser console (`/se/log` type `browser`), polled every second into `.qa/logs/<platform>-<ts>.log`; every
   * line passes every sanitizer armed so far before it is written. Safari exposes no console log over WebDriver.
   */
  async startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void> {
    this.#web(app);
    if (this.platform === 'desktop-safari') throw new Error(`${PLATFORM_INFO[this.platform].label}는 WebDriver로 콘솔 로그를 제공하지 않습니다 (콘솔 로그 미지원)`);
    this.#sanitizers.add(sanitize);
    this.#logFile ??= join(ensureDir(PATHS.logs), `${this.platform}-${Date.now()}.log`);
    await this.#drainLogs();
    this.#logTimer ??= setInterval(() => void this.#drainLogs().catch(() => undefined), LOG_POLL_MS).unref();
  }

  /** Moves the browser's buffered console entries into the log file (one drain at a time; reading empties the buffer). */
  #drainLogs(): Promise<void> {
    const file = this.#logFile;
    const client = this.#client;
    if (!file || !client?.sessionId) return Promise.resolve();
    this.#draining ??= (async () => {
      try {
        const entries = await client.logEntries('browser');
        const lines = entries.flatMap((e) => e.message.split('\n').map((part, i) => (i === 0 ? `${localStamp(e.timestamp)} ${e.level} ${part}` : part)));
        const clean = lines.map((line) => {
          let out = line;
          for (const s of this.#sanitizers) out = s(out);
          return `${out}\n`;
        });
        if (clean.length) appendFileSync(file, clean.join(''), { mode: 0o600 });
      } finally {
        this.#draining = null;
      }
    })();
    return this.#draining;
  }

  async logSlice(fromIso: string, toIso: string): Promise<string> {
    if (!this.#logFile) return '';
    await this.#drainLogs().catch(() => undefined);
    let text: string;
    try {
      text = readFileSync(this.#logFile, 'utf8');
    } catch {
      return '';
    }
    return sliceLog('ios', text, Date.parse(fromIso), Date.parse(toIso));
  }

  /** A renderer crash reported by the browser since `sinceIso`; browsers leave no other crash evidence to collect. */
  async crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]> {
    this.#web(app);
    const since = Date.parse(sinceIso);
    return this.#crashes.filter((c) => Date.parse(c.at) >= since).map((c, i) => ({ name: `${this.platform}-tab-crash-${i + 1}.txt`, content: `${c.at} ${c.message}\n` }));
  }
}
