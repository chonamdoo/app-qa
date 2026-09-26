// Android (UiAutomator2) driver. Host-side work (launch, logs, permissions, reset) goes through adb directly;
// every device-shell argument is single-quoted and every app id is validated first.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unexpectedResponse } from '../appium/client.ts';
import { adb, adbShell, shq } from '../appium/exec.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { ActionOutcome, AppTarget, NativeTarget, RawNode, Rect, TypeOutcome, WebTarget } from '../core/types.ts';
import { parseAndroidSource } from '../observe/android.ts';
import { navigationProblem } from './appid.ts';
import { AppiumDriver, assertNoWebLaunchOptions, PERMISSION_GROUPS, RefusedError, StepError, type FieldValue, type Key, type LaunchOptions } from './base.ts';
import { androidChromeChecks, prepareAndroidChrome, readinessProblem } from './browser-prep.ts';
import { androidLogArgs, LogCapture } from './logs.ts';

const KEYCODES: Record<Key, number> = { enter: 66, back: 4, tab: 61, escape: 111, delete: 67 };
const KEYCODE_PASTE = 279;

/** Chrome loads VIEW intents that carry the same browser application id into the same tab. */
const CHROME_TAB_OWNER = 'app-qa';

/** `adb reverse --list` lines (`<transport> <device spec> <host spec>`) → device spec → host spec. */
function reverseMappings(out: string): Map<string, string> {
  return new Map([...out.matchAll(/^\S+\s+(\S+)\s+(\S+)\s*$/gm)].map((m) => [m[1]!, m[2]!]));
}

/** `am start` exits 0 even when it fails; failures are reported on stdout. */
function assertAmStarted(out: string): void {
  if (/^Error|Exception|Error type \d|unable to resolve|does not exist/im.test(out)) throw new RefusedError(`am start 실패: ${out.trim().split('\n').slice(-2).join(' ')}`);
}

/** Permissions the app never requested (or unknown on this API level) cannot be changed: those are skipped. */
const UNCHANGEABLE_PERMISSION = /has not requested|Unknown permission|not a changeable permission type/i;

/** Soft keyboard visibility from `dumpsys window InputMethod` (the IME window's `isVisible` / surface state). */
export function imeVisible(dump: string): boolean {
  return /^\s*isVisible=true\b/m.test(dump) || /^\s*Surface: shown=true\b/m.test(dump);
}

/** Groups `logcat -b crash -v threadtime -v UTC -v year` lines by pid and keeps groups since `sinceMs` that mention the app. */
export function crashBlocks(text: string, appId: string, sinceMs: number): string {
  const byPid = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) \+0000\s+(\d+)\s+\d+/.exec(line);
    if (!m || Date.parse(`${m[1]}T${m[2]}Z`) < sinceMs) continue;
    const list = byPid.get(m[3]!) ?? [];
    list.push(line);
    byPid.set(m[3]!, list);
  }
  return [...byPid.values()]
    .filter((lines) => lines.some((l) => l.includes(appId)))
    .map((lines) => lines.join('\n'))
    .join('\n\n');
}

export class AndroidDriver extends AppiumDriver {
  readonly platform = 'android' as const;
  protected readonly depthLimit = 70; // UiAutomator2 default snapshotMaxDepth
  protected readonly keyboardInSource = false; // the IME is a separate window, absent with enableMultiWindows:false
  protected readonly browserChecks = androidChromeChecks;
  protected readonly addressBarId = `${PLATFORM_INFO.android.browser}:id/url_bar`;
  /** `adb reverse` device specs (`tcp:P`) this driver created; `close` removes them, never a mapping it only reused. */
  private readonly ownedReverse = new Set<string>();
  /** Device clock minus host clock (ms), from the last `measureClockOffset`; null until measured. */
  private clockOffsetMs: number | null = null;

  protected capabilities(_app: AppTarget): Record<string, unknown> {
    return {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': this.deviceId,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:newCommandTimeout': 600,
    };
  }

  protected settings(): Record<string, unknown> {
    // Idle waiting is the runner's settle loop's job; UIA2's own wait costs 0.6–1 s per command on busy RN screens.
    return { enableMultiWindows: false, waitForIdleTimeout: 0 };
  }

  protected parse(xml: string, screen: Rect): RawNode[] {
    return parseAndroidSource(xml, screen);
  }

  protected sourceFacts(xml: string): { foregroundApp: string | null; keyboardShown: boolean | null } {
    return { foregroundApp: /\bpackage="([^"]+)"/.exec(xml)?.[1] ?? null, keyboardShown: null };
  }

  /** Host-side `dumpsys window InputMethod` (~30 ms, runs beside /source instead of queueing behind it in the session). */
  protected async keyboardShown(): Promise<boolean> {
    return imeVisible(await adbShell(this.deviceId, ['dumpsys', 'window', 'InputMethod'], { timeoutMs: 10_000 }));
  }

  protected async focusedElement(): Promise<string | null> {
    return (await this.api.activeElement()) ?? this.api.findElement({ using: '-android uiautomator', value: 'new UiSelector().focused(true)' });
  }

  /** An empty field may report its hint as text (`showing-hint` is not readable via UIA2 8.7.0 attributes). */
  protected async readField(id: string): Promise<FieldValue> {
    const [raw, hint] = await Promise.all([this.api.elementText(id), this.api.elementAttribute(id, 'hint')]);
    const text = raw ?? '';
    return { value: hint && text === hint ? '' : text, raw: text };
  }

  protected async fallbackType(_id: string, text: string): Promise<TypeOutcome['path']> {
    await this.api.execute('mobile: setClipboard', { content: Buffer.from(text, 'utf8').toString('base64'), contentType: 'plaintext' });
    await this.api.execute('mobile: pressKey', { keycode: KEYCODE_PASTE });
    return 'clipboard';
  }

  press(key: Key): Promise<ActionOutcome> {
    return this.act(async () => {
      await this.api.execute('mobile: pressKey', { keycode: KEYCODES[key] });
    });
  }

  back(): Promise<ActionOutcome> {
    return this.press('back');
  }

  /**
   * BACK only while the keyboard is shown (the IME consumes it); never an unconditional BACK. Apps try ESC first. Web
   * pages never get ESC: it reaches the page (Chrome clears a `type=search` field on Escape, pages close dialogs on it).
   * On web pages the keyboard is checked again right before BACK, and the address bar is compared around it: if the
   * keyboard closed in between, BACK reached Chrome and navigated — `uncertain`, never `completed`.
   */
  async hideKeyboard(): Promise<ActionOutcome> {
    const t0 = performance.now();
    const o = await this.act(async () => {
      if (!(await this.keyboardShown())) return;
      if (this.opened?.kind !== 'web') {
        await this.api.execute('mobile: pressKey', { keycode: KEYCODES.escape });
        if (!(await this.waitKeyboard(false, 1500))) return;
        if (!(await this.keyboardShown())) return;
        await this.api.execute('mobile: pressKey', { keycode: KEYCODES.back });
        if (await this.waitKeyboard(false, 1500)) throw new RefusedError('키보드가 닫히지 않았습니다');
        return;
      }
      const before = await this.addressBarText();
      if (!(await this.keyboardShown())) return;
      await this.api.execute('mobile: pressKey', { keycode: KEYCODES.back });
      const stillShown = await this.waitKeyboard(false, 1500);
      // A back navigation updates the address bar on commit, shortly after the key.
      let after = await this.addressBarText();
      for (const end = Date.now() + 500; after === before && Date.now() < end; after = await this.addressBarText()) await delay(100);
      if (after !== before) throw new StepError({ status: 'uncertain', ms: 0, error: `키보드 닫기 중 페이지 이동 발생 (주소 ${JSON.stringify(before)} → ${JSON.stringify(after)})` });
      if (stillShown) throw new RefusedError('키보드가 닫히지 않았습니다');
    });
    return { ...o, ms: Math.round(performance.now() - t0) };
  }

  /** Chrome's address bar text, or null when it is not on screen (toolbar scrolled away, Chrome left). */
  private async addressBarText(): Promise<string | null> {
    const [id] = await this.api.findElements({ using: 'id', value: this.addressBarId });
    return id ? this.api.elementText(id) : null;
  }

  private async launchActivity(app: NativeTarget): Promise<string> {
    const appId = this.appId(app);
    if (app.activity) return app.activity.startsWith('.') ? `${appId}/${app.activity}` : app.activity.includes('/') ? app.activity : `${appId}/${app.activity}`;
    const out = await adbShell(this.deviceId, ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', appId]);
    const component = out.trim().split('\n').pop()?.trim() ?? '';
    if (!component.includes('/')) throw new RefusedError(`${appId}의 실행 액티비티를 찾을 수 없습니다 (설치 여부 확인)`);
    return component;
  }

  /**
   * Runs a permission-changing device command and fails unless it exited 0 (or, when `skippable`, reported an
   * unchangeable permission). A requested permission state that was not applied is never ignored. Output without the
   * trailing exit status (stream cut) or with a signal status (≥ 128, e.g. 137 = SIGKILL) means the command may have
   * run: `uncertain`, checked before any refusal.
   */
  private async permissionCommand(argv: string[], skippable: boolean): Promise<void> {
    const out = await adb(this.deviceId, ['shell', `${argv.map(shq).join(' ')} 2>&1; echo "exit=$?"`]);
    const exit = [...out.matchAll(/^exit=(\d+)$/gm)].at(-1)?.[1];
    if (exit === undefined) throw new Error(`${argv.slice(0, 3).join(' ')}: 종료 상태를 받지 못했습니다 (기기 연결 끊김 가능)`);
    if (Number(exit) >= 128) throw new Error(`${argv.slice(0, 3).join(' ')}: 신호로 종료되었습니다 (exit=${exit}, 적용 여부 불명)`);
    if (exit === '0' || (skippable && UNCHANGEABLE_PERMISSION.test(out))) return;
    throw new RefusedError(`${argv.slice(0, 3).join(' ')} 실패: ${out.trim().split('\n').slice(-2).join(' ')}`);
  }

  private async applyPermissions(appId: string, permissions: Record<string, 'allow' | 'deny' | 'unset'>): Promise<void> {
    for (const [name, state] of Object.entries(permissions)) {
      const group = name === 'all' ? { android: Object.values(PERMISSION_GROUPS).flatMap((g) => g.android), appops: ['FINE_LOCATION', 'COARSE_LOCATION'] } : PERMISSION_GROUPS[name];
      const perms = group?.android ?? (name.includes('.') ? [name] : null);
      if (!perms) throw new RefusedError(`알 수 없는 권한 이름: ${name}`);
      for (const perm of new Set(perms)) {
        await this.permissionCommand(['pm', state === 'allow' ? 'grant' : 'revoke', appId, perm], true);
        if (state === 'unset') await this.permissionCommand(['pm', 'clear-permission-flags', appId, perm, 'user-set', 'user-fixed'], true);
      }
      for (const op of group?.appops ?? []) {
        await this.permissionCommand(['cmd', 'appops', 'set', appId, op, state === 'allow' ? 'allow' : state === 'deny' ? 'ignore' : 'default'], false);
      }
    }
  }

  /**
   * Routes the device's localhost ports of `urls` (localhost / 127.0.0.1, scheme default port when absent) to the same
   * host ports with `adb reverse tcp:P tcp:P`. An identical existing mapping is reused without taking ownership; one
   * pointing elsewhere is refused, never rebound. Created mappings are recorded for `close`.
   */
  private async ensureReverse(urls: readonly string[]): Promise<void> {
    const specs = new Set<string>();
    for (const url of urls) {
      const u = new URL(url);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') specs.add(`tcp:${u.port || (u.protocol === 'https:' ? 443 : 80)}`);
    }
    if (specs.size === 0) return;
    const current = reverseMappings(await adb(this.deviceId, ['reverse', '--list'], { timeoutMs: 15_000 }));
    for (const spec of specs) {
      const to = current.get(spec);
      if (to === spec) continue;
      if (to !== undefined) throw new RefusedError(`기기 포트 ${spec}가 이미 호스트 ${to}로 연결되어 있어 바꾸지 않습니다 (adb reverse). 그 연결을 쓰는 도구를 먼저 정리하세요.`);
      await adb(this.deviceId, ['reverse', '--no-rebind', spec, spec], { timeoutMs: 15_000 });
      this.ownedReverse.add(spec);
    }
  }

  /** Loads `url` in Chrome's app-qa tab (reused across calls) after routing the target's localhost ports to the host. */
  private async viewInChrome(target: WebTarget, url: string): Promise<void> {
    await this.ensureReverse([url, ...target.origins]);
    const intent = ['-a', 'android.intent.action.VIEW', '-d', url, '-p', target.appId, '--es', 'com.android.browser.application_id', CHROME_TAB_OWNER];
    assertAmStarted(await adbShell(this.deviceId, ['am', 'start', '-W', ...intent], { timeoutMs: 60_000 }));
  }

  launch(app: AppTarget, opts: LaunchOptions = {}): Promise<ActionOutcome> {
    return this.act(async () => {
      const appId = this.appId(app);
      if (app.kind === 'web') {
        assertNoWebLaunchOptions(opts);
        await this.viewInChrome(app, app.url);
      } else {
        if (opts.permissions) await this.applyPermissions(appId, opts.permissions);
        const component = await this.launchActivity(app);
        assertAmStarted(await adbShell(this.deviceId, ['am', 'start', '-W', '-n', component, ...(opts.arguments ?? [])], { timeoutMs: 60_000 }));
      }
      if (this.logTarget?.app.appId === appId) await this.startLogs(app, this.logTarget.sanitize);
    });
  }

  terminate(app: AppTarget): Promise<ActionOutcome> {
    return this.act(async () => {
      await adbShell(this.deviceId, ['am', 'force-stop', this.appId(app)]);
    });
  }

  /** `pm clear`; for Chrome the automation prep runs again (it is part of the declared browser environment). */
  protected async clearData(app: AppTarget): Promise<void> {
    const out = await adbShell(this.deviceId, ['pm', 'clear', this.appId(app)]);
    if (!/Success/.test(out)) throw new Error(`pm clear 실패: ${out.trim()}`);
    if (app.kind !== 'web') return;
    const problem = readinessProblem(PLATFORM_INFO.android.webLabel, await prepareAndroidChrome(this.deviceId));
    if (problem) throw new Error(`Chrome 데이터를 지운 뒤 ${problem}`);
  }

  protected async reinstall(app: AppTarget, binary: string): Promise<void> {
    await adb(this.deviceId, ['uninstall', this.appId(app)], { timeoutMs: 120_000, allowFail: true });
    if (binary.endsWith('.apks')) {
      const parts = readdirSync(binary).filter((f) => f.endsWith('.apk')).map((f) => join(binary, f));
      await adb(this.deviceId, ['install-multiple', '-r', '-d', ...parts], { timeoutMs: 600_000 });
    } else {
      await adb(this.deviceId, ['install', '-r', '-d', binary], { timeoutMs: 600_000 });
    }
  }

  /** Web: loads an allowed-origin http(s) URL in the app-qa Chrome tab. App: VIEW intent (deep link) to the app. */
  openUrl(app: AppTarget, url: string): Promise<ActionOutcome> {
    return this.act(async () => {
      const appId = this.appId(app);
      if (app.kind === 'web') {
        const problem = navigationProblem(app, url);
        if (problem) throw new RefusedError(problem);
        await this.viewInChrome(app, new URL(url).href);
        return;
      }
      assertAmStarted(await adbShell(this.deviceId, ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, appId], { timeoutMs: 60_000 }));
    });
  }

  /** Removes the reverse mappings this driver created that still point where it set them, then closes the session. */
  async close(): Promise<void> {
    const owned = [...this.ownedReverse];
    this.ownedReverse.clear();
    if (owned.length > 0) {
      // A device that cannot list its mappings has lost them with the transport.
      const current = await adb(this.deviceId, ['reverse', '--list'], { timeoutMs: 15_000 }).then(reverseMappings, () => new Map<string, string>());
      for (const spec of owned) {
        if (current.get(spec) === spec) await adb(this.deviceId, ['reverse', '--remove', spec], { timeoutMs: 15_000, allowFail: true }).catch(() => undefined);
      }
    }
    await super.close();
  }

  setLocation(lat: number, lon: number): Promise<ActionOutcome> {
    return this.act(async () => {
      if (!this.deviceId.startsWith('emulator-')) throw new RefusedError('위치 설정은 에뮬레이터에서만 지원합니다 (adb emu geo fix)');
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new RefusedError('위도/경도가 올바르지 않습니다');
      const out = await adb(this.deviceId, ['emu', 'geo', 'fix', String(lon), String(lat)], { timeoutMs: 15_000 });
      if (/KO/.test(out)) throw new RefusedError(`geo fix 실패: ${out.trim()}`);
    });
  }

  async foregroundApp(): Promise<string | null> {
    const pkg = await this.api.query('mobile: getCurrentPackage');
    if (pkg !== null && typeof pkg !== 'string') throw unexpectedResponse('mobile: getCurrentPackage', pkg);
    return pkg || null;
  }

  /**
   * Device clock minus host clock (ms), from `date` on the device bracketed by host timestamps (midpoint). logcat stamps
   * and ANR mtimes are device time; emulator clocks drift seconds away from the host. `%N` missing → second precision.
   */
  private async measureClockOffset(): Promise<number> {
    const t0 = Date.now();
    const out = (await adbShell(this.deviceId, ['date', '+%s.%N'], { timeoutMs: 15_000 })).trim();
    const t1 = Date.now();
    const m = /^(\d+)(?:\.(\d+))?/.exec(out);
    if (!m) throw new Error(`기기 시계를 읽지 못했습니다: ${JSON.stringify(out.slice(0, 80))}`);
    const device = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0').slice(0, 3));
    this.clockOffsetMs = Math.round(device - (t0 + t1) / 2);
    return this.clockOffsetMs;
  }

  /** logcat for the app's current pid (re-armed after every launch); falls back to the app uid when it is not running. Slices shift by the device clock offset. */
  async startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void> {
    const appId = this.appId(app);
    this.logTarget = { app, sanitize };
    this.logs ??= new LogCapture('android', this.deviceId);
    this.logs.clockOffsetMs = await this.measureClockOffset();
    const pid = (await adbShell(this.deviceId, ['pidof', appId], { allowFail: true })).trim().split(/\s+/)[0] ?? '';
    const since = Date.now() + this.logs.clockOffsetMs - 30_000;
    if (/^\d+$/.test(pid)) {
      await this.logs.arm(`pid:${pid}`, 'adb', androidLogArgs(this.deviceId, { pid }, since), sanitize);
      return;
    }
    const uid = /uid:(\d+)/.exec(await adbShell(this.deviceId, ['pm', 'list', 'packages', '-U', appId]))?.[1];
    if (!uid) throw new Error(`${appId}가 설치되어 있지 않습니다.`);
    await this.logs.arm(`uid:${uid}`, 'adb', androidLogArgs(this.deviceId, { uid }, since), sanitize);
  }

  async crashArtifacts(app: AppTarget, sinceIso: string): Promise<{ name: string; content: string }[]> {
    const appId = this.appId(app);
    const since = Date.parse(sinceIso) + (this.clockOffsetMs ?? (await this.measureClockOffset()));
    const out: { name: string; content: string }[] = [];
    const crash = await adb(this.deviceId, ['logcat', '-b', 'crash', '-d', '-v', 'threadtime', '-v', 'UTC', '-v', 'year'], { allowFail: true, timeoutMs: 30_000 });
    const blocks = crashBlocks(crash, appId, since);
    if (blocks) out.push({ name: 'logcat-crash.txt', content: blocks });
    // /data/anr is readable on emulator/userdebug images only.
    const listing = await adb(this.deviceId, ['shell', 'for f in /data/anr/*; do [ -r "$f" ] && echo "$(stat -c %Y "$f") $f"; done 2>/dev/null'], { allowFail: true });
    for (const m of listing.matchAll(/^(\d+) (\/data\/anr\/\S+)$/gm)) {
      if (Number(m[1]) * 1000 < since) continue;
      const content = await adbShell(this.deviceId, ['cat', m[2]!], { allowFail: true, timeoutMs: 30_000 });
      if (content.includes(`Cmd line: ${appId}`)) out.push({ name: m[2]!.split('/').pop()!, content });
    }
    return out;
  }
}
