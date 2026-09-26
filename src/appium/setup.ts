// Project-local tool installation: pinned Appium drivers in .tools/appium, OCR helper, platform tool checks.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adbPath, PATHS } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import { run, xcrun } from './exec.ts';
import { APPIUM_MAIN } from './server.ts';

/** Driver name → exact version installed into APPIUM_HOME. */
export const PINNED_DRIVERS: Record<string, { pkg: string; version: string }> = {
  uiautomator2: { pkg: 'appium-uiautomator2-driver', version: '8.7.0' },
  xcuitest: { pkg: 'appium-xcuitest-driver', version: '12.13.2' },
};

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
