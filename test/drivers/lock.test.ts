import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireDeviceLock, DeviceLockedError, isStale, type DeviceLock, type ProcessProbe } from '../../src/drivers/lock.ts';

const START = '2026-09-26T00:00:00.000Z';
const alive = (startedAt: string | null): ProcessProbe => () => ({ alive: true, startedAtMs: startedAt === null ? null : Date.parse(startedAt) });
const dead: ProcessProbe = () => ({ alive: false, startedAtMs: null });
/** pid 111 is the crashed previous owner; every other pid is a live qa process. */
const onlyOldOwnerDead: ProcessProbe = (pid) => (pid === 111 ? dead(pid) : alive(START)(pid));

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

  describe('stale-lock reclaim races (two reclaimers, injected interleavings)', () => {
    const token = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token;

    it('a reclaimer delayed after judging the lock stale never deletes the lock another reclaimer took meanwhile', () => {
      const crashed = acquireDeviceLock('dev', { dir, pid: 111, startedAt: START, probe: dead });
      let first: DeviceLock | null = null;
      const second = () =>
        acquireDeviceLock('dev', {
          dir,
          pid: 333,
          startedAt: START,
          probe: onlyOldOwnerDead,
          hooks: { onStale: () => (first = acquireDeviceLock('dev', { dir, pid: 222, startedAt: START, probe: onlyOldOwnerDead })) },
        });
      assert.throws(second, DeviceLockedError);
      const owner = first as DeviceLock | null;
      assert.ok(owner);
      assert.equal(token(owner.path), owner.record.token);
      assert.deepEqual(readdirSync(dir), ['dev.lock']); // no guard or temp file left behind
      crashed.release();
      assert.equal(token(owner.path), owner.record.token);
      owner.release();
      assert.equal(existsSync(owner.path), false);
    });

    it('two reclaimers of one stale lock: the one inside the reclaim guard wins, the other is refused', () => {
      const crashed = acquireDeviceLock('dev', { dir, pid: 111, startedAt: START, probe: dead });
      let refused: unknown = null;
      const winner = acquireDeviceLock('dev', {
        dir,
        pid: 222,
        startedAt: START,
        probe: onlyOldOwnerDead,
        hooks: {
          onGuard: () => {
            try {
              acquireDeviceLock('dev', { dir, pid: 333, startedAt: START, probe: onlyOldOwnerDead });
            } catch (err) {
              refused = err;
            }
          },
        },
      });
      assert.ok(refused instanceof DeviceLockedError);
      assert.equal(token(winner.path), winner.record.token);
      assert.deepEqual(readdirSync(dir), ['dev.lock']);
      assert.throws(() => acquireDeviceLock('dev', { dir, pid: 444, startedAt: START, probe: onlyOldOwnerDead }), DeviceLockedError);
      crashed.release();
      winner.release();
    });

    it('an unreadable stale lock replaced by a live owner before the reclaim is left alone', () => {
      writeFileSync(join(dir, 'dev.lock'), 'not json');
      let live: DeviceLock | null = null;
      const late = () =>
        acquireDeviceLock('dev', {
          dir,
          pid: 333,
          startedAt: START,
          probe: onlyOldOwnerDead,
          hooks: {
            onStale: () => {
              rmSync(join(dir, 'dev.lock'));
              live = acquireDeviceLock('dev', { dir, pid: 222, startedAt: START, probe: onlyOldOwnerDead });
            },
          },
        });
      assert.throws(late, DeviceLockedError);
      const owner = live as DeviceLock | null;
      assert.ok(owner);
      assert.equal(token(owner.path), owner.record.token);
      owner.release();
    });
  });
});
