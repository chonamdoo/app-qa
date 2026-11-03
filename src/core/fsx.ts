// Evidence files may contain screen content: directories 0700, files 0600.
// Callers authorize storage roots and serialize writers; these path checks are not a same-uid sandbox.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

function ioError(code: string, message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), { code });
}

function securePlatform(): void {
  if (process.platform === 'win32' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw ioError('ERR_FSX_UNSUPPORTED', 'Private no-follow files and directory fsync require a supported POSIX filesystem');
  }
}

function maybeStat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function ownedFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== process.geteuid!() || stat.nlink !== 1) {
    throw ioError('ERR_FSX_UNSAFE_FILE', 'Expected an owned, singly linked regular file');
  }
}

function trustedDirectory(stat: Stats, owned: boolean): void {
  const uid = process.geteuid!();
  const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (!stat.isDirectory() || (owned ? stat.uid !== uid : stat.uid !== uid && stat.uid !== 0)
      || ((stat.mode & 0o022) !== 0 && !(stickyRoot && !owned))) {
    throw ioError('ERR_FSX_UNSAFE_DIRECTORY', 'Expected an owned directory without another user’s write access');
  }
}

function prepareDirectory(dir: string, create: boolean): string {
  securePlatform();
  const absolute = resolve(dir);
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  trustedDirectory(lstatSync(current), parts.length === 0);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat = maybeStat(current);
    if (!stat) {
      if (!create) throw ioError('ENOENT', 'Storage directory does not exist');
      try { mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      if (stat.uid !== 0) throw ioError('ERR_FSX_UNSAFE_DIRECTORY', 'User-controlled directory symlinks are not storage roots');
      current = realpathSync(current);
      stat = lstatSync(current);
    }
    trustedDirectory(stat, index === parts.length - 1);
  }
  return dir;
}

/** Root-owned OS aliases such as macOS /var are allowed; callers still authorize the resolved storage root. */
export function ensureDir(dir: string): string {
  return prepareDirectory(dir, true);
}

interface Parent {
  directory: string;
  fd: number;
  stat: Stats;
}

function openParent(file: string, create = true): Parent {
  const directory = realpathSync(prepareDirectory(dirname(resolve(file)), create));
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    trustedDirectory(stat, true);
    if (!sameFile(stat, lstatSync(directory))) throw ioError('ERR_FSX_DIRECTORY_CHANGED', 'Storage directory changed while opening');
    return { directory, fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}

function checkParent(parent: Parent): void {
  if (!sameFile(parent.stat, lstatSync(parent.directory))) {
    throw ioError('ERR_FSX_DIRECTORY_CHANGED', 'Storage directory changed during the write');
  }
}

function checkPath(file: string, expected: Stats | null): void {
  const current = maybeStat(file);
  if (current) ownedFile(current);
  if (expected ? !current || !sameFile(expected, current) : current !== null) {
    throw ioError('ERR_FSX_FILE_CHANGED', 'Storage file changed during the write');
  }
}

function syncParents(parent: Parent): void {
  checkParent(parent);
  fsyncSync(parent.fd);
  for (let dir = dirname(parent.directory); ; dir = dirname(dir)) {
    if (dir === parent.directory) break;
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { trustedDirectory(fstatSync(fd), false); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (dirname(dir) === dir) break;
  }
}

/** Commits directory entries, including newly created ancestors; use after owned link/unlink operations. */
export function commitDirectory(dir: string): void {
  const parent = openParent(join(dir, '.fsx-directory-entry'));
  try { syncParents(parent); }
  finally { closeSync(parent.fd); }
}

export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let written: number;
    try { written = writeSync(fd, bytes, offset, bytes.byteLength - offset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    if (!Number.isInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw ioError('EIO', 'Filesystem write made no valid progress');
    }
    offset += written;
  }
}

function removeStage(file: string, expected: Stats): void {
  const current = maybeStat(file);
  if (!current) return;
  ownedFile(current);
  if (!sameFile(expected, current)) throw ioError('ERR_FSX_FILE_CHANGED', 'Refusing to remove a replaced staging file');
  unlinkSync(file);
}

function replaceFile(file: string, data: string | Uint8Array, durable: boolean): void {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  const parent = openParent(file);
  const target = join(parent.directory, basename(file));
  const temporary = join(parent.directory, `.${basename(file)}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  let stage: Stats | null = null;
  try {
    const previous = maybeStat(target);
    if (previous) ownedFile(previous);
    // Discover unsupported directory commits before replacing the old value.
    if (durable) syncParents(parent);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    stage = fstatSync(fd);
    ownedFile(stage);
    fchmodSync(fd, 0o600);
    writeAll(fd, bytes);
    if (durable) fsyncSync(fd);
    const closing = fd;
    fd = null;
    closeSync(closing);
    checkParent(parent);
    checkPath(temporary, stage);
    checkPath(target, previous);
    renameSync(temporary, target);
    stage = null;
    if (durable) syncParents(parent);
  } catch (error) {
    const errors = [error];
    if (fd !== null) {
      const closing = fd;
      fd = null;
      try { closeSync(closing); } catch (cause) { errors.push(cause); }
    }
    if (stage) {
      try {
        checkParent(parent);
        removeStage(temporary, stage);
        if (durable) syncParents(parent);
      } catch (cause) { errors.push(cause); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'File replacement and staging cleanup could not both complete');
    throw error;
  } finally { closeSync(parent.fd); }
}

/** Private atomic evidence/cache replacement, without a durability acknowledgement. */
export function writeSecure(file: string, data: string | Uint8Array): void {
  replaceFile(file, data, false);
}

export function writeJson(file: string, value: unknown): void {
  writeSecure(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Acknowledges only after file fsync, atomic rename and directory/ancestor fsync.
 * A post-rename failure may have installed the new value: do not dispatch or assume rollback.
 * This uses POSIX fsync, not macOS F_FULLFSYNC or a guarantee against dishonest device caches.
 */
export function writeAtomic(file: string, data: string | Uint8Array): void {
  replaceFile(file, data, true);
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function wholeJsonLine(value: unknown): Uint8Array {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('A journal record must be JSON serializable');
  return Buffer.from(`${text}\n`);
}

function checkTerminator(fd: number, size: number): void {
  if (!size) return;
  const last = Buffer.allocUnsafe(1);
  if (readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 10) {
    throw ioError('ERR_FSX_TORN_JSONL', 'Journal has an unterminated record; preserve it for reconciliation');
  }
}

/**
 * Requires one externally serialized writer. Partial/failed appends remain for reconciliation;
 * an unterminated tail is never truncated or joined to a later record.
 */
export function appendJsonl(file: string, value: unknown): void {
  const bytes = wholeJsonLine(value);
  const parent = openParent(file);
  const target = join(parent.directory, basename(file));
  let fd: number | null = null;
  try {
    syncParents(parent);
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    try { fd = openSync(target, flags | constants.O_CREAT | constants.O_EXCL, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      fd = openSync(target, flags);
    }
    const stat = fstatSync(fd);
    ownedFile(stat);
    checkPath(target, stat);
    checkTerminator(fd, stat.size);
    fchmodSync(fd, 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
    checkPath(target, stat);
    syncParents(parent);
  } finally {
    try { if (fd !== null) closeSync(fd); }
    finally { closeSync(parent.fd); }
  }
}

/** Validates framing, not fsync acknowledgement; an unterminated tail is always rejected. */
export function readJsonl(file: string): unknown[] {
  const parent = openParent(file, false);
  const target = join(parent.directory, basename(file));
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    ownedFile(before);
    checkPath(target, before);
    checkTerminator(fd, before.size);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    checkPath(target, before);
    checkParent(parent);
    if (!sameFile(before, after) || before.size !== after.size || bytes.byteLength !== before.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw ioError('ERR_FSX_FILE_CHANGED', 'Journal changed while reading');
    }
    if (!bytes.length) return [];
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return text.slice(0, -1).split('\n').map(line => JSON.parse(line) as unknown);
    } catch (cause) {
      throw ioError('ERR_FSX_INVALID_JSONL', 'Journal contains an invalid JSON record', cause);
    }
  } finally {
    try { if (fd !== null) closeSync(fd); }
    finally { closeSync(parent.fd); }
  }
}

export function readPrivateFile(file: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024) throw new RangeError('Invalid private snapshot bound');
  const parent = openParent(file, false);
  const target = join(parent.directory, basename(file));
  let fd: number | null = null;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    ownedFile(before);
    checkPath(target, before);
    if ((before.mode & 0o077) !== 0 || before.size < 1 || before.size > maximum) throw ioError('ERR_FSX_PRIVATE_FILE', 'Private snapshot permissions or size are invalid');
    const bytes = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    checkPath(target, before);
    checkParent(parent);
    if (length !== before.size || !sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || after.nlink !== 1) throw ioError('ERR_FSX_FILE_CHANGED', 'Private snapshot changed while reading');
    return bytes.subarray(0, length);
  } finally {
    try { if (fd !== null) closeSync(fd); }
    finally { closeSync(parent.fd); }
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Sortable, collision-free run id: 2026-09-26T06-40-12-345Z-1a2b3c. */
export function newRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
}
