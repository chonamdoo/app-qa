// Project-local tool installation: pinned Appium drivers in .tools/appium, OCR helper, platform tool checks.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adbPath, PATHS } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import { run, xcrun } from './exec.ts';
import { APPIUM_MAIN } from './server.ts';

/** Driver name → exact version installed into APPIUM_HOME. */
export const PINNED_DRIVERS: Record<string, { pkg: string; version: string }> = {
  uiautomator2: { pkg: 'appium-uiautomator2-driver', version: '8.7.0' },
  xcuitest: { pkg: 'appium-xcuitest-driver', version: '12.13.2' },
  chromium: { pkg: 'appium-chromium-driver', version: '3.1.1' },
  safari: { pkg: 'appium-safari-driver', version: '5.0.10' },
};

/** chromedriver binaries appium-chromium-driver downloads per Chrome version (`appium:executableDir`). */
export const CHROMEDRIVER_DIR = join(PATHS.tools, 'chromedriver');

export type DesktopPlatform = 'desktop-chrome' | 'desktop-safari';

/** Each desktop browser: display name, app bundle (the location chromedriver / safaridriver launch) and its own WebDriver binary. */
export const DESKTOP_BROWSERS: Record<DesktopPlatform, { name: string; app: string; webdriver: string | null }> = {
  'desktop-chrome': { name: 'Chrome', app: '/Applications/Google Chrome.app', webdriver: null },
  'desktop-safari': { name: 'Safari', app: '/Applications/Safari.app', webdriver: '/usr/bin/safaridriver' },
};

/** Installed browser version from its bundle's Info.plist; null when it is not installed (or this is not macOS). */
export async function desktopBrowserVersion(platform: DesktopPlatform): Promise<string | null> {
  const plist = join(DESKTOP_BROWSERS[platform].app, 'Contents', 'Info.plist');
  if (process.platform !== 'darwin' || !existsSync(plist)) return null;
  const r = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { allowFail: true, timeoutMs: 10_000 });
  return (r.code === 0 && r.stdout.toString('utf8').trim()) || null;
}

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
  /** Fix hint shown when not ok. */
  hint?: string;
}

/** Prints a Korean checklist; returns true when every check passed. */
export function printChecks(checks: Check[], out: (line: string) => void = console.log): boolean {
  for (const c of checks) {
    out(`  ${c.ok ? '✓' : '✗'} ${c.label} — ${c.detail}`);
    if (!c.ok && c.hint) out(`      → ${c.hint}`);
  }
  return checks.every((c) => c.ok);
}

async function appiumCli(args: string[], timeoutMs: number): Promise<string> {
  const r = await run(process.execPath, [APPIUM_MAIN, ...args], { timeoutMs });
  return r.stdout.toString('utf8');
}

/** Installed driver versions read from APPIUM_HOME (no network, no appium CLI). */
export function installedDriverVersions(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, { pkg }] of Object.entries(PINNED_DRIVERS)) {
    const file = join(PATHS.appiumHome, 'node_modules', pkg, 'package.json');
    try {
      out[name] = (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

/** Installs/replaces drivers so APPIUM_HOME holds exactly the pinned versions. Idempotent. */
export async function installDrivers(log: (line: string) => void): Promise<Check[]> {
  ensureDir(PATHS.appiumHome);
  const listed = JSON.parse(await appiumCli(['driver', 'list', '--installed', '--json'], 120_000)) as Record<string, { version?: string; installed?: boolean }>;
  const checks: Check[] = [];
  for (const [name, { version }] of Object.entries(PINNED_DRIVERS)) {
    const current = listed[name]?.installed ? (listed[name]?.version ?? null) : null;
    if (current === version) {
      checks.push({ label: `Appium 드라이버 ${name}`, ok: true, detail: `${version} (이미 설치됨)` });
      continue;
    }
    try {
      if (current) {
        log(`${name} ${current} 제거 중 (고정 버전 ${version}로 교체)…`);
        await appiumCli(['driver', 'uninstall', name], 300_000);
      }
      log(`${name}@${version} 설치 중… (수 분 걸릴 수 있음)`);
      await appiumCli(['driver', 'install', `${name}@${version}`], 900_000);
      const now = installedDriverVersions()[name];
      checks.push({ label: `Appium 드라이버 ${name}`, ok: now === version, detail: now === version ? `${version} 설치 완료` : `설치 후 버전 불일치: ${now}` });
    } catch (err) {
      checks.push({ label: `Appium 드라이버 ${name}`, ok: false, detail: (err as Error).message.slice(0, 400), hint: '네트워크 확인 후 `qa setup` 재실행' });
    }
  }
  return checks;
}

export async function checkAdb(): Promise<Check> {
  const path = adbPath();
  if (!existsSync(path)) {
    return { label: 'adb', ok: false, detail: `${path} 없음`, hint: '.env의 ANDROID_HOME을 Android SDK 경로로 설정하세요' };
  }
  try {
    const out = (await run(path, ['version'], { timeoutMs: 10_000 })).stdout.toString('utf8');
    const version = /Android Debug Bridge version ([\d.]+)/.exec(out)?.[1] ?? '?';
    return { label: 'adb', ok: true, detail: `${version} (${path})` };
  } catch (err) {
    return { label: 'adb', ok: false, detail: (err as Error).message };
  }
}

export async function checkXcode(): Promise<Check> {
  try {
    const out = (await run('xcodebuild', ['-version'], { timeoutMs: 20_000 })).stdout.toString('utf8');
    await xcrun(['simctl', 'help'], { timeoutMs: 20_000 });
    return { label: 'Xcode', ok: true, detail: out.trim().split('\n').join(' ') };
  } catch (err) {
    return { label: 'Xcode', ok: false, detail: (err as Error).message.slice(0, 200), hint: 'Xcode 설치 후 `sudo xcode-select -s /Applications/Xcode.app` 실행' };
  }
}

/** How to let safaridriver control Safari (the user's own step: it needs admin rights). */
export const SAFARI_AUTOMATION_HINT =
  'Safari 설정 › 고급 › "웹 개발자용 기능 보기"를 켠 뒤 개발자 메뉴 › "원격 자동화 허용"을 선택하거나, 터미널에서 `sudo safaridriver --enable`을 한 번 실행하세요';

/**
 * Read-only readiness of the desktop browsers: Chrome installed (version), the pinned chromium/safari Appium drivers and
 * safaridriver. Whether Safari allows remote automation can only be proven by opening a session.
 */
export async function desktopBrowserChecks(): Promise<Check[]> {
  const [chrome, safari] = await Promise.all([desktopBrowserVersion('desktop-chrome'), desktopBrowserVersion('desktop-safari')]);
  const installed = installedDriverVersions();
  const checks: Check[] = [
    chrome
      ? { label: PLATFORM_INFO['desktop-chrome'].label, ok: true, detail: `Chrome ${chrome} (chromedriver는 첫 세션에서 ${CHROMEDRIVER_DIR}에 자동으로 받습니다)` }
      : { label: PLATFORM_INFO['desktop-chrome'].label, ok: false, detail: `${DESKTOP_BROWSERS['desktop-chrome'].app} 없음`, hint: 'Google Chrome을 /Applications에 설치하세요' },
  ];
  for (const name of ['chromium', 'safari']) {
    const { version } = PINNED_DRIVERS[name]!;
    const got = installed[name] ?? null;
    checks.push({ label: `Appium 드라이버 ${name}`, ok: got === version, detail: got === version ? version : `${got ?? '설치 안 됨'} (고정 버전 ${version})`, hint: '`qa setup` 실행' });
  }
  const safaridriver = DESKTOP_BROWSERS['desktop-safari'].webdriver!;
  const ready = safari !== null && existsSync(safaridriver);
  checks.push({
    label: PLATFORM_INFO['desktop-safari'].label,
    ok: ready,
    detail: ready ? `Safari ${safari}, ${safaridriver} 있음 — 원격 자동화 허용 여부는 세션을 열어야 확인됩니다 (${SAFARI_AUTOMATION_HINT})` : `${safari === null ? 'Safari' : safaridriver} 없음`,
    hint: 'Safari와 safaridriver는 macOS 기본 구성요소입니다. macOS에서 실행하세요',
  });
  return checks;
}
