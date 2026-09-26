// Exclusive owner lock file = {pid, startedAt, acquiredAt, token}, taken by hard-linking a complete temp file into place
// (O_EXCL semantics without a torn read). A dead (or pid-reused) owner is reclaimed; reclaiming never deletes a lock
// that changed since it was judged stale.
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, linkSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { sha256, writeSecure } from './fsx.ts';
import { isProcessAlive, PROCESS_STARTED_AT_MS, systemProbe, type ProcessProbe } from './process.ts';

export interface LockRecord {
  pid: number;
  /** Owner process start time (ISO); distinguishes a live owner from a reused pid. */
  startedAt: string;
  acquiredAt: string;
  token: string;
}

/** Why a lock was not acquired: a live owner holds it, another process is reclaiming it, or a reclaim race was lost. */
export type LockConflict = 'held' | 'reclaiming' | 'contended';

export class FileLockedError extends Error {
  readonly file: string;
  readonly reason: LockConflict;
  /** Recorded owner; null when the lock file is unreadable. */
  readonly owner: LockRecord | null;
  constructor(purpose: string, file: string, reason: LockConflict, owner: LockRecord | null) {
    super(
      reason === 'reclaiming'
        ? `${purpose}: 오래된 잠금을 다른 qa 프로세스가 회수하는 중입니다. 계속 실패하면 ${file}.*.reclaim 파일을 지우세요.`
        : owner
          ? `${purpose}: 다른 qa 프로세스(pid ${owner.pid}, ${owner.acquiredAt}부터)가 잠금을 갖고 있습니다.`
          : `${purpose}: 잠금을 얻지 못했습니다 (다른 qa 프로세스와 경합).`,
    );
    this.name = 'FileLockedError';
    this.file = file;
    this.reason = reason;
    this.owner = owner;
  }
}

/**
 * True when the recorded owner no longer holds the lock: unreadable record, dead pid,
 * or a live pid whose start time differs from the record (pid reused by another process).
 */
export function isStale(record: LockRecord | null, probe: ProcessProbe): boolean {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return true;
  return !isProcessAlive(record.pid, Date.parse(record.startedAt), probe);
}

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

/** Writes the temp file; a concurrent holder removing the (empty) lock directory on release makes the write retry. */
function writeTemp(tmp: string, data: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeSecure(tmp, data);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || attempt === 2) throw err;
    }
  }
}

export interface FileLock {
  readonly path: string;
  readonly record: LockRecord;
  release(): void;
}

export interface FileLockOptions {
  /** Korean subject of the error messages, e.g. `디바이스 emulator-5554`. */
  purpose: string;
  probe?: ProcessProbe;
  // ── seams (tests) ──
  pid?: number;
  startedAt?: string;
  hooks?: LockHooks;
}

/**
 * Acquires `file` atomically (write temp file, hard-link into place); never waits.
 * Throws FileLockedError when a live process holds it or another process is reclaiming it.
 * Released on `release()` or process exit.
 */
export function acquireFileLock(file: string, opts: FileLockOptions): FileLock {
  const probe = opts.probe ?? systemProbe;
  const hooks = opts.hooks ?? {};
  const record: LockRecord = {
    pid: opts.pid ?? process.pid,
    startedAt: opts.startedAt ?? new Date(PROCESS_STARTED_AT_MS).toISOString(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const tmp = `${file}.${record.token}.tmp`;
  writeTemp(tmp, `${JSON.stringify(record)}\n`);
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
        if (!isStale(owner, probe)) throw new FileLockedError(opts.purpose, file, 'held', owner);
        hooks.onStale?.();
        if (removeGeneration(file, seen, hooks) === 'busy') throw new FileLockedError(opts.purpose, file, 'reclaiming', owner);
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
    throw new FileLockedError(opts.purpose, file, 'contended', now && parseRecord(now.bytes));
  } finally {
    rmSync(tmp, { force: true });
  }
}
