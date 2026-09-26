import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import { isStale } from '../../src/core/lock.ts';
import type { ProcessProbe } from '../../src/core/process.ts';
import { acquireDeviceLock, clearDisplayUnknown, DeviceLockedError, markDisplayUnknown, readDisplayUnknown, type DeviceLock } from '../../src/drivers/lock.ts';

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

/** A qa process of one checkout taking the display lock with its defaults; HOLD keeps it (and the lock) alive on its open stdin until killed. */
const TRY_DISPLAY = `import { PATHS } from './src/core/config.ts';
import { acquireDisplayLock, DISPLAY_DIR } from './src/drivers/lock.ts';
let error = null;
try {
  acquireDisplayLock();
} catch (err) {
  error = \`\${err.name}: \${err.message}\`;
}
console.log(JSON.stringify({ root: PATHS.root, dir: DISPLAY_DIR, error }));
if (!error && process.env.HOLD) process.stdin.resume();
`;

interface Attempt {
  root: string;
  dir: string;
  error: string | null;
}

/** The first line a child prints; rejects when it exits without one. */
function attempt(child: ChildProcess): Promise<Attempt> {
  const { promise, resolve, reject } = Promise.withResolvers<Attempt>();
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.includes('\n')) resolve(JSON.parse(out.slice(0, out.indexOf('\n'))) as Attempt);
  });
  child.on('exit', (code) => reject(new Error(`exited (${code}) without an answer: ${out}`)));
  return promise;
}

describe('desktop display lock and display-unknown marker', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qa-display-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is one lock per user, not per checkout: qa processes of two project roots exclude each other; a killed owner is reclaimed', async () => {
    // Two checkouts (copies of src/), one user: HOME points at a scratch home, so the real display dir is never touched.
    const home = join(dir, 'home');
    const [a, b] = ['checkout-a', 'checkout-b'].map((name) => {
      const root = join(dir, name);
      cpSync(join(PATHS.root, 'src'), join(root, 'src'), { recursive: true });
      symlinkSync(join(PATHS.root, 'node_modules'), join(root, 'node_modules'));
      writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
      writeFileSync(join(root, 'try-display.mjs'), TRY_DISPLAY);
      return root;
    }) as [string, string];
    const run = (root: string, hold: boolean) => spawn(process.execPath, [join(root, 'try-display.mjs')], { cwd: root, env: { ...process.env, HOME: home, HOLD: hold ? '1' : '' }, stdio: [hold ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
    /** A one-shot attempt, once its process has exited (and released what it took). */
    const tryOnce = async (root: string) => {
      const child = run(root, false);
      return (await Promise.all([attempt(child), once(child, 'exit')]))[0];
    };

    const holder = run(a, true);
    try {
      const held = await attempt(holder);
      assert.equal(held.error, null);
      const refused = await tryOnce(b);
      assert.notEqual(refused.root, held.root);
      assert.match(refused.error ?? 'acquired', new RegExp(`^DeviceLockedError: 데스크톱 화면: 다른 qa 프로세스\\(pid ${holder.pid}, `));
      // One per-user directory outside both checkouts (here: under the scratch HOME).
      assert.equal(refused.dir, held.dir);
      assert.ok(relative(home, refused.dir) !== '' && !relative(home, refused.dir).startsWith('..'), refused.dir);
    } finally {
      holder.kill('SIGKILL');
      if (holder.exitCode === null && holder.signalCode === null) await once(holder, 'exit');
    }
    // The owner died holding the lock (no exit handler ran): the other checkout reclaims it.
    assert.equal((await tryOnce(b)).error, null);
  });

  it('the marker round-trips (0600 in a 0700 dir); clear removes it and says whether there was one', () => {
    const state = join(dir, 'app-qa');
    assert.equal(readDisplayUnknown({ dir: state }), null);
    const record = { since: '2026-09-26T05:12:41.000Z', reason: 'Chrome (macOS) 세션 종료를 확인하지 못함 (socket hang up)', runId: '2026-09-26T05-12-41-000Z-1a2b3c' };
    markDisplayUnknown(record, { dir: state });
    assert.deepEqual(readDisplayUnknown({ dir: state }), record);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(state), ['display-unknown.json']);
    assert.equal(statSync(join(state, 'display-unknown.json')).mode & 0o777, 0o600);
    const withoutRun = { since: '2026-09-26T06:00:00.000Z', reason: 'Safari (macOS) 세션 시작 응답 없음' };
    markDisplayUnknown(withoutRun, { dir: state });
    assert.deepEqual(readDisplayUnknown({ dir: state }), withoutRun);
    assert.equal(clearDisplayUnknown({ dir: state }), true);
    assert.equal(readDisplayUnknown({ dir: state }), null);
    assert.equal(clearDisplayUnknown({ dir: state }), false);
  });

  it('a marker that is not a whole valid record, or cannot be read, still means unknown; clear removes it', () => {
    const file = join(dir, 'display-unknown.json');
    const malformed = ['', 'not json', '{"since":"2026-09-26T05:12:41.000Z","reason":"x"', '{}', 'null', '{"since":"어제","reason":"x"}', '{"since":"2026-09-26T05:12:41.000Z","reason":""}', '{"since":"2026-09-26T05:12:41.000Z","reason":"x","extra":1}'];
    for (const bytes of malformed) {
      writeFileSync(file, bytes);
      const unknown = readDisplayUnknown({ dir });
      assert.ok(unknown, JSON.stringify(bytes));
      assert.match(unknown.reason, /디스플레이 상태 기록 .*display-unknown\.json을\(를\) 확인할 수 없음 \(형식이 잘못됨\)/);
      assert.ok(!Number.isNaN(Date.parse(unknown.since)));
      assert.equal(clearDisplayUnknown({ dir }), true);
      assert.equal(readDisplayUnknown({ dir }), null);
    }
    mkdirSync(file);
    assert.match(readDisplayUnknown({ dir })?.reason ?? '', /확인할 수 없음 \(읽지 못함 \(EISDIR\)\)/);
  });
});
