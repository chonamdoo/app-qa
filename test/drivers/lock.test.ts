import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireDeviceLock, DeviceLockedError, isStale, type ProcessProbe } from '../../src/drivers/lock.ts';

const START = '2026-09-26T00:00:00.000Z';
const alive = (startedAt: string | null): ProcessProbe => () => ({ alive: true, startedAtMs: startedAt === null ? null : Date.parse(startedAt) });
const dead: ProcessProbe = () => ({ alive: false, startedAtMs: null });

describe('device lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes {pid, startedAt} and blocks a second holder while the owner lives', () => {
    const lock = acquireDeviceLock('emulator-5554', { dir, pid: 111, startedAt: START, probe: alive(START) });
    const record = JSON.parse(readFileSync(lock.path, 'utf8'));
    assert.equal(record.pid, 111);
    assert.equal(record.startedAt, START);
    assert.throws(() => acquireDeviceLock('emulator-5554', { dir, pid: 222, startedAt: START, probe: alive(START) }), DeviceLockedError);
    lock.release();
    assert.equal(existsSync(lock.path), false);
    acquireDeviceLock('emulator-5554', { dir, pid: 222, startedAt: START, probe: alive(START) }).release();
  });

  it('reclaims a lock whose owner is dead', () => {
    acquireDeviceLock('D04BBA4D', { dir, pid: 111, startedAt: START, probe: dead });
    const lock = acquireDeviceLock('D04BBA4D', { dir, pid: 222, startedAt: START, probe: dead });
    assert.equal(JSON.parse(readFileSync(lock.path, 'utf8')).pid, 222);
  });

  it('reclaims when the pid was reused by a different process (start time differs)', () => {
    acquireDeviceLock('dev', { dir, pid: 111, startedAt: START, probe: dead });
    const lock = acquireDeviceLock('dev', { dir, pid: 222, startedAt: START, probe: alive('2026-09-26T05:00:00.000Z') });
    assert.equal(JSON.parse(readFileSync(lock.path, 'utf8')).pid, 222);
  });

  it('reclaims an unreadable lock file', () => {
    writeFileSync(join(dir, 'dev.lock'), 'not json');
    const lock = acquireDeviceLock('dev', { dir, pid: 222, startedAt: START, probe: alive(START) });
    assert.equal(JSON.parse(readFileSync(lock.path, 'utf8')).pid, 222);
  });

  it('release never deletes a lock that another process has since taken', () => {
    const mine = acquireDeviceLock('dev', { dir, pid: 111, startedAt: START, probe: dead });
    const theirs = acquireDeviceLock('dev', { dir, pid: 222, startedAt: START, probe: dead });
    mine.release();
    assert.equal(JSON.parse(readFileSync(theirs.path, 'utf8')).pid, 222);
  });

  it('isStale: live owner with unknown start time is kept; ±2 s start jitter is tolerated', () => {
    const rec = { pid: 5, startedAt: START, acquiredAt: START, token: 't' };
    assert.equal(isStale(rec, alive(null)), false);
    assert.equal(isStale(rec, alive('2026-09-26T00:00:01.500Z')), false);
    assert.equal(isStale(rec, alive('2026-09-26T00:00:03.000Z')), true);
    assert.equal(isStale({ ...rec, pid: 0 }, alive(START)), true);
  });
});
