// Crash safety of the shared desktop display: a qa process records the display as unknown itself before it opens a
// browser and removes that record only after the browser's confirmed end, so a process killed with a browser open
// leaves it, and the next run (which reclaims the dead owner's display lock) opens nothing.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { clearDisplayState, displayStateCheck } from '../../src/cli/display.ts';
import { PATHS } from '../../src/core/config.ts';
import { readDisplayUnknown, RefusedError, type DisplayUnknown } from '../../src/drivers/index.ts';
import { captureScreen, inspectScreen, runSmoke, runTests, type RunnerDeps } from '../../src/runner/index.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { displayDeps, fakeDeps, tempRoot } from '../helpers/run.ts';

const SITE = 'name: 웹 테스트\napp: web-demo\nstart: attach\nsteps:\n  - assertText: 상품 3개\n';
const index = () => fixtureSnapshot('desktop-chrome', 'web-demo', 'index');
/** The record a qa process writes for itself before it opens a desktop browser. */
const OWN = (pid: number) => new RegExp(`^qa 프로세스\\(pid ${pid}\\)가 연 데스크톱 브라우저의 세션 종료가 아직 확인되지 않음 — 그 프로세스가 끝났다면 강제 종료·충돌로 창이 남았을 수 있음$`);

async function runSite(driver: FakeDriver, deps: Partial<RunnerDeps>) {
  const root = tempRoot({ 'tests/site.e2e.yaml': SITE });
  const { tests } = await runTests({ paths: [join(root, 'tests')], platform: 'desktop-chrome' }, { ...fakeDeps(root, driver), ...deps });
  return tests[0]!;
}

/**
 * A qa process running the site test on Chrome through the real runner, with the real display lock and record in
 * QA_DISPLAY_DIR. Its browser opens, then the first observation never answers: it prints what it saw and stays alive
 * on its open stdin until killed.
 */
const CRASHING_RUN = `import { join } from 'node:path';
import { acquireDisplayLock, clearDisplayUnknown, markDisplayUnknown, readDisplayUnknown } from ${JSON.stringify(pathToFileURL(join(PATHS.root, 'src/drivers/index.ts')).href)};
import { runTests } from ${JSON.stringify(pathToFileURL(join(PATHS.root, 'src/runner/index.ts')).href)};
import { FakeDriver, fixtureSnapshot } from ${JSON.stringify(pathToFileURL(join(PATHS.root, 'test/helpers/fake-driver.ts')).href)};
const root = process.env.QA_ROOT;
const dir = process.env.QA_DISPLAY_DIR;
const driver = new FakeDriver(fixtureSnapshot('desktop-chrome', 'web-demo', 'index'));
driver.snapshot = () => {
  console.log(JSON.stringify({ opened: driver.called('open').length, record: readDisplayUnknown({ dir }) }));
  process.stdin.resume();
  return Promise.withResolvers().promise;
};
await runTests({ paths: [join(root, 'tests')], platform: 'desktop-chrome' }, {
  createDriver: () => driver,
  pickDevice: async (platform) => ({ platform, id: 'desktop-chrome', name: 'Chrome', osVersion: '1', state: 'booted', kind: 'browser' }),
  acquireLock: () => ({ release: () => undefined }),
  acquireDisplayLock: () => acquireDisplayLock({ dir }),
  readDisplayUnknown: () => readDisplayUnknown({ dir }),
  markDisplayUnknown: (record) => markDisplayUnknown(record, { dir }),
  clearDisplayUnknown: () => clearDisplayUnknown({ dir }),
  jev: () => ({ client: null, calibration: null, problem: null }),
  ocr: null,
  clock: driver.clock,
  root,
  runsDir: join(root, '.qa', 'runs'),
  appsDir: join(root, 'apps'),
  inventoryDir: join(root, '.qa', 'inventory'),
  fixturesDir: join(root, 'fixtures'),
});
`;

/** The first line a child prints; rejects when it exits without one. */
function firstLine(child: ChildProcess): Promise<{ opened: number; record: DisplayUnknown | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ opened: number; record: DisplayUnknown | null }>();
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.includes('\n')) resolve(JSON.parse(out.slice(0, out.indexOf('\n'))) as { opened: number; record: DisplayUnknown | null });
  });
  child.on('exit', (code) => reject(new Error(`exited (${code}) without an answer: ${out}`)));
  return promise;
}

describe('the display record of a qa process with a desktop browser open', () => {
  it('a qa process killed with its browser open leaves the display unknown: the next run reclaims its lock and opens no browser', async () => {
    const root = tempRoot({ 'tests/site.e2e.yaml': SITE });
    const dir = join(root, 'app-qa-display');
    writeFileSync(join(root, 'crashing-run.mjs'), CRASHING_RUN);
    const child = spawn(process.execPath, [join(root, 'crashing-run.mjs')], { env: { ...process.env, QA_ROOT: root, QA_DISPLAY_DIR: dir }, stdio: ['pipe', 'pipe', 'inherit'] });
    let seen;
    try {
      seen = await firstLine(child);
    } finally {
      child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    }
    // Written before the browser opened; the process died holding the display lock, with no chance to clean up.
    assert.equal(seen.opened, 1);
    assert.match(seen.record?.reason ?? 'no record', OWN(child.pid!));
    const record = readDisplayUnknown({ dir });
    assert.deepEqual(record, seen.record);
    assert.ok(record?.runId, 'names the run');

    // The next run (another project root): the dead owner's lock is reclaimed, the record refuses the browser.
    const next = new FakeDriver(index());
    const blocked = await runSite(next, displayDeps(dir));
    assert.deepEqual([blocked.verdict, blocked.code, blocked.qaStatus], ['ERROR', 'display_unknown', 'BLOCKED']);
    assert.ok(blocked.reason.includes(`실행 ${record.runId}: qa 프로세스(pid ${child.pid})가 연 데스크톱 브라우저의 세션 종료가 아직 확인되지 않음`), blocked.reason);
    assert.match(blocked.reason, /화면에 남은 브라우저 창을 닫은 뒤 qa setup --browsers로 해제하세요$/);
    assert.equal(next.called('open').length, 0);
    assert.deepEqual(readDisplayUnknown({ dir }), record);

    // `qa doctor` reports it; `qa setup --browsers` (the dead owner's lock reclaimed) clears it; browsers run again.
    const doctor = displayStateCheck({ dir });
    assert.equal(doctor.ok, false);
    assert.ok(doctor.detail.includes(record.reason), doctor.detail);
    assert.equal(clearDisplayState({ dir }).ok, true);
    const again = new FakeDriver(index());
    assert.equal((await runSite(again, displayDeps(dir))).verdict, 'PASS');
    assert.equal(readDisplayUnknown({ dir }), null, 'a run whose browser end was confirmed leaves no record');
  });

  it('is on disk from before the browser opens until its confirmed end, then removed: tests, smoke, capture and inspect', async () => {
    const dir = join(tempRoot(), 'app-qa-display');
    /** Whether this process's record is on disk at each open and close of `driver`. */
    const watch = (driver: FakeDriver) => {
      const seen: string[] = [];
      const note = (what: string) => seen.push(`${what}: ${OWN(process.pid).test(readDisplayUnknown({ dir })?.reason ?? '') ? 'recorded' : 'none'}`);
      const [open, close] = [driver.open.bind(driver), driver.close.bind(driver)];
      driver.open = async (app) => (note('open'), open(app));
      driver.close = async () => (note('close'), close());
      return seen;
    };
    const deps = (driver: FakeDriver) => ({ ...fakeDeps(tempRoot(), driver), ...displayDeps(dir) });
    const whileOpen = ['open: recorded', 'close: recorded'];

    const tested = new FakeDriver(index());
    const testSeen = watch(tested);
    assert.equal((await runSite(tested, displayDeps(dir))).verdict, 'PASS');
    assert.deepEqual(testSeen, whileOpen);
    assert.equal(readDisplayUnknown({ dir }), null);

    const smoked = new FakeDriver(index());
    const smokeSeen = watch(smoked);
    assert.equal((await runSmoke({ app: 'web-demo', platform: 'desktop-chrome' }, deps(smoked))).tests[0]!.verdict, 'PASS');
    assert.deepEqual(smokeSeen, whileOpen);
    assert.equal(readDisplayUnknown({ dir }), null);

    const captured = new FakeDriver(index());
    const captureSeen = watch(captured);
    await captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, deps(captured));
    const inspected = new FakeDriver(index());
    const inspectSeen = watch(inspected);
    await inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, deps(inspected));
    assert.deepEqual([captureSeen, inspectSeen], [whileOpen, whileOpen]);
    assert.equal(readDisplayUnknown({ dir }), null);

    // A page that never shows content fails the inspect, but its browser end was confirmed: no record either.
    const blank = new FakeDriver({ ...index(), nodes: [] });
    const blankSeen = watch(blank);
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, deps(blank)), /시작 페이지가 .*내용을 표시하지 않음/);
    assert.deepEqual(blankSeen, whileOpen);
    assert.equal(readDisplayUnknown({ dir }), null);

    // A refused start opened no window.
    const refused = new FakeDriver(index());
    refused.openError = new RefusedError('Chrome 실행 파일 없음');
    assert.equal((await runSite(refused, displayDeps(dir))).code, 'session_failed');
    assert.equal(readDisplayUnknown({ dir }), null);
  });

  it('opens no browser when the record cannot be written first', async () => {
    const released: string[] = [];
    const unwritable: Partial<RunnerDeps> = {
      acquireDisplayLock: () => ({ release: () => released.push('display') }),
      readDisplayUnknown: () => null,
      markDisplayUnknown: () => {
        throw new Error('EACCES: permission denied');
      },
    };
    const refusal = /^데스크톱 화면 사용 기록을 남기지 못해 브라우저를 열지 않음 \(EACCES: permission denied\) — 이 프로세스가 비정상 종료하면 남은 창을 다음 실행이 알 수 없음$/;
    const tested = new FakeDriver(index());
    const t = await runSite(tested, unwritable);
    assert.deepEqual([t.verdict, t.code, t.qaStatus], ['ERROR', 'session_failed', 'BLOCKED']);
    assert.match(t.reason, refusal);
    const smoked = new FakeDriver(index());
    const s = (await runSmoke({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), smoked), ...unwritable })).tests[0]!;
    assert.deepEqual([s.verdict, s.code], ['ERROR', 'session_failed']);
    assert.match(s.reason, refusal);
    const screen = new FakeDriver(index());
    await assert.rejects(captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, { ...fakeDeps(tempRoot(), screen), ...unwritable }), (err: Error) => refusal.test(err.message));
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), screen), ...unwritable }), (err: Error) => refusal.test(err.message));
    assert.equal(tested.called('open').length + smoked.called('open').length + screen.called('open').length, 0);
    // Nothing opened, so the display is handed on.
    assert.deepEqual(released, ['display', 'display', 'display', 'display']);
  });
});
