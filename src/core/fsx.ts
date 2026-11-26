// Evidence files may contain screen content: directories 0700, files 0600.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export class DirExistsError extends Error {
  readonly dir: string;
  readonly code = 'EEXIST' as const;
  constructor(dir: string, cause?: unknown) {
    super(`실행 디렉터리가 이미 존재합니다: ${dir}`, { cause });
    this.name = 'DirExistsError';
    this.dir = dir;
  }
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function createDirExclusive(dir: string): string {
  ensureDir(dirname(dir));
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new DirExistsError(dir, err);
    throw err;
  }
  return dir;
}

function fsyncPath(path: string, flags: string): void {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write-once evidence file. `mode` applies only on create, so an existing file is re-restricted to 0600. */
export function writeSecure(file: string, data: string | Uint8Array): void {
  ensureDir(dirname(file));
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function writeJson(file: string, value: unknown): void {
  writeSecure(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Replaces a durable record so readers see either the old or the new bytes, never a torn file:
 * 0600 temp file in the same directory → fsync → rename → fsync the directory.
 */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  const dir = ensureDir(dirname(file));
  const tmp = join(dir, `.${basename(file)}.${randomUUID().slice(0, 8)}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, file);
  fsyncPath(dir, 'r');
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Appends one JSON line and fsyncs (and the directory on first create), so a crash never loses a recorded intent. */
export function appendJsonl(file: string, value: unknown): void {
  const dir = ensureDir(dirname(file));
  const created = !existsSync(file);
  appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fsyncPath(file, 'r+');
  if (created) fsyncPath(dir, 'r');
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

const RUN_ID_RE = /^[A-Za-z0-9_][\w.-]*$/;

export function assertValidRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`올바르지 않은 실행 ID: ${runId}`);
  return runId;
}

/** Sortable, collision-free run id: 2026-09-26T06-40-12-345Z-1a2b3c. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
}
