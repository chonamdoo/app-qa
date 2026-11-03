import assert from 'node:assert/strict';
import fs, { constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireFileLock, FileLockedError } from '../../src/core/lock.ts';
import type { ProcessProbe } from '../../src/core/process.ts';

const START = '2026-09-26T00:00:00.000Z';
/** Every pid is a live process started at START: only the record itself decides whether a lock is held. */
const alive: ProcessProbe = () => ({ alive: true, startedAtMs: Date.parse(START) });
const VALID = { pid: 111, startedAt: START, acquiredAt: '2026-09-26T00:00:05.000Z', token: 'owner-token' };

const operations = ['openSync', 'fstatSync', 'writeSync', 'fsyncSync', 'linkSync', 'unlinkSync'] as const;
type Operation = typeof operations[number];
type Call = (...args: unknown[]) => unknown;

function intercept(around: (op: Operation, args: unknown[], call: () => unknown) => unknown, run: () => void): void {
  const patchable = fs as unknown as Record<Operation, Call>;
  const originals = operations.map(op => [op, patchable[op]] as const);
  let inside = false;
  for (const [op, original] of originals) {
    patchable[op] = (...args) => {
      if (inside) return original(...args);
      inside = true;
      try { return around(op, args, () => original(...args)); }
      finally { inside = false; }
    };
  }
  syncBuiltinESMExports();
  try { run(); }
  finally {
    for (const [op, original] of originals) patchable[op] = original;
    syncBuiltinESMExports();
  }
}

describe('owner lock record', { skip: process.platform === 'win32' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY, concurrency: false }, () => {
  let file: string;
  beforeEach(() => {
    file = join(realpathSync(mkdtempSync(join(tmpdir(), 'qa-core-lock-'))), 'x.lock');
  });
  afterEach(() => rmSync(join(file, '..'), { recursive: true, force: true }));

  it('a whole, valid record of a live owner holds the lock', () => {
    writeFileSync(file, JSON.stringify(VALID));
    assert.throws(
      () => acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive }),
      (err) => err instanceof FileLockedError && err.reason === 'held' && err.owner?.acquiredAt === VALID.acquiredAt && /pid 111, 2026-09-26T00:00:05\.000Z부터/.test(err.message),
    );
  });

  it('a record with any malformed field is unreadable: reclaimed like a missing owner, never trusted as a live one', () => {
    const malformed: Record<string, unknown> = {
      'acquiredAt missing': { ...VALID, acquiredAt: undefined },
      'acquiredAt not a timestamp': { ...VALID, acquiredAt: 42 },
      'token missing': { ...VALID, token: undefined },
      'token empty': { ...VALID, token: '' },
      'token not a string': { ...VALID, token: 7 },
      'startedAt not a timestamp': { ...VALID, startedAt: 'yesterday' },
      'pid not an integer': { ...VALID, pid: 111.5 },
      'not an object': [VALID],
    };
    for (const [name, record] of Object.entries(malformed)) {
      writeFileSync(file, JSON.stringify(record));
      const lock = acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), lock.record, name);
      lock.release();
    }
  });

  it('commits bytes before installation and link/unlink entries before returning authority', () => {
    const events: string[] = [];
    intercept((op, args, call) => {
      if (op === 'fsyncSync') events.push(fstatSync(args[0] as number).isDirectory() ? 'directory sync' : 'file sync');
      if (op === 'linkSync') events.push('install');
      if (op === 'unlinkSync') events.push(args[0] === file ? 'remove owner' : 'remove staging');
      return call();
    }, () => {
      const lock = acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
      events.push('acquired');
      lock.release();
      events.push('released');
    });
    const installed = events.indexOf('install');
    const acquired = events.indexOf('acquired');
    const removed = events.indexOf('remove owner');
    assert.ok(events.slice(0, installed).includes('file sync'));
    assert.ok(events.slice(installed + 1, acquired).includes('directory sync'));
    assert.ok(events.slice(installed + 1, acquired).includes('remove staging'));
    assert.ok(events.slice(removed + 1, -1).includes('directory sync'));
    assert.deepEqual(readdirSync(join(file, '..')), []);
  });

  it('never installs a partial lock record after a failed short write', () => {
    const fault = Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    let writes = 0;
    let installed = false;
    let dispatched = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'writeSync') {
        if (++writes > 1) throw fault;
        return writeSync(args[0] as number, args[1] as Uint8Array, args[2] as number, 2);
      }
      if (op === 'linkSync') installed = true;
      return call();
    }, () => {
      acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
      dispatched = true;
    }), error => error === fault);
    assert.equal(installed, false);
    assert.equal(dispatched, false);
    assert.deepEqual(readdirSync(join(file, '..')), []);
  });

  it('does not grant authority when the installed hard link cannot be committed', () => {
    const fault = Object.assign(new Error('injected directory commit failure'), { code: 'EIO' });
    let installed = false;
    let failed = false;
    let dispatched = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'linkSync') {
        const result = call();
        installed = true;
        return result;
      }
      if (op === 'fsyncSync' && installed && !failed && fstatSync(args[0] as number).isDirectory()) {
        failed = true;
        throw fault;
      }
      return call();
    }, () => {
      acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
      dispatched = true;
    }), error => error === fault);
    assert.equal(dispatched, false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 222);
    assert.throws(() => acquireFileLock(file, { purpose: '테스트', pid: 333, startedAt: START, probe: alive }), FileLockedError);
    assert.deepEqual(readdirSync(join(file, '..')), ['x.lock']);
  });

  it('does not acknowledge acquisition when removal of its staging link cannot be committed', () => {
    const fault = Object.assign(new Error('injected staging unlink commit failure'), { code: 'EIO' });
    let removed = false;
    let failed = false;
    let dispatched = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'unlinkSync' && String(args[0]).endsWith('.tmp')) {
        const result = call();
        removed = true;
        return result;
      }
      if (op === 'fsyncSync' && removed && !failed && fstatSync(args[0] as number).isDirectory()) {
        failed = true;
        throw fault;
      }
      return call();
    }, () => {
      acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
      dispatched = true;
    }), error => error === fault);
    assert.equal(dispatched, false);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 222);
    assert.deepEqual(readdirSync(join(file, '..')), ['x.lock']);
  });

  it('refuses stale reclaim when the generation guard cannot be committed', () => {
    writeFileSync(file, JSON.stringify(VALID));
    const fault = Object.assign(new Error('injected guard commit failure'), { code: 'EIO' });
    let guard = -1;
    let failed = false;
    let installed = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'openSync' && String(args[0]).endsWith('.reclaim')) {
        const fd = call() as number;
        guard = fd;
        return fd;
      }
      if (op === 'fsyncSync' && args[0] === guard && !failed) {
        failed = true;
        throw fault;
      }
      return call();
    }, () => {
      acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: () => ({ alive: false, startedAtMs: null }) });
      installed = true;
    }), error => error === fault);
    assert.equal(installed, false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), VALID);
    assert.deepEqual(readdirSync(join(file, '..')), ['x.lock']);
  });

  it('a failed release remains retryable without removing a replacement generation', () => {
    const mine = acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
    const fault = Object.assign(new Error('injected unlink commit failure'), { code: 'EIO' });
    let removed = false;
    let failed = false;
    assert.throws(() => intercept((op, args, call) => {
      if (op === 'unlinkSync' && args[0] === file) {
        const result = call();
        removed = true;
        return result;
      }
      if (op === 'fsyncSync' && removed && !failed && fstatSync(args[0] as number).isDirectory()) {
        failed = true;
        throw fault;
      }
      return call();
    }, () => mine.release()), error => error === fault);
    const theirs = acquireFileLock(file, { purpose: '테스트', pid: 333, startedAt: START, probe: alive });
    let committed = false;
    intercept((op, args, call) => {
      if (op === 'fsyncSync' && fstatSync(args[0] as number).isDirectory()) committed = true;
      return call();
    }, () => mine.release());
    assert.equal(committed, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), theirs.record);
    mine.release();
    theirs.release();
  });

  it('release compares the acquired inode even when another generation has identical bytes', () => {
    const lock = acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive });
    const replacement = `${file}.replacement`;
    writeFileSync(replacement, readFileSync(file), { mode: 0o600 });
    renameSync(replacement, file);
    const inode = statSync(file).ino;
    lock.release();
    assert.equal(statSync(file).ino, inode);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), lock.record);
  });

  it('refuses a lock symlink without changing the external record or link', () => {
    const external = `${file}.external`;
    writeFileSync(external, 'not a lock', { mode: 0o644 });
    symlinkSync(external, file);
    assert.throws(() => acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive }));
    assert.equal(lstatSync(file).isSymbolicLink(), true);
    assert.equal(readFileSync(external, 'utf8'), 'not a lock');
    assert.equal(statSync(external).mode & 0o777, 0o644);
  });

  it('refuses foreign-owned lock records instead of reclaiming them as malformed', () => {
    writeFileSync(file, 'not a lock', { mode: 0o600 });
    const inode = statSync(file, { bigint: true }).ino;
    assert.throws(() => intercept((op, _args, call) => {
      const result = call();
      if (op === 'fstatSync') {
        const stat = result as fs.BigIntStats;
        if (stat.ino === inode) return Object.assign(Object.create(stat) as fs.BigIntStats, { uid: BigInt(process.geteuid!() + 1) });
      }
      return result;
    }, () => acquireFileLock(file, { purpose: '테스트', pid: 222, startedAt: START, probe: alive })), error => error instanceof Error && 'code' in error && error.code === 'ERR_FILE_LOCK_UNSAFE');
    assert.equal(readFileSync(file, 'utf8'), 'not a lock');
  });

  it('does not create lock generations through a user-controlled directory alias', { skip: process.geteuid?.() === 0 }, () => {
    const external = `${file}.directory`;
    const alias = `${file}.alias`;
    mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, alias);
    assert.throws(() => acquireFileLock(join(alias, 'owner.lock'), { purpose: '테스트', pid: 222, startedAt: START, probe: alive }));
    assert.deepEqual(readdirSync(external), []);
  });
});
