// Per-device exclusive lock: .qa/locks/<deviceId>.lock, an owner lock file (`src/core/lock.ts`). The desktop display is
// not a checkout's: its lock and its display-unknown marker live in the per-user DISPLAY_DIR.
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../core/config.ts';
import { writeJsonAtomic } from '../core/fsx.ts';
import { acquireFileLock, FileLockedError, type FileLock, type LockHooks, type LockRecord } from '../core/lock.ts';
import type { ProcessProbe } from '../core/process.ts';

export class DeviceLockedError extends Error {
  /** Recorded owner; null when the lock file is unreadable. */
  readonly owner: LockRecord | null;
  constructor(deviceId: string, owner: LockRecord | null, detail?: string, options?: ErrorOptions) {
    super(
      detail ??
        (owner
          ? `디바이스 ${deviceId}는 다른 qa 프로세스(pid ${owner.pid}, ${owner.acquiredAt}부터)가 사용 중입니다.`
          : `디바이스 ${deviceId}의 잠금을 얻지 못했습니다 (다른 qa 프로세스와 경합).`),
      options,
    );
    this.name = 'DeviceLockedError';
    this.owner = owner;
  }
}

export type DeviceLock = FileLock;

interface LockOptions {
  dir?: string;
  probe?: ProcessProbe;
  // ── seams (tests) ──
  pid?: number;
  startedAt?: string;
  hooks?: LockHooks;
}

/**
 * Acquires `.qa/locks/<deviceId>.lock` atomically (write temp file, hard-link into place).
 * Throws DeviceLockedError when a live process holds it or another process is reclaiming it.
 * Released on `release()` or process exit.
 */
export function acquireDeviceLock(deviceId: string, opts: LockOptions = {}): DeviceLock {
  const file = join(opts.dir ?? PATHS.locks, `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  try {
    return acquireFileLock(file, { purpose: `디바이스 ${deviceId}`, probe: opts.probe, pid: opts.pid, startedAt: opts.startedAt, hooks: opts.hooks });
  } catch (err) {
    if (!(err instanceof FileLockedError)) throw err;
    const detail = err.reason === 'reclaiming' ? `디바이스 ${deviceId}의 오래된 잠금을 다른 qa 프로세스가 회수하는 중입니다. 계속 실패하면 ${file}.*.reclaim 파일을 지우세요.` : undefined;
    throw new DeviceLockedError(deviceId, err.owner, detail, { cause: err });
  }
}

/**
 * This user's desktop display state (0700), outside every checkout: every qa process of the user — whatever project
 * root or worktree it runs from — shares one display, pointer and keyboard focus. Not the temp dir: TMPDIR differs
 * between environments and macOS purges it, which would forget a display left unknown.
 */
export const DISPLAY_DIR = join(homedir(), 'Library', 'Application Support', 'app-qa');
const DISPLAY_LOCK_FILE = 'desktop-display.lock';
const DISPLAY_UNKNOWN_FILE = 'display-unknown.json';

/**
 * Acquires the display lock (`DISPLAY_DIR/desktop-display.lock`) with the device-lock rules: held by a live owner or
 * being reclaimed → DeviceLockedError; a dead or pid-reused owner is reclaimed. Released on `release()` or process exit.
 */
export function acquireDisplayLock(opts: LockOptions = {}): DeviceLock {
  try {
    return acquireFileLock(join(opts.dir ?? DISPLAY_DIR, DISPLAY_LOCK_FILE), { purpose: '데스크톱 화면', probe: opts.probe, pid: opts.pid, startedAt: opts.startedAt, hooks: opts.hooks });
  } catch (err) {
    if (!(err instanceof FileLockedError)) throw err;
    throw new DeviceLockedError('desktop-display', err.owner, err.message, { cause: err });
  }
}

/** Why the display is unknown: a desktop session end or start this user's qa could not confirm, and when. */
const DisplayUnknownRecord = z.strictObject({
  since: z.iso.datetime({ offset: true }),
  reason: z.string().min(1),
  runId: z.string().min(1).optional(),
});
export type DisplayUnknown = z.infer<typeof DisplayUnknownRecord>;

/**
 * The display-unknown marker; null only when there is none. A marker that cannot be read or is not a whole valid
 * record still means unknown (fail-closed): a record naming the unreadable file is returned instead.
 */
export function readDisplayUnknown(opts: { dir?: string } = {}): DisplayUnknown | null {
  const file = join(opts.dir ?? DISPLAY_DIR, DISPLAY_UNKNOWN_FILE);
  let problem: string;
  try {
    const parsed = DisplayUnknownRecord.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data;
    problem = '형식이 잘못됨';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    problem = code ? `읽지 못함 (${code})` : '형식이 잘못됨';
  }
  let since: string;
  try {
    since = statSync(file).mtime.toISOString();
  } catch {
    since = new Date().toISOString();
  }
  return { since, reason: `디스플레이 상태 기록 ${file}을(를) 확인할 수 없음 (${problem}) — 화면 상태를 알 수 없는 것으로 봅니다` };
}

/** Records that the display is unknown (atomic replace, 0600). Throws when it cannot be written. */
export function markDisplayUnknown(record: DisplayUnknown, opts: { dir?: string } = {}): void {
  writeJsonAtomic(join(opts.dir ?? DISPLAY_DIR, DISPLAY_UNKNOWN_FILE), record);
}

/** Removes the display-unknown marker; false when there was none. */
export function clearDisplayUnknown(opts: { dir?: string } = {}): boolean {
  try {
    unlinkSync(join(opts.dir ?? DISPLAY_DIR, DISPLAY_UNKNOWN_FILE));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
