import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireFileLock, FileLockedError } from '../../src/core/lock.ts';
import type { ProcessProbe } from '../../src/core/process.ts';

const START = '2026-09-26T00:00:00.000Z';
/** Every pid is a live process started at START: only the record itself decides whether a lock is held. */
const alive: ProcessProbe = () => ({ alive: true, startedAtMs: Date.parse(START) });
const VALID = { pid: 111, startedAt: START, acquiredAt: '2026-09-26T00:00:05.000Z', token: 'owner-token' };

describe('owner lock record', () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'qa-core-lock-')), 'x.lock');
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
});
