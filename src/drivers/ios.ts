// iOS simulator (XCUITest/WDA) driver. Host-side work (privacy, reset, url, location, logs) goes through simctl.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { swipeGesture } from '../appium/client.ts';
import type { ActionOutcome, AppTarget, Point, RawNode, Rect, TypeOutcome } from '../core/types.ts';
import { parseIosSource } from '../observe/index.ts';
import { iosAppExecutable } from './apps.ts';
import { AppiumDriver, IOS_PRIVACY_SERVICES, PERMISSION_GROUPS, RefusedError, type FieldValue, type Key, type LaunchOptions } from './base.ts';
import { xcrun } from './common.ts';
import { iosLogArgs, LogCapture } from './logs.ts';

/** Characters XCTest typeText maps to hardware keys. */
const WDA_KEYS: Record<Key, string | null> = { enter: '\n', tab: '\t', delete: '\b', escape: null, back: null };

/** Buttons that navigate back: UINavigationBar back button id, or common back labels. */
const BACK_BUTTON_CHAIN = '**/XCUIElementTypeButton[`name == "BackButton" OR label IN {"Back", "back", "뒤로", "뒤로 가기", "Go back", "이전"}`]';

const DIAGNOSTIC_REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');

/** First line of an .ips crash report is a JSON header naming the app. */
export function ipsNamesApp(content: string, appId: string): boolean {
  try {
    const h = JSON.parse(content.split('\n', 1)[0]!) as { bundleID?: string };
    return h.bundleID === appId;
  } catch {
    return false;
  }
}

export class IosDriver extends AppiumDriver {
  readonly platform = 'ios' as const;
  protected readonly depthLimit = 70;
  protected readonly keyboardInSource = true;

  protected capabilities(_app: AppTarget): Record<string, unknown> {
    return {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': this.deviceId,
      'appium:noReset': true,
      'appium:newCommandTimeout': 600,
      'appium:wdaLaunchTimeout': 240_000,
    };
  }

  protected settings(): Record<string, unknown> {
    return { waitForIdleTimeout: 0, animationCoolOffTimeout: 0, pageSourceExcludedAttributes: 'visible,accessible,index', snapshotMaxDepth: 70 };
  }

  protected parse(xml: string, screen: Rect): RawNode[] {
    return parseIosSource(xml, screen);
  }

  protected sourceFacts(xml: string): { foregroundApp: string | null; keyboardShown: boolean | null } {
    return { foregroundApp: /<XCUIElementTypeApplication\b[^>]*?\bbundleId="([^"]+)"/.exec(xml)?.[1] ?? null, keyboardShown: /<XCUIElementTypeKeyboard\b/.test(xml) };
  }

  protected async keyboardShown(): Promise<boolean> {
    return (await this.api.execute<boolean>('mobile: isKeyboardShown')) === true;
  }

  protected async focusedElement(): Promise<string | null> {
    return (await this.api.activeElement()) ?? this.api.findElement({ using: '-ios predicate string', value: 'hasKeyboardFocus == 1' });
  }

  protected async readField(id: string): Promise<FieldValue> {
    const [value, placeholder] = await Promise.all([this.api.elementAttribute(id, 'value'), this.api.elementAttribute(id, 'placeholderValue')]);
    const raw = value ?? '';
    return { value: placeholder !== null && raw === placeholder ? '' : raw, raw };
  }

  /** XCTest typeText at the caret. The clipboard path is forbidden on iOS (refused on iOS 27; host pasteboard sync overwrites it). */
  protected async fallbackType(_id: string, text: string): Promise<TypeOutcome['path']> {
    await this.api.wdaKeys(text);
    return 'keys';
  }

  press(key: Key): Promise<ActionOutcome> {
    if (key === 'back') return this.back();
    const chars = WDA_KEYS[key];
    return this.act(async () => {
      if (chars === null) throw new RefusedError(`iOS에서는 '${key}' 키를 보낼 수 없습니다`);
      if (!(await this.keyboardShown())) throw new RefusedError(`키보드가 없어 '${key}' 키를 보낼 수 없습니다`);
      await this.api.wdaKeys(chars);
    });
  }

  /** Nav-bar/back-labelled button in the top fifth of the screen, else a left-edge swipe. Never a no-op. */
  back(): Promise<ActionOutcome> {
    return this.act(async () => {
      const screen = this.screen ?? (this.screen = await this.api.windowRect());
      for (const id of await this.api.findElements({ using: '-ios class chain', value: BACK_BUTTON_CHAIN })) {
        const r = await this.api.elementRect(id);
        if (r.width > 0 && r.y + r.height / 2 < screen.height * 0.2) {
          await this.api.click(id);
          return;
        }
      }
      const y = Math.round(screen.height / 2);
      await this.api.performActions(swipeGesture({ x: 2, y }, { x: Math.round(screen.width * 0.75), y }, 300, 50));
    });
  }

  /** WDA dismiss via a "done" key only; keys that submit (search/go) are never pressed. */
  async hideKeyboard(): Promise<ActionOutcome> {
    const t0 = performance.now();
    const o = await this.act(async () => {
      if (!(await this.keyboardShown())) return;
      await this.api.execute('mobile: hideKeyboard', { keys: ['done', 'Done', '완료'] }).catch(() => undefined);
      if (await this.waitKeyboard(false, 500)) throw new RefusedError('키보드를 닫을 수 있는 완료(done) 키가 없어 키보드가 그대로입니다');
    });
    return { ...o, ms: Math.round(performance.now() - t0) };
  }

  /** Applies `simctl privacy`; returns services that cannot be set on the simulator. */
  private async applyPermissions(bundleId: string, permissions: Record<string, 'allow' | 'deny' | 'unset'>): Promise<string[]> {
    const skipped: string[] = [];
    for (const [name, state] of Object.entries(permissions)) {
      const group = PERMISSION_GROUPS[name];
      const service = group ? group.ios : IOS_PRIVACY_SERVICES[name] ? name : undefined;
      if (service === undefined) throw new RefusedError(`알 수 없는 권한 이름: ${name}`);
      if (service === null) {
        skipped.push(name);
        continue;
      }
      await xcrun(['simctl', 'privacy', this.deviceId, state === 'allow' ? 'grant' : state === 'deny' ? 'revoke' : 'reset', service, bundleId], { timeoutMs: 30_000 });
    }
    return skipped;
  }

  async launch(app: AppTarget, opts: LaunchOptions = {}): Promise<ActionOutcome> {
    let skipped: string[] = [];
    const o = await this.act(async () => {
      if (opts.permissions) skipped = await this.applyPermissions(app.appId, opts.permissions);
      await this.api.execute('mobile: launchApp', { bundleId: app.appId, ...(opts.arguments?.length ? { arguments: opts.arguments } : {}) }, 120_000);
    });
    if (o.status === 'completed' && skipped.length) return { ...o, error: `NOTE: iOS 시뮬레이터에서 설정할 수 없는 권한은 건너뜀: ${skipped.join(', ')}` };
    return o;
  }

  terminate(app: AppTarget): Promise<ActionOutcome> {
    return this.act(async () => {
      await this.api.execute('mobile: terminateApp', { bundleId: app.appId });
    });
  }

  protected async clearData(app: AppTarget, binary: string | null): Promise<void> {
    await this.reinstall(app, binary!);
    await xcrun(['simctl', 'keychain', this.deviceId, 'reset'], { timeoutMs: 60_000 });
  }

  protected async reinstall(app: AppTarget, binary: string): Promise<void> {
    await xcrun(['simctl', 'uninstall', this.deviceId, app.appId], { timeoutMs: 120_000 });
    await xcrun(['simctl', 'install', this.deviceId, binary], { timeoutMs: 600_000 });
  }

  openUrl(_app: AppTarget, url: string): Promise<ActionOutcome> {
    return this.act(async () => {
      await xcrun(['simctl', 'openurl', this.deviceId, url], { timeoutMs: 30_000 });
    });
  }

  setLocation(lat: number, lon: number): Promise<ActionOutcome> {
    return this.act(async () => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RefusedError('위도/경도가 올바르지 않습니다');
      await xcrun(['simctl', 'location', this.deviceId, 'set', `${lat},${lon}`], { timeoutMs: 15_000 });
    });
  }

  async foregroundApp(): Promise<string | null> {
    const info = await this.api.execute<{ bundleId?: string } | null>('mobile: activeAppInfo');
    return info?.bundleId ?? null;
  }

  /**
   * WDA `hittable` of the element at `p`: the last element in document order (deepest / drawn last) whose frame
   * contains the point. XPath because WDA predicates cannot do the `x + width` arithmetic. Undefined when none.
   */
  async isHittable(p: Point): Promise<boolean | undefined> {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const xpath = `(//*[not(self::XCUIElementTypeApplication or self::XCUIElementTypeWindow) and @x <= ${x} and @y <= ${y} and @x + @width >= ${x} and @y + @height >= ${y}])[last()]`;
    const id = await this.api.findElement({ using: 'xpath', value: xpath });
    if (!id) return undefined;
    return (await this.api.elementAttribute(id, 'hittable')) === 'true';
  }

  async startLogs(app: AppTarget): Promise<void> {
    this.logApp = app;
    this.logs ??= new LogCapture('ios', this.deviceId);
    const exe = await iosAppExecutable(this.deviceId, app.appId);
    if (!exe) throw new Error(`${app.appId}의 실행 파일 이름을 알 수 없습니다.`);
    this.logs.arm(`exec:${exe}`, 'xcrun', iosLogArgs(this.deviceId, exe));
  }

  async crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]> {
    const since = Date.parse(sinceIso);
    if (!existsSync(DIAGNOSTIC_REPORTS)) return [];
    const out: { name: string; content: string }[] = [];
    for (const name of readdirSync(DIAGNOSTIC_REPORTS)) {
      if (!name.endsWith('.ips')) continue;
      const file = join(DIAGNOSTIC_REPORTS, name);
      if (statSync(file).mtimeMs < since) continue;
      const content = readFileSync(file, 'utf8');
      if (ipsNamesApp(content, app.appId)) out.push({ name, content });
    }
    return out;
  }
}
