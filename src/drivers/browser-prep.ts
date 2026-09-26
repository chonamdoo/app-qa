// Device browsers for web profiles. Android Chrome skips its first-run screens only with command-line flags, and Chrome
// reads /data/local/tmp/chrome-command-line only while it is the debug app; notifications are granted so their prompt
// never covers the page. `qa setup --browsers` prepares (`prepareAndroidChrome`); `qa doctor` and the drivers' `open`
// only check (`androidChromeChecks`, `iosSafariChecks`). Nothing here runs with sudo or touches another app.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adb, adbShell, run, xcrun } from '../appium/exec.ts';
import type { Check } from '../appium/setup.ts';
import { PLATFORM_INFO } from '../core/platform.ts';

const CHROME = PLATFORM_INFO.android.browser;
const SAFARI = PLATFORM_INFO.ios.browser;
export const CHROME_COMMAND_LINE = '/data/local/tmp/chrome-command-line';
/** Flags that skip Chrome's first-run, sign-in and default-browser screens. The file's first token is the program name (ignored). */
export const CHROME_FLAGS = ['--disable-fre', '--no-first-run', '--no-default-browser-check'] as const;
const NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';
/** POST_NOTIFICATIONS is a runtime permission from Android 13 (API 33); older devices never prompt. */
const NOTIFICATIONS_API = 33;

interface ChromeState {
  /** Installed and enabled for user 0. */
  installed: boolean;
  version: string | null;
  sdk: number;
  notificationsGranted: boolean;
  debugApp: string;
  /** Command-line file tokens; null when the file does not exist. */
  commandLine: string[] | null;
}

/** Active (not the hidden system copy) package block of `dumpsys package <pkg>`, or null when the package is unknown. */
function activePackageBlock(dump: string, pkg: string): string | null {
  const start = dump.search(/^Packages:$/m);
  if (start < 0) return null;
  const end = dump.slice(start).search(/^Hidden system packages:$/m);
  const block = end < 0 ? dump.slice(start) : dump.slice(start, start + end);
  return block.includes(`Package [${pkg}]`) ? block : null;
}

async function chromeState(serial: string): Promise<ChromeState> {
  const [dump, sdk, debugApp, commandLine] = await Promise.all([
    adbShell(serial, ['dumpsys', 'package', CHROME], { timeoutMs: 30_000 }),
    adbShell(serial, ['getprop', 'ro.build.version.sdk'], { timeoutMs: 15_000 }),
    adbShell(serial, ['settings', 'get', 'global', 'debug_app'], { timeoutMs: 15_000 }),
    adb(serial, ['shell', `cat ${CHROME_COMMAND_LINE} 2>/dev/null || echo __missing__`], { timeoutMs: 15_000 }),
  ]);
  const block = activePackageBlock(dump, CHROME);
  return {
    installed: block !== null && /^\s*User 0:.*\binstalled=true\b.*\benabled=[01]\b/m.test(block),
    version: block ? (/^\s*versionName=(\S+)/m.exec(block)?.[1] ?? null) : null,
    sdk: Number(sdk.trim()),
    notificationsGranted: block !== null && new RegExp(`^\\s*${NOTIFICATIONS.replaceAll('.', '\\.')}: granted=true\\b`, 'm').test(block),
    debugApp: debugApp.trim(),
    commandLine: commandLine.trim() === '__missing__' ? null : commandLine.trim().split(/\s+/).filter(Boolean),
  };
}

/** Read-only readiness of Android Chrome for web tests (`qa doctor`, the driver's `open`). */
export async function androidChromeChecks(serial: string): Promise<Check[]> {
  const hint = `\`qa setup --browsers --android ${serial}\` 실행`;
  let s: ChromeState;
  try {
    s = await chromeState(serial);
  } catch (err) {
    return [{ label: 'Android Chrome', ok: false, detail: `${serial} 상태를 읽지 못했습니다: ${(err as Error).message.slice(0, 300)}`, hint: '기기 연결(adb devices) 확인' }];
  }
  if (!s.installed) return [{ label: 'Android Chrome', ok: false, detail: `${CHROME}가 설치(또는 활성화)되어 있지 않습니다`, hint: 'Google Play가 있는 에뮬레이터 이미지를 쓰거나 Chrome을 설치하세요' }];
  const missing = CHROME_FLAGS.filter((f) => !s.commandLine?.includes(f));
  const notificationsNeeded = s.sdk >= NOTIFICATIONS_API;
  return [
    { label: 'Android Chrome', ok: true, detail: `${CHROME} ${s.version ?? '(버전 모름)'}` },
    {
      label: 'Chrome 디버그 앱 지정',
      ok: s.debugApp === CHROME,
      detail: s.debugApp === CHROME ? CHROME : `현재 debug_app=${s.debugApp || '(없음)'} — Chrome이 명령줄 파일을 읽지 않습니다`,
      hint,
    },
    {
      label: 'Chrome 명령줄 플래그',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${CHROME_COMMAND_LINE}: ${CHROME_FLAGS.join(' ')}` : `${CHROME_COMMAND_LINE}에 없음: ${missing.join(' ')}`,
      hint,
    },
    {
      label: 'Chrome 알림 권한',
      ok: !notificationsNeeded || s.notificationsGranted,
      detail: !notificationsNeeded ? `해당 없음 (API ${s.sdk} < ${NOTIFICATIONS_API})` : s.notificationsGranted ? '허용됨 (알림 안내 창이 뜨지 않음)' : '허용되지 않음 — 알림 안내 창이 페이지를 가립니다',
      hint,
    },
  ];
}

/**
 * Prepares Android Chrome for web tests, idempotently: debug app = Chrome (persistent), command-line flags present
 * (flags already in the file are kept), notifications granted. Chrome is force-stopped only when its flags or debug
 * app changed, so the next start reads them. Returns the read-only checks taken afterwards (plus any failed step).
 */
export async function prepareAndroidChrome(serial: string): Promise<Check[]> {
  // An unreadable device or a missing Chrome changes nothing; the read-only checks report why.
  const before = await chromeState(serial).catch(() => null);
  if (!before?.installed) return androidChromeChecks(serial);
  const failed: Check[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      failed.push({ label, ok: false, detail: (err as Error).message.slice(0, 300) });
    }
  };
  let restart = false;
  if (before.debugApp !== CHROME) {
    restart = true;
    await step('Chrome 디버그 앱 지정', () => adbShell(serial, ['am', 'set-debug-app', '--persistent', CHROME], { timeoutMs: 15_000 }));
  }
  const missing = CHROME_FLAGS.filter((f) => !before.commandLine?.includes(f));
  if (missing.length > 0) {
    restart = true;
    const tokens = before.commandLine?.length ? [...before.commandLine, ...missing] : ['_', ...CHROME_FLAGS];
    await step('Chrome 명령줄 플래그', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'qa-chrome-flags-'));
      try {
        writeFileSync(join(dir, 'chrome-command-line'), `${tokens.join(' ')}\n`);
        await adb(serial, ['push', join(dir, 'chrome-command-line'), CHROME_COMMAND_LINE], { timeoutMs: 30_000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  if (before.sdk >= NOTIFICATIONS_API && !before.notificationsGranted) {
    await step('Chrome 알림 권한', () => adbShell(serial, ['pm', 'grant', CHROME, NOTIFICATIONS], { timeoutMs: 15_000 }));
  }
  if (restart) await step('Chrome 재시작', () => adbShell(serial, ['am', 'force-stop', CHROME], { timeoutMs: 15_000 }));
  return [...failed, ...(await androidChromeChecks(serial))];
}

/** Read-only readiness of iOS Safari: the UDID is a booted simulator (physical devices are not supported) with Safari. */
export async function iosSafariChecks(udid: string): Promise<Check[]> {
  let state: string | null = null;
  try {
    const parsed = JSON.parse(await xcrun(['simctl', 'list', '-j', 'devices'], { timeoutMs: 30_000 })) as { devices?: Record<string, { udid: string; state: string }[]> };
    state = Object.values(parsed.devices ?? {}).flat().find((d) => d.udid === udid)?.state ?? null;
  } catch (err) {
    return [{ label: 'iOS 시뮬레이터', ok: false, detail: `simctl 목록을 읽지 못했습니다: ${(err as Error).message.slice(0, 300)}`, hint: '`qa doctor`로 Xcode 확인' }];
  }
  if (state === null) return [{ label: 'iOS 시뮬레이터', ok: false, detail: `${udid}는 시뮬레이터가 아닙니다 — iOS Safari 웹 테스트는 시뮬레이터에서만 지원합니다` }];
  if (state !== 'Booted') return [{ label: 'iOS 시뮬레이터', ok: false, detail: `${udid}가 부팅되어 있지 않습니다 (상태: ${state})`, hint: `\`xcrun simctl boot ${udid}\` 실행` }];
  const checks: Check[] = [{ label: 'iOS 시뮬레이터', ok: true, detail: `${udid} (부팅됨)` }];
  try {
    const app = (await xcrun(['simctl', 'get_app_container', udid, SAFARI, 'app'], { timeoutMs: 30_000 })).trim();
    const version = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Info.plist')], { timeoutMs: 10_000, allowFail: true });
    checks.push({ label: 'iOS Safari', ok: true, detail: `${SAFARI} ${version.code === 0 ? version.stdout.toString('utf8').trim() : '(버전 모름)'}` });
  } catch (err) {
    checks.push({ label: 'iOS Safari', ok: false, detail: `${udid}에서 ${SAFARI}를 찾지 못했습니다: ${(err as Error).message.slice(0, 300)}` });
  }
  return checks;
}

/** Korean refusal for failed readiness checks (each with its fix hint), or null when every check passed. */
export function readinessProblem(what: string, checks: Check[]): string | null {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return null;
  return `${what} 준비가 되지 않았습니다: ${failed.map((c) => `${c.label} — ${c.detail}${c.hint ? ` (→ ${c.hint})` : ''}`).join('; ')}`;
}
