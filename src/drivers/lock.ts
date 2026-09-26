// Per-device exclusive lock: .qa/locks/<deviceId>.lock = {pid, startedAt}. A dead (or pid-reused) owner is reclaimed.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { linkSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../core/config.ts';
import { writeSecure } from '../core/fsx.ts';

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
  readonly owner: LockRecord;
  constructor(deviceId: string, owner: LockRecord) {
    super(`디바이스 ${deviceId}는 다른 qa 프로세스(pid ${owner.pid}, ${owner.acquiredAt}부터)가 사용 중입니다.`);
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

function readRecord(file: string): LockRecord | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as LockRecord;
    return typeof r.pid === 'number' && typeof r.startedAt === 'string' ? r : null;
  } catch {
    return null;
  }
}

export interface DeviceLock {
  readonly path: string;
  readonly record: LockRecord;
  release(): void;
}

/**
 * Acquires `.qa/locks/<deviceId>.lock` atomically (write temp file, hard-link into place).
 * Throws DeviceLockedError when a live process holds it. Released on `release()` or process exit.
 */
export function acquireDeviceLock(deviceId: string, opts: { dir?: string; probe?: ProcessProbe; pid?: number; startedAt?: string } = {}): DeviceLock {
  const dir = opts.dir ?? PATHS.locks;
  const file = join(dir, `${deviceId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  const probe = opts.probe ?? systemProbe;
  const record: LockRecord = {
    pid: opts.pid ?? process.pid,
    startedAt: opts.startedAt ?? new Date(Math.floor(performance.timeOrigin)).toISOString(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const tmp = `${file}.${record.token}.tmp`;
  writeSecure(tmp, `${JSON.stringify(record)}\n`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const owner = readRecord(file);
        if (!isStale(owner, probe)) throw new DeviceLockedError(deviceId, owner!);
        rmSync(file, { force: true });
        continue;
      }
      // A concurrent reclaimer may have replaced the file between our unlink and link; trust only our own token.
      const now = readRecord(file);
      if (now?.token !== record.token) throw new DeviceLockedError(deviceId, now ?? record);
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        process.removeListener('exit', release);
        if (readRecord(file)?.token === record.token) rmSync(file, { force: true });
      };
      process.once('exit', release);
      return { path: file, record, release };
    }
    throw new DeviceLockedError(deviceId, readRecord(file) ?? record);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}
