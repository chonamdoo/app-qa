// iOS simulator (XCUITest/WDA) driver. Host-side work (privacy, reset, url, location, logs) goes through simctl.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { swipeGesture, unexpectedResponse } from '../appium/client.ts';
import { xcrun } from '../appium/exec.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { ActionOutcome, AppTarget, Point, RawNode, Rect, TypeOutcome } from '../core/types.ts';
import { parseIosSource } from '../observe/ios.ts';
import { navigationProblem } from './appid.ts';
import { iosAppExecutable } from './apps.ts';
import { AppiumDriver, assertNoWebLaunchOptions, IOS_PRIVACY_SERVICES, PERMISSION_GROUPS, RefusedError, type FieldValue, type Key, type LaunchOptions } from './base.ts';
import { iosSafariChecks } from './browser-prep.ts';
import { iosLogArgs, LogCapture } from './logs.ts';

/** Characters XCTest typeText maps to hardware keys. */
const WDA_KEYS: Record<Key, string | null> = { enter: '\n', tab: '\t', delete: '\b', escape: null, back: null };

/** Buttons that navigate back: UINavigationBar back button id, or common back labels. */
const BACK_BUTTON_CHAIN = '**/XCUIElementTypeButton[`name == "BackButton" OR label IN {"Back", "back", "뒤로", "뒤로 가기", "Go back", "이전"}`]';

const SAFARI = PLATFORM_INFO.ios.browser;

/** Done button of Safari's form bar above the keyboard (이전 / 다음 / 완료); page content never sits in a toolbar. */
const SAFARI_FORM_DONE_CHAIN = '**/XCUIElementTypeToolbar/**/XCUIElementTypeButton[`name IN {"Done", "완료"}`]';

/** Safari's own back button (browser toolbar, bottom on iPhone); disabled (`enabled="false"`) when the tab has no history. */
const SAFARI_BACK_CHAIN = '**/XCUIElementTypeButton[`name == "BackButton"`]';

/**
 * Safari's website data inside its simulator data container: WebKit website data (localStorage, IndexedDB, service
 * workers…), cookies, HTTP storages (HSTS…) and the HTTP cache. Emptying these with Safari terminated clears the
 * cookies and localStorage of every site (verified on iOS 26.5); bookmarks, history and settings are kept.
 */
const SAFARI_WEBSITE_DATA = [`Library/WebKit/${SAFARI}/WebsiteData`, 'Library/Cookies', 'Library/HTTPStorages', `Library/Caches/${SAFARI}/WebKit`];

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
  protected readonly browserChecks = iosSafariChecks;
  protected readonly addressBarId = 'TabBarItemTitle';

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
    const shown = await this.api.query('mobile: isKeyboardShown');
    if (typeof shown !== 'boolean') throw unexpectedResponse('mobile: isKeyboardShown', shown);
    return shown;
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

  /**
   * Web: taps Safari's back button; refused while it is disabled (no history) or not shown, never another gesture.
   * App: nav-bar/back-labelled button in the top fifth of the screen, else a left-edge swipe. Never a no-op.
   */
  back(): Promise<ActionOutcome> {
    if (this.opened?.kind === 'web') {
      return this.act(async () => {
        const [id] = await this.api.findElements({ using: '-ios class chain', value: SAFARI_BACK_CHAIN });
        if (!id) throw new RefusedError('Safari 뒤로 버튼이 화면에 없습니다 (도구 막대가 접혔거나 Safari 화면이 아님)');
        if ((await this.api.elementAttribute(id, 'enabled')) !== 'true') throw new RefusedError('Safari 뒤로 버튼이 비활성입니다 (이 탭에 이전 페이지가 없음)');
        await this.api.click(id);
      });
    }
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

  /**
   * Apps: WDA dismiss via a "done" key only; keys that submit (search/go) are never pressed. Web: taps the Done button
   * of Safari's form bar above the keyboard (it blurs the field without submitting; WDA does not look outside the
   * keyboard). A lost, timed-out or garbled answer propagates as `uncertain`; only a keyboard verified still shown after
   * an answered command, or a missing Done button, is `rejected`.
   */
  async hideKeyboard(): Promise<ActionOutcome> {
    const t0 = performance.now();
    const o = await this.act(async () => {
      if (!(await this.keyboardShown())) return;
      if (this.opened?.kind === 'web') {
        const [done] = await this.api.findElements({ using: '-ios class chain', value: SAFARI_FORM_DONE_CHAIN });
        if (!done) throw new RefusedError('Safari 입력 도구 막대에 완료 버튼이 없어 키보드를 닫지 않았습니다');
        await this.api.click(done);
        if (await this.waitKeyboard(false, 1500)) throw new RefusedError('Safari 완료 버튼을 눌렀지만 키보드가 그대로입니다');
        return;
      }
      await this.api.execute('mobile: hideKeyboard', { keys: ['done', 'Done', '완료'] });
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
      const bundleId = this.appId(app);
      if (app.kind === 'web') {
        assertNoWebLaunchOptions(opts);
        await xcrun(['simctl', 'openurl', this.deviceId, app.url], { timeoutMs: 30_000 });
        return;
      }
      if (opts.permissions) skipped = await this.applyPermissions(bundleId, opts.permissions);
      await this.api.execute('mobile: launchApp', { bundleId, ...(opts.arguments?.length ? { arguments: opts.arguments } : {}) }, 120_000);
    });
    if (o.status === 'completed' && skipped.length) return { ...o, error: `NOTE: iOS 시뮬레이터에서 설정할 수 없는 권한은 건너뜀: ${skipped.join(', ')}` };
    return o;
  }

  terminate(app: AppTarget): Promise<ActionOutcome> {
    return this.act(async () => {
      const bundleId = this.appId(app);
      await this.api.execute('mobile: terminateApp', { bundleId });
    });
  }

  /** App: reinstall from the backup + device-wide keychain reset. Web: Safari website data wipe (Safari is already terminated). */
  protected async clearData(app: AppTarget, binary: string | null): Promise<void> {
    if (app.kind === 'web') return this.wipeSafariWebsiteData();
    await this.reinstall(app, binary!);
    await xcrun(['simctl', 'keychain', this.deviceId, 'reset'], { timeoutMs: 60_000 });
  }

  /** Empties `SAFARI_WEBSITE_DATA` in this simulator's Safari data container; any other path is refused before deleting. */
  private async wipeSafariWebsiteData(): Promise<void> {
    const container = (await xcrun(['simctl', 'get_app_container', this.deviceId, SAFARI, 'data'], { timeoutMs: 30_000 })).trim();
    const root = `/CoreSimulator/Devices/${this.deviceId}/data/Containers/Data/Application/`;
    const at = container.indexOf(root);
    if (!isAbsolute(container) || resolve(container) !== container || at < 0 || !/^[0-9A-F-]{36}$/i.test(container.slice(at + root.length))) {
      throw new Error(`Safari 데이터 컨테이너 경로가 이 시뮬레이터의 앱 데이터 경로가 아니어서 지우지 않습니다: ${JSON.stringify(container.slice(0, 300))}`);
    }
    for (const rel of SAFARI_WEBSITE_DATA) {
      const dir = join(container, rel);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }

  protected async reinstall(app: AppTarget, binary: string): Promise<void> {
    await xcrun(['simctl', 'uninstall', this.deviceId, this.appId(app)], { timeoutMs: 120_000 });
    await xcrun(['simctl', 'install', this.deviceId, binary], { timeoutMs: 600_000 });
  }

  /** Web: an allowed-origin http(s) URL, opened by Safari (in a new tab). App: deep link routed by the system. Both via `simctl openurl`. */
  openUrl(app: AppTarget, url: string): Promise<ActionOutcome> {
    return this.act(async () => {
      this.appId(app);
      let open = url;
      if (app.kind === 'web') {
        const problem = navigationProblem(app, url);
        if (problem) throw new RefusedError(problem);
        open = new URL(url).href;
      }
      await xcrun(['simctl', 'openurl', this.deviceId, open], { timeoutMs: 30_000 });
    });
  }

  setLocation(lat: number, lon: number): Promise<ActionOutcome> {
    return this.act(async () => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RefusedError('위도/경도가 올바르지 않습니다');
      await xcrun(['simctl', 'location', this.deviceId, 'set', `${lat},${lon}`], { timeoutMs: 15_000 });
    });
  }

  async foregroundApp(): Promise<string | null> {
    const info = await this.api.query('mobile: activeAppInfo');
    if (typeof info !== 'object' || info === null || !('bundleId' in info)) throw unexpectedResponse('mobile: activeAppInfo', info);
    const { bundleId } = info;
    if (bundleId !== null && typeof bundleId !== 'string') throw unexpectedResponse('mobile: activeAppInfo', info);
    return bundleId || null;
  }

  /**
   * WDA `hittable` of the element at `p`: the last element in document order (deepest / drawn last) whose frame
   * contains the point. XPath because WDA predicates cannot do the `x + width` arithmetic. Undefined when none.
   * `_target` is ignored: WDA answers for the element at a point and cannot test whether it is the one occupying a box.
   */
  async isHittable(p: Point, _target: Rect | null): Promise<boolean | undefined> {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const xpath = `(//*[not(self::XCUIElementTypeApplication or self::XCUIElementTypeWindow) and @x <= ${x} and @y <= ${y} and @x + @width >= ${x} and @y + @height >= ${y}])[last()]`;
    const id = await this.api.findElement({ using: 'xpath', value: xpath });
    if (!id) return undefined;
    return (await this.api.elementAttribute(id, 'hittable')) === 'true';
  }

  async startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void> {
    const bundleId = this.appId(app);
    this.logTarget = { app, sanitize };
    this.logs ??= new LogCapture('ios', this.deviceId);
    const exe = await iosAppExecutable(this.deviceId, bundleId);
    if (!exe) throw new Error(`${bundleId}의 실행 파일 이름을 알 수 없습니다.`);
    await this.logs.arm(`exec:${exe}`, 'xcrun', iosLogArgs(this.deviceId, exe), sanitize);
  }

  async crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]> {
    const bundleId = this.appId(app);
    const since = Date.parse(sinceIso);
    if (!existsSync(DIAGNOSTIC_REPORTS)) return [];
    const out: { name: string; content: string }[] = [];
    for (const name of readdirSync(DIAGNOSTIC_REPORTS)) {
      if (!name.endsWith('.ips')) continue;
      const file = join(DIAGNOSTIC_REPORTS, name);
      if (statSync(file).mtimeMs < since) continue;
      const content = readFileSync(file, 'utf8');
      if (ipsNamesApp(content, bundleId)) out.push({ name, content });
    }
    return out;
  }
}
