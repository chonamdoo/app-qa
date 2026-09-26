// Android (UiAutomator2) driver. Host-side work (launch, logs, permissions, reset) goes through adb directly;
// every device-shell argument is single-quoted and every app id is validated first.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { unexpectedResponse } from '../appium/client.ts';
import { adb, adbShell, shq } from '../appium/exec.ts';
import type { ActionOutcome, AppTarget, RawNode, Rect, TypeOutcome } from '../core/types.ts';
import { parseAndroidSource } from '../observe/android.ts';
import { AppiumDriver, PERMISSION_GROUPS, RefusedError, type FieldValue, type Key, type LaunchOptions } from './base.ts';
import { androidLogArgs, LogCapture } from './logs.ts';

const KEYCODES: Record<Key, number> = { enter: 66, back: 4, tab: 61, escape: 111, delete: 67 };
const KEYCODE_PASTE = 279;

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

  /** ESC first; BACK only while the keyboard is still shown (the IME consumes it). Never an unconditional BACK. */
  async hideKeyboard(): Promise<ActionOutcome> {
    const t0 = performance.now();
    const o = await this.act(async () => {
      if (!(await this.keyboardShown())) return;
      await this.api.execute('mobile: pressKey', { keycode: KEYCODES.escape });
      if (!(await this.waitKeyboard(false, 1500))) return;
      if (!(await this.keyboardShown())) return;
      await this.api.execute('mobile: pressKey', { keycode: KEYCODES.back });
      if (await this.waitKeyboard(false, 1500)) throw new RefusedError('키보드가 닫히지 않았습니다');
    });
    return { ...o, ms: Math.round(performance.now() - t0) };
  }

  private async launchActivity(app: AppTarget): Promise<string> {
    const appId = this.appId(app);
    if (app.activity) return app.activity.startsWith('.') ? `${appId}/${app.activity}` : app.activity.includes('/') ? app.activity : `${appId}/${app.activity}`;
    const out = await adbShell(this.deviceId, ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', appId]);
    const component = out.trim().split('\n').pop()?.trim() ?? '';
    if (!component.includes('/')) throw new RefusedError(`${appId}의 실행 액티비티를 찾을 수 없습니다 (설치 여부 확인)`);
    return component;
  }

  /**
   * Runs a permission-changing device command and fails unless it exited 0 (or, when `skippable`, reported an
   * unchangeable permission). A requested permission state that was not applied is never ignored.
   */
  private async permissionCommand(argv: string[], skippable: boolean): Promise<void> {
    const out = await adb(this.deviceId, ['shell', `${argv.map(shq).join(' ')} 2>&1; echo "exit=$?"`]);
    if (/^exit=0$/m.test(out) || (skippable && UNCHANGEABLE_PERMISSION.test(out))) return;
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

  launch(app: AppTarget, opts: LaunchOptions = {}): Promise<ActionOutcome> {
    return this.act(async () => {
      const appId = this.appId(app);
      if (opts.permissions) await this.applyPermissions(appId, opts.permissions);
      const component = await this.launchActivity(app);
      assertAmStarted(await adbShell(this.deviceId, ['am', 'start', '-W', '-n', component, ...(opts.arguments ?? [])], { timeoutMs: 60_000 }));
      if (this.logTarget?.app.appId === appId) await this.startLogs(app, this.logTarget.sanitize);
    });
  }

  terminate(app: AppTarget): Promise<ActionOutcome> {
    return this.act(async () => {
      await adbShell(this.deviceId, ['am', 'force-stop', this.appId(app)]);
    });
  }

  protected async clearData(app: AppTarget): Promise<void> {
    const out = await adbShell(this.deviceId, ['pm', 'clear', this.appId(app)]);
    if (!/Success/.test(out)) throw new Error(`pm clear 실패: ${out.trim()}`);
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

  openUrl(app: AppTarget, url: string): Promise<ActionOutcome> {
    return this.act(async () => {
      const appId = this.appId(app);
      assertAmStarted(await adbShell(this.deviceId, ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, appId], { timeoutMs: 60_000 }));
    });
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
    const pkg = await this.api.execute('mobile: getCurrentPackage');
    if (pkg !== null && typeof pkg !== 'string') throw unexpectedResponse('mobile: getCurrentPackage', pkg);
    return pkg || null;
  }

  /** logcat for the app's current pid (re-armed after every launch); falls back to the app uid when it is not running. */
  async startLogs(app: AppTarget, sanitize: (line: string) => string): Promise<void> {
    const appId = this.appId(app);
    this.logTarget = { app, sanitize };
    this.logs ??= new LogCapture('android', this.deviceId);
    const pid = (await adbShell(this.deviceId, ['pidof', appId], { allowFail: true })).trim().split(/\s+/)[0] ?? '';
    const since = Date.now() - 30_000;
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
    const since = Date.parse(sinceIso);
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
