// Installed user apps: Android `pm list packages -3` (+ label via host aapt2, cached), iOS `simctl listapps` User apps.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { adb, adbShell, run, xcrun } from '../appium/exec.ts';
import { androidHome, PATHS } from '../core/config.ts';
import { ensureDir, writeJsonAtomic } from '../core/fsx.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Platform } from '../core/types.ts';

export interface AppInfo {
  platform: Platform;
  appId: string;
  label: string | null;
  version: string | null;
}

/** Automation infrastructure installed by Appium itself; never offered as a test target. */
const INFRA_PREFIXES = ['io.appium.', 'com.facebook.WebDriverAgentRunner'];

export interface AndroidPackageLine {
  appId: string;
  apkPath: string;
  versionCode: string | null;
}

/** Parses `pm list packages -3 -f --show-versioncode` (APK paths may contain `=` from base64 dir names). */
export function parsePmPackages(out: string): AndroidPackageLine[] {
  const list: AndroidPackageLine[] = [];
  for (const m of out.matchAll(/^package:(.+)=([A-Za-z0-9_.]+)(?: versionCode:(\d+))?\s*$/gm)) {
    list.push({ apkPath: m[1]!, appId: m[2]!, versionCode: m[3] ?? null });
  }
  return list;
}

/** Picks the label for the device locale from `aapt2 dump badging` output (e.g. application-label-ko), else the default. */
export function parseBadging(out: string, locale: string): { label: string | null; versionName: string | null } {
  const lang = locale.split(/[-_]/)[0]?.toLowerCase() ?? '';
  const exact = new RegExp(`^application-label-${locale.replace('_', '-')}:'(.*)'$`, 'm').exec(out);
  const byLang = lang ? new RegExp(`^application-label-${lang}:'(.*)'$`, 'm').exec(out) : null;
  const fallback = /^application-label:'(.*)'$/m.exec(out);
  const versionName = /^package: .*versionName='([^']*)'/m.exec(out)?.[1] ?? null;
  return { label: exact?.[1] ?? byLang?.[1] ?? fallback?.[1] ?? null, versionName: versionName || null };
}

/** Parses `simctl listapps` (converted to JSON by plutil): User apps only. */
export function parseSimctlApps(json: string): AppInfo[] {
  const apps = JSON.parse(json) as Record<string, Record<string, string | undefined>>;
  return Object.entries(apps)
    .filter(([, a]) => a.ApplicationType === 'User')
    .map(([appId, a]) => ({
      platform: 'ios' as const,
      appId,
      label: a.CFBundleDisplayName ?? a.CFBundleName ?? null,
      version: a.CFBundleShortVersionString ?? a.CFBundleVersion ?? null,
    }));
}

function aapt2(): string | null {
  const dir = join(androidHome(), 'build-tools');
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((v) => existsSync(join(dir, v, 'aapt2')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions[0] ? join(dir, versions[0], 'aapt2') : null;
}

const LABEL_CACHE = join(PATHS.appBackups, 'labels.json');

type LabelCache = Record<string, { label: string | null; versionName: string | null }>;

/** Labels need the APK's resources; the base APK is pulled once per install path (path changes on every install) and cached. */
async function androidLabels(deviceId: string, pkgs: AndroidPackageLine[]): Promise<LabelCache> {
  let cache: LabelCache = {};
  try {
    cache = JSON.parse(readFileSync(LABEL_CACHE, 'utf8')) as LabelCache;
  } catch {
    // first run
  }
  const tool = aapt2();
  const todo = pkgs.filter((p) => !(p.apkPath in cache));
  if (!tool || todo.length === 0) return cache;
  const locale = (await adbShell(deviceId, ['getprop', 'persist.sys.locale'])).trim() || 'en-US';
  ensureDir(PATHS.appBackups);
  const tmp = mkdtempSync(join(PATHS.appBackups, '.labels-'));
  try {
    for (const p of todo) {
      const local = join(tmp, `${p.appId}.apk`);
      try {
        await adb(deviceId, ['pull', p.apkPath, local], { timeoutMs: 300_000 });
        const out = (await run(tool, ['dump', 'badging', local], { timeoutMs: 60_000, allowFail: true })).stdout.toString('utf8');
        cache[p.apkPath] = parseBadging(out, locale);
      } finally {
        rmSync(local, { force: true });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeJsonAtomic(LABEL_CACHE, cache);
  return cache;
}

/** User-installed apps (Appium/WDA helpers excluded), sorted by appId. Desktop browsers have no installed apps: refused. */
export async function listApps(platform: Platform, deviceId: string): Promise<AppInfo[]> {
  let apps: AppInfo[];
  switch (platform) {
    case 'android': {
      const pkgs = parsePmPackages(await adbShell(deviceId, ['pm', 'list', 'packages', '-3', '-f', '--show-versioncode'])).filter(
        (p) => !INFRA_PREFIXES.some((x) => p.appId.startsWith(x)),
      );
      const labels = await androidLabels(deviceId, pkgs);
      apps = pkgs.map((p) => ({
        platform,
        appId: p.appId,
        label: labels[p.apkPath]?.label ?? null,
        version: labels[p.apkPath]?.versionName ?? p.versionCode,
      }));
      break;
    }
    case 'ios': {
      const plist = await run('xcrun', ['simctl', 'listapps', deviceId], { timeoutMs: 30_000 });
      const json = (await run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist.stdout, timeoutMs: 10_000 })).stdout.toString('utf8');
      apps = parseSimctlApps(json).filter((a) => !INFRA_PREFIXES.some((x) => a.appId.startsWith(x)));
      break;
    }
    case 'desktop-chrome':
    case 'desktop-safari':
      throw new Error(`${PLATFORM_INFO[platform].label}에는 설치 앱 목록이 없습니다 (웹 대상만 실행).`);
  }
  return apps.sort((a, b) => a.appId.localeCompare(b.appId));
}

/** iOS executable name (CFBundleExecutable), needed for `log stream` predicates. */
export async function iosAppExecutable(deviceId: string, bundleId: string): Promise<string | null> {
  const container = (await xcrun(['simctl', 'get_app_container', deviceId, bundleId, 'app'], { timeoutMs: 30_000 })).trim();
  const out = await run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(container, 'Info.plist')], { timeoutMs: 10_000, allowFail: true });
  return out.code === 0 ? out.stdout.toString('utf8').trim() || null : null;
}
