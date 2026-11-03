// A process mutex is not evidence that native resources or effects are clean; admission owns that quarantine.
// Hard-link installation and generation-guarded removal acknowledge only committed bytes and directory entries.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { commitDirectory, sha256, writeAtomic } from './fsx.ts';
import { isProcessAlive, PROCESS_STARTED_AT_MS, systemProbe, type ProcessProbe } from './process.ts';

/** The lock file as written by `acquireFileLock`; anything else on disk is an unreadable record. */
const LockRecord = z.object({
  pid: z.number().int().positive(),
  /** Owner process start time (ISO); distinguishes a live owner from a reused pid. */
  startedAt: z.iso.datetime(),
  acquiredAt: z.iso.datetime(),
  token: z.string().min(1),
});
export type LockRecord = z.infer<typeof LockRecord>;

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
        ? `${purpose}: 오래된 잠금을 다른 qa 프로세스가 회수하는 중입니다. 소유권과 미확인 작업을 확인한 뒤 다시 시도하세요.`
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
  dev: bigint;
  ino: bigint;
  bytes: Buffer;
}

function readLockFile(file: string): LockFile | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(process.geteuid!())) {
      throw Object.assign(new Error('Expected an owned regular lock file'), { code: 'ERR_FILE_LOCK_UNSAFE' });
    }
    return { dev: stat.dev, ino: stat.ino, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function sameGeneration(first: LockFile, second: LockFile): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.bytes.equals(second.bytes);
}

/** The recorded owner, or null when the bytes are not a whole valid record (then the lock counts as unreadable). */
function parseRecord(bytes: Buffer): LockRecord | null {
  try {
    const parsed = LockRecord.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
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
 * remover holding an older judgement never matches — and so never deletes — a newer lock. A leftover guard
 * blocks removal; reclaiming a process mutex never resolves uncertain native ownership or effects.
 */
function removeGeneration(file: string, seen: LockFile, hooks: LockHooks): 'removed' | 'changed' | 'busy' {
  commitDirectory(dirname(file));
  const guard = `${file}.${sha256(seen.bytes).slice(0, 16)}.reclaim`;
  let fd: number;
  try {
    fd = openSync(guard, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'busy';
    throw err;
  }
  try {
    try { fsyncSync(fd); }
    finally { closeSync(fd); }
    commitDirectory(dirname(file));
    hooks.onGuard?.();
    const now = readLockFile(file);
    if (!now || !sameGeneration(now, seen)) return 'changed';
    unlinkSync(file);
    commitDirectory(dirname(file));
    return 'removed';
  } finally {
    unlinkSync(guard);
    commitDirectory(dirname(file));
  }
}

/** Writes the temp file; a concurrent holder removing the (empty) lock directory on release makes the write retry. */
function writeTemp(tmp: string, data: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeAtomic(tmp, data);
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
 * Acquires `file` atomically and durably; never waits.
 * Throws FileLockedError on contention. A commit failure may leave an installed mutex; it grants no dispatch authority.
 * `release()` commits removal before acknowledging and remains retryable after a failed commit.
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
  const data = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(data);
  let generation: LockFile | null = null;
  try {
    writeTemp(tmp, data);
    generation = readLockFile(tmp);
    if (!generation || !generation.bytes.equals(bytes)) throw new Error('Lock staging generation changed');
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
      commitDirectory(dirname(file));
      break;
    }
    const now = readLockFile(file);
    if (!now || !sameGeneration(now, generation)) throw new FileLockedError(opts.purpose, file, 'contended', now && parseRecord(now.bytes));
  } finally {
    const staged = readLockFile(tmp);
    if (staged) {
      if (!staged.bytes.equals(bytes) || (generation && !sameGeneration(staged, generation))) throw new Error('Refusing to remove a changed lock staging generation');
      if (removeGeneration(tmp, staged, {}) === 'busy') throw new FileLockedError(opts.purpose, file, 'reclaiming', record);
    }
  }
  let held = true;
  const owned = generation;
  const release = () => {
    if (!held) return;
    if (removeGeneration(file, owned, {}) === 'busy') throw new FileLockedError(opts.purpose, file, 'reclaiming', record);
    held = false;
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return { path: file, record, release };
}
