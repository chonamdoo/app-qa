// Per-device exclusive lock: .qa/locks/<deviceId>.lock = {pid, startedAt, acquiredAt, token}. A dead (or pid-reused)
// owner is reclaimed; reclaiming never deletes a lock that changed since it was judged stale.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../core/config.ts';
import { sha256, writeSecure } from '../core/fsx.ts';

export interface LockRecord {
  pid: number;
  /** Owner process start time (ISO); distinguishes a live owner from a reused pid. */
  startedAt: string;
  acquiredAt: string;
  token: string;
}

/** Liveness and start time (ms, null when unknown) of a pid. */
export type ProcessProbe = (pid: number) => { alive: boolean; startedAtMs: number | null };

export class DeviceLockedError extends Error {
  /** Recorded owner; null when the lock file is unreadable. */
  readonly owner: LockRecord | null;
  constructor(deviceId: string, owner: LockRecord | null, detail?: string) {
    super(
      detail ??
        (owner
          ? `디바이스 ${deviceId}는 다른 qa 프로세스(pid ${owner.pid}, ${owner.acquiredAt}부터)가 사용 중입니다.`
          : `디바이스 ${deviceId}의 잠금을 얻지 못했습니다 (다른 qa 프로세스와 경합).`),
    );
    this.name = 'DeviceLockedError';
    this.owner = owner;
  }
}

/** `ps` reports start time with 1 s resolution; allow slack for rounding. */
const START_SLACK_MS = 2000;

/**
 * True when the recorded owner no longer holds the device: unreadable record, dead pid,
 * or a live pid whose start time differs from the record (pid reused by another process).
 */
export function isStale(record: LockRecord | null, probe: ProcessProbe): boolean {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return true;
  const p = probe(record.pid);
  if (!p.alive) return true;
  const recorded = Date.parse(record.startedAt);
  if (p.startedAtMs === null || Number.isNaN(recorded)) return false;
  return Math.abs(p.startedAtMs - recorded) > START_SLACK_MS;
}

export const systemProbe: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return { alive: false, startedAtMs: null };
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: process.env.TZ } }).trim();
    const ms = Date.parse(out);
    return { alive: true, startedAtMs: Number.isNaN(ms) ? null : ms };
  } catch {
    return { alive: true, startedAtMs: null };
  }
};

/** One lock file generation as read from disk: inode + exact bytes (tokens make every generation's bytes unique). */
interface LockFile {
  ino: bigint;
  bytes: Buffer;
}

function readLockFile(file: string): LockFile | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return { ino: fstatSync(fd, { bigint: true }).ino, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function parseRecord(bytes: Buffer): LockRecord | null {
  try {
    const r = JSON.parse(bytes.toString('utf8')) as LockRecord;
    return typeof r.pid === 'number' && typeof r.startedAt === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Test seams: called between the steps of a reclaim so interleavings with other processes can be reproduced. */
export interface LockHooks {
  /** After the current lock was judged stale, before any reclaim step. */
  onStale?: () => void;
  /** While holding the reclaim guard, before the lock is re-read and compared. */
  onGuard?: () => void;
}

/**
 * Deletes `file` only if it is still exactly generation `seen` (same inode and bytes). The compare-and-delete runs
 * under an O_EXCL guard named after that generation, so two removers of one generation never both act, and a
 * remover holding an older judgement never matches — and so never deletes — a newer lock. The guard is never removed
 * by anyone but its creator: a guard left by a crashed process makes the lock `busy` until a human removes it.
 */
function removeGeneration(file: string, seen: LockFile, hooks: LockHooks): 'removed' | 'changed' | 'busy' {
  const guard = `${file}.${sha256(seen.bytes).slice(0, 16)}.reclaim`;
  try {
    closeSync(openSync(guard, 'wx', 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
    throw err;
  }
  try {
    hooks.onGuard?.();
    const now = readLockFile(file);
    if (!now || now.ino !== seen.ino || !now.bytes.equals(seen.bytes)) return 'changed';
    unlinkSync(file);
    return 'removed';
  } finally {
    rmSync(guard, { force: true });
  }
}

export interface DeviceLock {
  readonly path: string;
  readonly record: LockRecord;
  release(): void;
}

/**
 * Acquires `.qa/locks/<deviceId>.lock` atomically (write temp file, hard-link into place).
 * Throws DeviceLockedError when a live process holds it or another process is reclaiming it.
 * Released on `release()` or process exit.
 */
export function acquireDeviceLock(deviceId: string, opts: { dir?: string; probe?: ProcessProbe; pid?: number; startedAt?: string; hooks?: LockHooks } = {}): DeviceLock {
  const dir = opts.dir ?? PATHS.locks;
  const file = join(dir, `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  const probe = opts.probe ?? systemProbe;
  const hooks = opts.hooks ?? {};
  const record: LockRecord = {
    pid: opts.pid ?? process.pid,
    startedAt: opts.startedAt ?? new Date(Math.floor(performance.timeOrigin)).toISOString(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const tmp = `${file}.${record.token}.tmp`;
  writeSecure(tmp, `${JSON.stringify(record)}\n`);
  try {
    // link → (stale) reclaim → link; one more round reports whoever won a concurrent reclaim.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const seen = readLockFile(file);
        if (!seen) continue;
        const owner = parseRecord(seen.bytes);
        if (!isStale(owner, probe)) throw new DeviceLockedError(deviceId, owner);
        hooks.onStale?.();
        if (removeGeneration(file, seen, hooks) === 'busy') {
          throw new DeviceLockedError(deviceId, owner, `디바이스 ${deviceId}의 오래된 잠금을 다른 qa 프로세스가 회수하는 중입니다. 계속 실패하면 ${file}.*.reclaim 파일을 지우세요.`);
        }
        continue;
      }
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        process.removeListener('exit', release);
        const now = readLockFile(file);
        if (now && parseRecord(now.bytes)?.token === record.token) removeGeneration(file, now, {});
      };
      process.once('exit', release);
      return { path: file, record, release };
    }
    const now = readLockFile(file);
    throw new DeviceLockedError(deviceId, now && parseRecord(now.bytes));
  } finally {
    rmSync(tmp, { force: true });
  }
}
