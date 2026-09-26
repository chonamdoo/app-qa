// Shared Appium session driver: W3C gestures, snapshot, typed-text verification, outcome mapping.
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { actionStatusOf, AppiumClient, swipeGesture, tapGesture } from '../appium/client.ts';
import { CommandError } from '../appium/exec.ts';
import { ensureAppium } from '../appium/server.ts';
import type { ActionOutcome, ActionStatus, AppTarget, Driver, Platform, Point, RawNode, Rect, ResetMode, Snapshot, TypeOutcome } from '../core/types.ts';
import { appIdProblem } from './appid.ts';
import { findBackup } from './backup.ts';
import { LogCapture } from './logs.ts';

export type Key = 'enter' | 'back' | 'tab' | 'escape' | 'delete';
export type PermissionState = 'allow' | 'deny' | 'unset';
export interface LaunchOptions {
  permissions?: Record<string, PermissionState>;
  arguments?: string[];
}

/**
 * Portable permission names → Android runtime permissions (+ appops) and iOS `simctl privacy` services.
 * Raw Android permission names (containing '.') and raw simctl service names are also accepted.
 * `ios: null` = not settable on the simulator (e.g. notifications, camera).
 */
export const PERMISSION_GROUPS: Record<string, { android: string[]; appops?: string[]; ios: string | null }> = {
  location: { android: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'], appops: ['FINE_LOCATION', 'COARSE_LOCATION'], ios: 'location' },
  'location-always': {
    android: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_BACKGROUND_LOCATION'],
    appops: ['FINE_LOCATION', 'COARSE_LOCATION'],
    ios: 'location-always',
  },
  camera: { android: ['android.permission.CAMERA'], ios: null },
  microphone: { android: ['android.permission.RECORD_AUDIO'], ios: 'microphone' },
  contacts: { android: ['android.permission.READ_CONTACTS', 'android.permission.WRITE_CONTACTS'], ios: 'contacts' },
  calendar: { android: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'], ios: 'calendar' },
  photos: { android: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO'], ios: 'photos' },
  'media-library': { android: ['android.permission.READ_MEDIA_AUDIO'], ios: 'media-library' },
  notifications: { android: ['android.permission.POST_NOTIFICATIONS'], ios: null },
  motion: { android: ['android.permission.ACTIVITY_RECOGNITION'], ios: 'motion' },
  reminders: { android: [], ios: 'reminders' },
};

/** `simctl privacy` services (Xcode 27). */
export const IOS_PRIVACY_SERVICES: Record<string, true> = {
  all: true,
  calendar: true,
  'contacts-limited': true,
  contacts: true,
  location: true,
  'location-always': true,
  'photos-add': true,
  photos: true,
  'media-library': true,
  microphone: true,
  motion: true,
  reminders: true,
  siri: true,
};

export interface DriverOptions {
  /** Appium server URL; default = ensureAppium(). */
  serverUrl?: string;
}

/** Deepest element nesting in a page source, counting the platform root (`hierarchy` / `AppiumAUT`) as 0. Attribute values may contain `>`. */
export function xmlMaxDepth(xml: string): number {
  let depth = 0;
  let max = 0;
  for (const m of xml.matchAll(/<(\/?)[A-Za-z_][\w.:-]*(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>/g)) {
    if (m[1]) depth--;
    else if (m[2]) max = Math.max(max, depth + 1);
    else max = Math.max(max, ++depth);
  }
  return Math.max(0, max - 1);
}

export interface FieldValue {
  /** Text in the field; '' when only the hint/placeholder is showing. */
  value: string;
  /** Raw value as reported (may be the hint). */
  raw: string;
}

/** NFC + collapsed whitespace, used for read-back comparisons. */
const normText = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Read-back rule: NFC + whitespace-normalized equality; secure fields compare length only (values are masked). */
export function valueMatches(expected: string, actual: string, secure: boolean): boolean {
  return secure ? [...actual].length === [...expected].length : normText(actual) === normText(expected);
}

/**
 * Decides the typeText result from values read around setValue.
 * - match: read-back equals the expected text
 * - unchanged: field value identical to before setValue → a fallback input path is allowed
 * - partial: anything else → INPUT_UNVERIFIED, never retried with another path
 */
export function typeVerdict(expected: string, before: string, after: string, secure: boolean): 'match' | 'unchanged' | 'partial' {
  if (valueMatches(expected, after, secure)) return 'match';
  return after === before ? 'unchanged' : 'partial';
}

const elapsed = (t0: number) => Math.round(performance.now() - t0);

export abstract class AppiumDriver implements Driver {
  abstract readonly platform: Platform;
  readonly deviceId: string;
  protected readonly opts: DriverOptions;
  protected client: AppiumClient | null = null;
  protected screen: Rect | null = null;
  protected logs: LogCapture | null = null;
  /** App and sanitizer of the last `startLogs`, so a relaunch can re-arm the capture for the new process. */
  protected logTarget: { app: AppTarget; sanitize: (line: string) => string } | null = null;

  constructor(deviceId: string, opts: DriverOptions = {}) {
    this.deviceId = deviceId;
    this.opts = opts;
  }

  protected abstract capabilities(app: AppTarget): Record<string, unknown>;
  protected abstract settings(): Record<string, unknown>;
  /** Tree depth at which the on-device server truncates the snapshot. */
  protected abstract readonly depthLimit: number;
  protected abstract parse(xml: string, screen: Rect): RawNode[];
  protected abstract sourceFacts(xml: string): { foregroundApp: string | null; keyboardShown: boolean | null };
  protected abstract keyboardShown(): Promise<boolean>;
  protected abstract focusedElement(): Promise<string | null>;
  protected abstract readField(id: string): Promise<FieldValue>;
  /** Alternative input path used only when setValue left the field untouched. */
  protected abstract fallbackType(id: string, text: string): Promise<TypeOutcome['path']>;
  abstract press(key: Key): Promise<ActionOutcome>;
  abstract back(): Promise<ActionOutcome>;
  abstract hideKeyboard(): Promise<ActionOutcome>;
  abstract launch(app: AppTarget, opts?: LaunchOptions): Promise<ActionOutcome>;
  abstract terminate(app: AppTarget): Promise<ActionOutcome>;
  /** iOS clear = reinstall from `binary` + keychain reset; Android = `pm clear` (binary unused). */
  protected abstract clearData(app: AppTarget, binary: string | null): Promise<void>;
  /** True when the page source itself shows the keyboard (iOS); otherwise it is queried separately. */
  protected abstract readonly keyboardInSource: boolean;
  protected abstract reinstall(app: AppTarget, binary: string): Promise<void>;
  abstract openUrl(app: AppTarget, url: string): Promise<ActionOutcome>;
  abstract setLocation(lat: number, lon: number): Promise<ActionOutcome>;
  abstract foregroundApp(): Promise<string | null>;
  abstract startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void>;
  abstract crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]>;

  protected get api(): AppiumClient {
    if (!this.client?.sessionId) throw new Error('드라이버 세션이 열려 있지 않습니다. open()을 먼저 호출하세요.');
    return this.client;
  }

  /** The app's id once validated (it reaches device shells, simctl and backup paths); refused otherwise. */
  protected appId(app: AppTarget): string {
    const problem = appIdProblem(this.platform, app.appId);
    if (problem) throw new RefusedError(problem);
    return app.appId;
  }

  async open(app: AppTarget): Promise<void> {
    this.appId(app);
    const url = this.opts.serverUrl ?? (await ensureAppium()).url;
    const client = new AppiumClient(url);
    await client.createSession(this.capabilities(app));
    this.client = client;
    try {
      await client.updateSettings(this.settings());
      this.screen = await client.windowRect();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.logs?.stop();
    this.logs = null;
    const client = this.client;
    this.client = null;
    await client?.deleteSession().catch(() => undefined);
  }

  async snapshot(opts: { screenshot?: boolean } = {}): Promise<Snapshot> {
    const api = this.api;
    const takenAt = new Date().toISOString();
    const [xml, png, kb] = await Promise.all([
      api.source(),
      opts.screenshot ? api.screenshot() : null,
      this.keyboardInSource ? null : this.keyboardShown(),
    ]);
    const facts = this.sourceFacts(xml);
    const screen = this.screen ?? (this.screen = await api.windowRect());
    const maxDepth = xmlMaxDepth(xml);
    return {
      platform: this.platform,
      takenAt,
      screen,
      nodes: this.parse(xml, screen),
      rawSource: xml,
      screenshotPng: png,
      foregroundApp: facts.foregroundApp,
      keyboardShown: facts.keyboardShown ?? kb ?? false,
      maxDepth,
      depthCapped: maxDepth >= this.depthLimit,
    };
  }

  screenshot(): Promise<Uint8Array> {
    return this.api.screenshot();
  }

  /** Runs `fn`; failures are mapped by `failureStatus`. */
  protected async act(fn: () => Promise<void>): Promise<ActionOutcome> {
    const t0 = performance.now();
    try {
      await fn();
      return { status: 'completed', ms: elapsed(t0) };
    } catch (err) {
      return { status: failureStatus(err), ms: elapsed(t0), error: (err as Error).message };
    }
  }

  tap(p: Point): Promise<ActionOutcome> {
    return this.act(() => this.api.performActions(tapGesture(p)));
  }

  longPress(p: Point, holdMs: number): Promise<ActionOutcome> {
    return this.act(() => this.api.performActions(tapGesture(p, Math.max(0, Math.round(holdMs))), 30_000 + holdMs));
  }

  swipe(from: Point, to: Point, durationMs: number): Promise<ActionOutcome> {
    return this.act(() => this.api.performActions(swipeGesture(from, to, durationMs)));
  }

  /** Waits (≤ timeoutMs) for the tap to give some element input focus. */
  protected async waitFocused(timeoutMs = 1500): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const id = await this.focusedElement();
      if (id || Date.now() >= deadline) return id;
      await delay(150);
    }
  }

  /** Polls the field until it reads `expected` (RN updates asynchronously) or the time runs out; returns the last value. */
  protected async readBack(id: string, expected: string, secure: boolean, timeoutMs = 1500): Promise<FieldValue> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await this.readField(id);
      if (valueMatches(expected, v.value, secure) || Date.now() >= deadline) return v;
      await delay(150);
    }
  }

  async typeText(at: Point, text: string, opts: { secure?: boolean; append?: boolean; submit?: boolean } = {}): Promise<TypeOutcome> {
    const t0 = performance.now();
    const secure = opts.secure ?? false;
    const mask = (v: string) => (secure ? '•'.repeat([...v].length) : v);
    const fail = (o: ActionOutcome, readBack: string | null = null, path: TypeOutcome['path'] = 'setValue'): TypeOutcome => ({ ...o, ms: elapsed(t0), readBack, path });
    const tapped = await this.tap(at);
    if (tapped.status !== 'completed') return fail(tapped);
    let id: string | null = null;
    let expected = text;
    let before: FieldValue | null = null;
    const prep = await this.act(async () => {
      id = await this.waitFocused();
      if (!id) throw new RefusedError('탭한 위치에 입력 포커스가 생기지 않았습니다');
      if (opts.append) {
        before = await this.readField(id);
        expected = before.value + text;
      } else {
        await this.api.clear(id);
        before = await this.readField(id);
      }
    });
    if (prep.status !== 'completed' || !id || !before) return fail(prep);
    const field: string = id;
    const base: FieldValue = before;

    const set = await this.act(() => this.api.setValue(field, text));
    if (set.status === 'uncertain') return fail(set);
    let path: TypeOutcome['path'] = 'setValue';
    let after: FieldValue;
    try {
      after = await this.readBack(field, expected, secure);
      let verdict = typeVerdict(expected, base.value, after.value, secure);
      if (verdict === 'unchanged') {
        path = await this.fallbackType(field, text);
        after = await this.readBack(field, expected, secure);
        verdict = typeVerdict(expected, base.value, after.value, secure);
      }
      if (verdict !== 'match') {
        return fail({ status: 'completed', ms: 0, error: `INPUT_UNVERIFIED: 기대 "${mask(expected)}", 실제 "${mask(after.value)}"` }, mask(after.value), path);
      }
    } catch (err) {
      return fail({ status: failureStatus(err), ms: 0, error: (err as Error).message }, null, path);
    }
    if (opts.submit) {
      const pressed = await this.press('enter');
      if (pressed.status !== 'completed') return fail(pressed, mask(after.value), path);
    }
    return { status: 'completed', ms: elapsed(t0), readBack: mask(after.value), path };
  }

  async clearText(at: Point): Promise<TypeOutcome> {
    const t0 = performance.now();
    const tapped = await this.tap(at);
    if (tapped.status !== 'completed') return { ...tapped, readBack: null, path: 'setValue' };
    let after: FieldValue | null = null;
    const o = await this.act(async () => {
      const id = await this.waitFocused();
      if (!id) throw new RefusedError('탭한 위치에 입력 포커스가 생기지 않았습니다');
      await this.api.clear(id);
      after = await this.readBack(id, '', false);
    });
    const value = (after as FieldValue | null)?.value ?? null;
    if (o.status === 'completed' && value !== '') {
      return { status: 'completed', ms: elapsed(t0), readBack: value, path: 'setValue', error: `INPUT_UNVERIFIED: 지운 뒤 값 "${value}"` };
    }
    return { ...o, ms: elapsed(t0), readBack: value, path: 'setValue' };
  }

  /** Polls until the keyboard state equals `shown` or time runs out; returns the final state. */
  protected async waitKeyboard(shown: boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = await this.keyboardShown();
      if (now === shown || Date.now() >= deadline) return now;
      await delay(150);
    }
  }

  async reset(app: AppTarget, mode: ResetMode): Promise<ActionOutcome> {
    const t0 = performance.now();
    if (mode === 'none') return { status: 'completed', ms: 0 };
    let binary: string | null = null;
    const pre = await this.act(async () => {
      const appId = this.appId(app);
      if (mode === 'reinstall' || (mode === 'clear' && this.platform === 'ios')) {
        binary = app.binaryPath ?? findBackup(this.platform, appId);
        if (!binary || !existsSync(binary)) throw new RefusedError(`${appId} 백업이 없어 ${mode} 초기화를 거부합니다. \`qa apps --backup ${appId}\`로 먼저 백업하세요.`);
      }
    });
    if (pre.status !== 'completed') return { ...pre, ms: elapsed(t0) };
    const steps = await this.act(async () => {
      const stopped = await this.terminate(app);
      if (stopped.status !== 'completed') throw new StepError(stopped);
      try {
        if (mode === 'clear') await this.clearData(app, binary);
        if (mode === 'reinstall') await this.reinstall(app, binary!);
      } catch (err) {
        // App data/installation may already be modified: the device state is unknown.
        throw new StepError({ status: 'uncertain', ms: 0, error: (err as Error).message });
      }
    });
    if (steps.status !== 'completed') return { ...steps, ms: elapsed(t0) };
    const launched = await this.launch(app);
    return { ...launched, ms: elapsed(t0) };
  }

  async logSlice(fromIso: string, toIso: string): Promise<string> {
    return this.logs?.slice(fromIso, toIso) ?? '';
  }
}

/** Refused before anything was dispatched to the device. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedError';
  }
}

/** A sub-step outcome that must propagate as-is. */
export class StepError extends Error {
  readonly outcome: ActionOutcome;
  constructor(outcome: ActionOutcome) {
    super(outcome.error ?? outcome.status);
    this.name = 'StepError';
    this.outcome = outcome;
  }
}

/**
 * Failure → action status. `rejected` only when nothing reached the device (refused precondition, W3C refusal code,
 * host command that exited non-zero or could not start); transport loss, timeouts and unknown driver errors → `uncertain`.
 */
export function failureStatus(err: unknown): Exclude<ActionStatus, 'completed'> {
  if (err instanceof StepError) return err.outcome.status === 'completed' ? 'uncertain' : err.outcome.status;
  if (err instanceof RefusedError) return 'rejected';
  if (err instanceof CommandError) return err.exitCode !== null || err.spawnCode ? 'rejected' : 'uncertain';
  return actionStatusOf(err);
}
