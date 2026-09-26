// Read-only copies of installed app binaries: the precondition for iOS `clear` and any `reinstall` reset.
import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { adb, adbShell, xcrun } from '../appium/exec.ts';
import { PATHS } from '../core/config.ts';
import { ensureDir } from '../core/fsx.ts';
import type { Platform } from '../core/types.ts';
import { appIdProblem } from './appid.ts';

export interface BackupResult {
  platform: Platform;
  appId: string;
  /** `.qa/apps/<appId>/<sha256>.apk` (single APK), `<sha256>.apks/` (split APKs) or `<sha256>.app/` (iOS simulator bundle). */
  path: string;
  sha256: string;
  bytes: number;
  files: number;
  /** True when an identical backup already existed. */
  reused: boolean;
}

/** Parses `pm path <pkg>`: base.apk first, then splits in name order. */
export function parsePmPath(out: string): string[] {
  const paths = [...out.matchAll(/^package:(\S.*?)\s*$/gm)].map((m) => m[1]!);
  return paths.sort((a, b) => Number(!a.endsWith('/base.apk')) - Number(!b.endsWith('/base.apk')) || a.localeCompare(b));
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Content hash of a file tree: sha256 over sorted `relpath \0 sha256(file)` / `relpath \0 -> linktarget` lines. */
export async function hashTree(root: string): Promise<{ sha256: string; bytes: number; files: number }> {
  const entries: string[] = [];
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push(`${rel}\0-> ${readlinkSync(full)}`);
      else if (st.isDirectory()) await walk(full);
      else if (st.isFile()) {
        entries.push(`${rel}\0${await hashFile(full)}`);
        bytes += st.size;
        files++;
      }
    }
  };
  await walk(root);
  return { sha256: createHash('sha256').update(entries.join('\n')).digest('hex'), bytes, files };
}

const EXT: Record<Platform, string[]> = { android: ['.apk', '.apks'], ios: ['.app'] };

/** `.qa/apps/<appId>` for a validated app id; never a path outside `.qa/apps`. */
function backupDir(platform: Platform, appId: string): string {
  const problem = appIdProblem(platform, appId);
  if (problem) throw new Error(problem);
  const dir = resolve(PATHS.appBackups, appId);
  if (dirname(dir) !== resolve(PATHS.appBackups)) throw new Error(`백업 경로가 .qa/apps 밖입니다: ${appId}`);
  return dir;
}

/** Newest backup of the app for the platform, or null. */
export function findBackup(platform: Platform, appId: string): string | null {
  const dir = backupDir(platform, appId);
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir)
    .filter((n) => /^[0-9a-f]{64}\./.test(n) && EXT[platform].some((e) => n.endsWith(e)))
    .map((n) => ({ path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.path ?? null;
}

/** Moves the staged copy into place (or discards it when identical content exists) and marks the result newest. */
function commit(staged: string, target: string): boolean {
  const reused = existsSync(target);
  if (reused) rmSync(staged, { recursive: true, force: true });
  else renameSync(staged, target);
  const now = new Date();
  utimesSync(target, now, now);
  return reused;
}

/**
 * Copies the installed app binary off the device without touching the installation.
 * Android: `pm path` → `adb pull` every APK (base + splits). iOS simulator: `simctl get_app_container … app` copy.
 */
export async function backupApp(platform: Platform, deviceId: string, appId: string): Promise<BackupResult> {
  const dir = ensureDir(backupDir(platform, appId));
  const tmp = mkdtempSync(join(dir, '.tmp-'));
  try {
    if (platform === 'android') {
      const remote = parsePmPath(await adbShell(deviceId, ['pm', 'path', appId], { timeoutMs: 30_000, allowFail: true }));
      if (remote.length === 0) throw new Error(`${deviceId}에 ${appId}가 설치되어 있지 않습니다.`);
      for (const r of remote) await adb(deviceId, ['pull', r, join(tmp, basename(r))], { timeoutMs: 600_000 });
      const tree = await hashTree(tmp);
      if (remote.length === 1) {
        const file = join(tmp, basename(remote[0]!));
        const sha = await hashFile(file);
        const target = join(dir, `${sha}.apk`);
        const reused = commit(file, target);
        return { platform, appId, path: target, sha256: sha, bytes: tree.bytes, files: 1, reused };
      }
      const target = join(dir, `${tree.sha256}.apks`);
      const staged = join(tmp, 'bundle');
      ensureDir(staged);
      for (const r of remote) renameSync(join(tmp, basename(r)), join(staged, basename(r)));
      const reused = commit(staged, target);
      return { platform, appId, path: target, sha256: tree.sha256, bytes: tree.bytes, files: tree.files, reused };
    }
    const container = (await xcrun(['simctl', 'get_app_container', deviceId, appId, 'app'], { timeoutMs: 30_000 })).trim();
    if (!container.endsWith('.app')) throw new Error(`${appId}의 앱 번들 경로를 얻지 못했습니다: ${container}`);
    const staged = join(tmp, basename(container));
    cpSync(container, staged, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    const tree = await hashTree(staged);
    const target = join(dir, `${tree.sha256}.app`);
    const reused = commit(staged, target);
    return { platform, appId, path: target, sha256: tree.sha256, bytes: tree.bytes, files: tree.files, reused };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
