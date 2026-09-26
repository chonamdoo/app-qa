// Device-free Driver built from fixtures (`fixtures/<platform>/<app>/<name>.{xml,png,meta.json}`) plus a virtual clock.
// Screens change only when the test's `onTap` / `onAction` script says so; every call is recorded.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../../src/core/config.ts';
import type { ActionOutcome, ActionStatus, AppTarget, Driver, Platform, Point, ResetMode, Snapshot, TypeOutcome } from '../../src/core/types.ts';
import { parseAndroidSource, parseIosSource } from '../../src/observe/index.ts';
import type { Clock } from '../../src/runner/engine.ts';

/** Virtual monotonic clock: `sleep` advances time instantly. */
export class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    await Promise.resolve();
  }
}

const pngCache = new Map<string, Uint8Array>();

/**
 * Snapshot of a fixture screen. `patch` replaces literal strings in the XML (tampered variants); the PNG is shared per
 * fixture so identical screens hash identically.
 */
export function fixtureSnapshot(
  platform: Platform,
  app: string,
  name: string,
  opts: { patch?: [string, string][]; foreground?: string | null; keyboardShown?: boolean } = {},
): Snapshot {
  const base = join(PATHS.fixtures, platform, app, name);
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) as { windowRect: Snapshot['screen'] };
  let xml = readFileSync(`${base}.xml`, 'utf8');
  for (const [from, to] of opts.patch ?? []) xml = xml.split(from).join(to);
  const screen = meta.windowRect;
  let png = pngCache.get(base);
  if (!png) {
    png = new Uint8Array(readFileSync(`${base}.png`));
    pngCache.set(base, png);
  }
  return {
    platform,
    takenAt: new Date(0).toISOString(),
    screen,
    nodes: platform === 'android' ? parseAndroidSource(xml, screen) : parseIosSource(xml, screen),
    rawSource: xml,
    screenshotPng: png,
    foregroundApp: opts.foreground === undefined ? null : opts.foreground,
    keyboardShown: opts.keyboardShown ?? false,
    maxDepth: null,
    depthCapped: false,
  };
}

export interface FakeCall {
  method: string;
  args: unknown[];
  at: number;
}

export class FakeDriver implements Driver {
  readonly platform: Platform;
  readonly deviceId = 'fake-device-1';
  readonly clock: FakeClock;
  readonly calls: FakeCall[] = [];
  screen: Snapshot;
  /** Next screen after a tap/long press at `p` (null = nothing changes). */
  onTap: (p: Point, driver: FakeDriver) => Snapshot | null = () => null;
  /** Called for every other mutating action (swipe, back, press, launch…); may replace `screen`. */
  onAction: (method: string, driver: FakeDriver) => void = () => undefined;
  /** Outcome status for the next taps (default completed). */
  tapStatus: ActionStatus = 'completed';
  /** Read-back error for typeText (e.g. `INPUT_UNVERIFIED: …`). */
  typeError: string | null = null;
  logText = '09-26 08:21:00.000  1234  1234 E ReactNativeJS: boom\n';
  crashes: { name: string; content: string }[] = [];

  constructor(screen: Snapshot, clock = new FakeClock()) {
    this.platform = screen.platform;
    this.screen = screen;
    this.clock = clock;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args, at: this.clock.now() });
  }

  private done(): ActionOutcome {
    return { status: 'completed', ms: 5 };
  }

  called(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async open(app: AppTarget): Promise<void> {
    this.record('open', app);
  }
  async close(): Promise<void> {
    this.record('close');
  }
  async snapshot(opts: { screenshot?: boolean } = {}): Promise<Snapshot> {
    this.record('snapshot', opts.screenshot ?? false);
    return { ...this.screen, takenAt: new Date(this.clock.now()).toISOString(), screenshotPng: opts.screenshot ? this.screen.screenshotPng : null };
  }
  async screenshot(): Promise<Uint8Array> {
    this.record('screenshot');
    return this.screen.screenshotPng!;
  }
  async tap(p: Point): Promise<ActionOutcome> {
    this.record('tap', p);
    if (this.tapStatus !== 'completed') return { status: this.tapStatus, ms: 3000, error: 'W3C 요청 시간 초과' };
    const next = this.onTap(p, this);
    if (next) this.screen = next;
    return this.done();
  }
  async typeText(at: Point, text: string, opts: { secure?: boolean; append?: boolean; submit?: boolean } = {}): Promise<TypeOutcome> {
    this.record('typeText', at, text, opts);
    this.onAction('typeText', this);
    return { status: 'completed', ms: 5, readBack: opts.secure ? '•'.repeat(text.length) : text, path: 'setValue', ...(this.typeError ? { error: this.typeError } : {}) };
  }
  async clearText(at: Point): Promise<TypeOutcome> {
    this.record('clearText', at);
    return { status: 'completed', ms: 5, readBack: '', path: 'setValue' };
  }
  async longPress(p: Point, holdMs: number): Promise<ActionOutcome> {
    this.record('longPress', p, holdMs);
    const next = this.onTap(p, this);
    if (next) this.screen = next;
    return this.done();
  }
  async swipe(from: Point, to: Point, durationMs: number): Promise<ActionOutcome> {
    this.record('swipe', from, to, durationMs);
    this.onAction('swipe', this);
    return this.done();
  }
  async back(): Promise<ActionOutcome> {
    this.record('back');
    this.onAction('back', this);
    return this.done();
  }
  async press(key: 'enter' | 'back' | 'tab' | 'escape' | 'delete'): Promise<ActionOutcome> {
    this.record('press', key);
    this.onAction('press', this);
    return this.done();
  }
  async hideKeyboard(): Promise<ActionOutcome> {
    this.record('hideKeyboard');
    this.screen = { ...this.screen, keyboardShown: false };
    return this.done();
  }
  async launch(app: AppTarget, opts?: { permissions?: Record<string, 'allow' | 'deny' | 'unset'>; arguments?: string[] }): Promise<ActionOutcome> {
    this.record('launch', app, opts);
    this.onAction('launch', this);
    return this.done();
  }
  async terminate(app: AppTarget): Promise<ActionOutcome> {
    this.record('terminate', app);
    return this.done();
  }
  async reset(app: AppTarget, mode: ResetMode): Promise<ActionOutcome> {
    this.record('reset', app, mode);
    this.onAction('reset', this);
    return this.done();
  }
  async openUrl(app: AppTarget, url: string): Promise<ActionOutcome> {
    this.record('openUrl', app, url);
    this.onAction('openUrl', this);
    return this.done();
  }
  async setLocation(lat: number, lon: number): Promise<ActionOutcome> {
    this.record('setLocation', lat, lon);
    return this.done();
  }
  async foregroundApp(): Promise<string | null> {
    return this.screen.foregroundApp;
  }
  async startLogs(app: AppTarget): Promise<void> {
    this.record('startLogs', app);
  }
  async logSlice(fromIso: string, toIso: string): Promise<string> {
    this.record('logSlice', fromIso, toIso);
    return this.logText;
  }
  async crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]> {
    this.record('crashArtifacts', app, sinceIso);
    return this.crashes;
  }
}

/** True when `p` lies inside the rect of the fixture node whose desc or text equals `label`. */
export function hits(snapshot: Snapshot, label: string, p: Point): boolean {
  return snapshot.nodes.some(
    (n) => (n.desc === label || n.text === label) && p.x >= n.rect.x && p.x < n.rect.x + n.rect.width && p.y >= n.rect.y && p.y < n.rect.y + n.rect.height,
  );
}
