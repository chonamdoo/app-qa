import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import type { QaEventBody } from '../../src/core/events.ts';
import type { Platform, Point, Rect, Snapshot } from '../../src/core/types.ts';
import { RefusedError, StepError } from '../../src/drivers/index.ts';
import { appTarget, captureScreen, inspectScreen, runSmoke, runTests, type InspectResult, type RunnerDeps } from '../../src/runner/index.ts';
import { AppProfile } from '../../src/spec/schema.ts';
import { FakeClock, FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { choice, commitSafe, jevStub, noul, webCalibration } from '../helpers/jev-stub.ts';
import { fakeDeps, readJsonl, runYaml, tempRoot } from '../helpers/run.ts';

const index = (opts: { patch?: [string, string][]; pageUrl?: string | null } = {}) => fixtureSnapshot('desktop-chrome', 'web-demo', 'index', opts);

function web(steps: string, start = 'attach'): string {
  return `name: 웹 테스트\napp: web-demo\nstart: ${start}\nsteps:\n${steps}`;
}

describe('web targets', () => {
  it('builds the website target per platform from the profile, and no desktop target for an app', () => {
    const site = AppProfile.parse({ id: 'shop', name: 'Shop', web: { url: 'http://localhost:4173/start?x=1' } });
    assert.deepEqual(appTarget(site, 'desktop-safari'), {
      kind: 'web',
      platform: 'desktop-safari',
      appId: 'safari',
      url: 'http://localhost:4173/start?x=1',
      origins: ['http://localhost:4173'],
      viewport: { width: 1280, height: 800 },
    });
    assert.equal(appTarget(site, 'android')?.appId, 'com.android.chrome');
    assert.equal(appTarget(site, 'ios')?.appId, 'com.apple.mobilesafari');
    const narrowed = AppProfile.parse({ id: 'shop', name: 'Shop', web: { url: 'https://a.example/', origins: ['https://a.example', 'https://b.example'], platforms: ['desktop-chrome'] } });
    const chrome = appTarget(narrowed, 'desktop-chrome');
    assert.ok(chrome?.kind === 'web');
    assert.deepEqual(chrome.origins, ['https://a.example', 'https://b.example']);
    const app = AppProfile.parse({ id: 'a', name: 'A', android: { package: 'kr.a.app', activity: '.Main' }, ios: { bundleId: 'kr.a.app' } });
    assert.equal(appTarget(app, 'desktop-chrome'), null);
    assert.deepEqual(appTarget(app, 'android'), { kind: 'app', platform: 'android', appId: 'kr.a.app', activity: '.Main' });
  });

  it('`all` runs a website on every browser platform (desktop browsers claimed like devices) and an app only on devices', async () => {
    const clock = new FakeClock();
    const screens: Record<Platform, Snapshot> = {
      android: fixtureSnapshot('android', 'web-demo', 'index'),
      ios: fixtureSnapshot('ios', 'web-demo', 'index'),
      'desktop-chrome': index(),
      'desktop-safari': { ...index(), platform: 'desktop-safari' },
    };
    const root = tempRoot({
      'tests/site.e2e.yaml': web('  - assertText: 상품 3개\n'),
      'tests/app.e2e.yaml': 'name: 앱 테스트\napp: tteonam\nstart: attach\nsteps:\n  - wait: 10\n',
    });
    const claimed: string[] = [];
    const result = await runTests(
      { paths: [join(root, 'tests')], platform: 'all' },
      {
        ...fakeDeps(root, new FakeDriver(index(), clock)),
        createDriver: (platform) => new FakeDriver(screens[platform], clock),
        pickDevice: async (platform) => ({ platform, id: `${platform}-1`, name: platform, osVersion: '1', state: 'booted', kind: platform.startsWith('desktop') ? 'browser' : 'emulator' }),
        acquireLock: (id) => {
          claimed.push(id);
          return { release: () => undefined };
        },
      },
    );
    const rows = result.tests.map((t) => `${t.id} ${t.platform} ${t.surface} ${t.verdict}`).sort();
    assert.deepEqual(rows, [
      'app android app PASS',
      'app ios app PASS',
      'site android web PASS',
      'site desktop-chrome web PASS',
      'site desktop-safari web PASS',
      'site ios web PASS',
    ]);
  });

  it('asks the desktop hit-test before a tap and refuses a target the page would not receive', async () => {
    const driver = new FakeDriver(index());
    driver.hittable = () => false;
    const { result } = await runYaml({ 'tests/h.e2e.yaml': web('  - tap: 도움말\n') }, driver, { platform: 'desktop-chrome', jev: commitSafe(webCalibration()).setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'stale_target', t.reason);
    assert.match(t.reason, /isHittable=false/);
    assert.equal(driver.called('tap').length, 0);
    // The element box is passed so the driver can tell whether elementFromPoint lands inside it.
    assert.deepEqual(driver.called('isHittable')[0]!.args[1], { x: 1175, y: 12, width: 74, height: 44 });
  });

  it('refuses safe web taps until the commit check is calibrated on web screens, then taps', async () => {
    const help = fixtureSnapshot('desktop-chrome', 'web-demo', 'index-help');
    const run = async (calibrated: boolean) => {
      const driver = new FakeDriver(index());
      driver.hittable = () => true;
      driver.onTap = (p) => (hits(index(), '도움말', p) ? help : null);
      const jev = commitSafe(calibrated ? webCalibration() : undefined);
      return { driver, run: await runYaml({ 'tests/c.e2e.yaml': web('  - tap: 도움말\n') }, driver, { platform: 'desktop-chrome', jev: jev.setup }) };
    };
    const app = await run(false);
    const t = app.run.result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'commit_check_unavailable', t.reason);
    assert.match(t.reason, /웹 화면 commit 보정 전/);
    assert.equal(t.qaStatus, 'BLOCKED');
    assert.equal(app.driver.called('tap').length, 0);

    const calibrated = await run(true);
    assert.equal(calibrated.run.result.tests[0]!.verdict, 'PASS', calibrated.run.result.tests[0]!.reason);
    assert.equal(calibrated.driver.called('tap').length, 1);
  });

  it('refuses a tap whose element was replaced while Jev answered, even with the same label, box, state and tree position', async () => {
    // The page re-renders 도움말 during the commit check: the tree (and so every DFS node id) is identical, only the
    // element under the tap point is another one (another W3C element reference).
    const run = async (after: string | null) => {
      const driver = new FakeDriver(index());
      driver.hittable = () => true;
      let element: string | null = 'element-old';
      const asked: Point[] = [];
      driver.elementIdAt = async (p) => {
        asked.push(p);
        return element;
      };
      const jev = jevStub((_id, q) => {
        element = after;
        return q.type === 'noul' ? noul(0.02) : choice(q, 'none', 0.9);
      }, webCalibration());
      const { result } = await runYaml({ 'tests/r.e2e.yaml': web('  - tap: 도움말\n    expectNoChange: true\n') }, driver, { platform: 'desktop-chrome', jev: jev.setup });
      return { driver, asked, t: result.tests[0]! };
    };
    for (const after of ['element-new', null]) {
      const replaced = await run(after);
      assert.equal(replaced.t.code, 'stale_target', `${after}: ${replaced.t.reason}`);
      assert.equal(replaced.driver.called('tap').length, 0, String(after));
    }
    const same = await run('element-old');
    assert.equal(same.t.verdict, 'PASS', same.t.reason);
    const [tap] = same.driver.called('tap');
    // Asked before the check and again at the point actually tapped.
    assert.equal(same.asked.length, 2);
    assert.deepEqual(same.asked[1], tap!.args[0]);
  });

  it('refuses a tap whose button was replaced while Jev answered by one that adopted its child: the identity is the target element, not the deepest one', async () => {
    // `<button><span>도움말</span></button>`: elementFromPoint finds the span, which a new button with the same tree
    // position, id, box and state took over. The page answers per box: 도움말's box is the button's, not the span's.
    const HELP = { x: 1175, y: 12, width: 74, height: 44 };
    const run = async (after: string) => {
      const driver = new FakeDriver(index());
      driver.hittable = () => true;
      let button = 'button-old';
      const boxes: (Rect | null)[] = [];
      driver.elementIdAt = async (_p, box) => {
        boxes.push(box);
        const isHelp = box !== null && box !== undefined && (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(box[k] - HELP[k]) <= 2);
        return isHelp ? button : 'span';
      };
      const jev = jevStub((_id, q) => {
        button = after;
        return q.type === 'noul' ? noul(0.02) : choice(q, 'none', 0.9);
      }, webCalibration());
      const { result } = await runYaml({ 'tests/r.e2e.yaml': web('  - tap: 도움말\n    expectNoChange: true\n') }, driver, { platform: 'desktop-chrome', jev: jev.setup });
      return { driver, boxes, t: result.tests[0]! };
    };
    const replaced = await run('button-new');
    assert.equal(replaced.t.code, 'stale_target', replaced.t.reason);
    assert.equal(replaced.driver.called('tap').length, 0);
    // Asked with the target's element box before the check and on the observation after it.
    assert.deepEqual(replaced.boxes, [HELP, HELP]);
    const same = await run('button-old');
    assert.equal(same.t.verdict, 'PASS', same.t.reason);
    assert.equal(same.driver.called('tap').length, 1);
  });

  it('refuses Enter (press: enter, type.submit) whose focused field was replaced while Jev answered, even with the same path, id, box, value and state', async () => {
    // The page re-renders the focused 비밀번호 field during the Enter's commit check: the tree (and so every DFS node id,
    // resource id, box, value and state) is identical, only document.activeElement is another element.
    const login = fixtureSnapshot('desktop-chrome', 'web-demo', 'login-email');
    const steps = {
      'press: enter': '  - press: enter\n    expectNoChange: true\n',
      'type.submit': '  - type: pw1234\n    into: { id: password }\n    submit: true\n    expectNoChange: true\n',
    };
    const run = async (step: string, after: string | null) => {
      const driver = new FakeDriver(login);
      driver.hittable = () => true;
      let focused: string | null = 'field-old';
      let reads = 0;
      driver.focusedElementId = async () => {
        reads++;
        return focused;
      };
      // Replaced during the Enter's own commit check (type.submit asks one before typing, for the field).
      const jev = jevStub((_id, q) => {
        if (!step.includes('submit') || driver.called('typeText').length > 0) focused = after;
        return q.type === 'noul' ? noul(0.02) : choice(q, 'none', 0.9);
      }, webCalibration());
      const { result } = await runYaml({ 'tests/e.e2e.yaml': web(step) }, driver, { platform: 'desktop-chrome', jev: jev.setup });
      return { driver, reads, t: result.tests[0]! };
    };
    for (const [name, step] of Object.entries(steps)) {
      for (const after of ['field-new', null]) {
        const replaced = await run(step, after);
        assert.equal(replaced.t.code, 'stale_target', `${name} ${after}: ${replaced.t.reason}`);
        assert.equal(replaced.driver.called('press').length, 0, `${name} ${after}`);
      }
      const same = await run(step, 'field-old');
      assert.equal(same.t.verdict, 'PASS', `${name}: ${same.t.reason}`);
      assert.deepEqual(same.driver.called('press').map((c) => c.args[0]), ['enter'], name);
      // Read before the check and again on the observation after it.
      assert.equal(same.reads, 2, name);
    }
  });

  it('launching a website waits through empty first dumps, and a page that never shows content is ERROR page_not_ready', async () => {
    const blank: Snapshot = { ...index(), nodes: [] };
    const late = new FakeDriver(blank);
    let sinceLaunch = -1;
    late.onAction = (method) => {
      if (method === 'launch') sinceLaunch = 0;
    };
    late.onSnapshot = (d) => {
      if (sinceLaunch >= 0 && ++sinceLaunch > 5) d.screen = index();
    };
    // Without the readiness wait the launch would settle on two equal empty dumps, and the next step (no time left to
    // wait) would see an empty page.
    const ok = await runYaml({ 'tests/l.e2e.yaml': web('  - assertText: 상품 3개\n    timeout: 1\n', 'launch') }, late, { platform: 'desktop-chrome' });
    assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);

    const never = new FakeDriver(blank);
    const { result } = await runYaml({ 'tests/n.e2e.yaml': web('  - assertText: 상품 3개\n', 'launch') }, never, { platform: 'desktop-chrome' });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'page_not_ready', t.reason);
    assert.equal(t.qaStatus, 'BLOCKED');
    assert.equal(never.called('launch').length, 1);
  });

  it('fails a page outside the allowed origins with the address as evidence', async () => {
    const driver = new FakeDriver(index({ pageUrl: 'https://evil.example/landing' }));
    const { result } = await runYaml({ 'tests/o.e2e.yaml': web('  - assertText: 상품 3개\n') }, driver, { platform: 'desktop-chrome' });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'origin_mismatch', t.reason);
    assert.match(t.health[0]!.evidence, /https:\/\/evil\.example.*http:\/\/localhost:4173/);
  });

  it('`open` goes only inside the origins: a path resolves on the first origin, anything else is blocked before dispatch', async () => {
    const driver = new FakeDriver(index());
    const ok = await runYaml({ 'tests/p.e2e.yaml': web('  - open: /login.html?next=%2F\n    expectNoChange: true\n') }, driver, { platform: 'desktop-chrome' });
    assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);
    assert.deepEqual(driver.called('openUrl').map((c) => c.args[1]), ['http://localhost:4173/login.html?next=%2F']);

    for (const url of ['https://evil.example/', '//evil.example/x', 'javascript:alert(1)', 'login.html']) {
      const blocked = new FakeDriver(index());
      const { result } = await runYaml({ 'tests/b.e2e.yaml': web(`  - open: "${url}"\n    allowRisky: true\n`) }, blocked, { platform: 'desktop-chrome' });
      assert.equal(result.tests[0]!.code, 'blocked_by_policy', `${url}: ${result.tests[0]!.reason}`);
      assert.equal(blocked.called('openUrl').length, 0, url);
    }
  });

  it('inspect opens the site at its start URL and waits for content (a fresh browser shows a blank tab)', async () => {
    const driver = new FakeDriver({ ...index({ pageUrl: 'about:blank' }), nodes: [] });
    let opened = -1;
    driver.onAction = (method) => {
      if (method === 'openUrl') opened = 0;
    };
    driver.onSnapshot = (d) => {
      if (opened >= 0 && ++opened > 2) d.screen = index();
    };
    const root = tempRoot();
    const { table } = await inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, fakeDeps(root, driver));
    assert.deepEqual(driver.called('openUrl').map((c) => c.args[1]), ['http://localhost:4173/']);
    assert.match(table, /\| button \| 도움말 \|/);
    assert.match(table, /페이지 http:\/\/localhost:4173\//);
  });
});

describe('sequential device-owned web execution', () => {
  const drivers = (): Record<Platform, FakeDriver> => {
    const clock = new FakeClock();
    return {
      android: new FakeDriver(fixtureSnapshot('android', 'web-demo', 'index'), clock),
      ios: new FakeDriver(fixtureSnapshot('ios', 'web-demo', 'index'), clock),
      'desktop-chrome': new FakeDriver(index(), clock),
      'desktop-safari': new FakeDriver({ ...index(), platform: 'desktop-safari' }, clock),
    };
  };
  const runAll = async (d: Record<Platform, FakeDriver>, overrides: Partial<RunnerDeps> = {}) => {
    const root = tempRoot({
      'tests/site.e2e.yaml': web('  - assertText: 상품 3개\n'),
      'tests/app.e2e.yaml': 'name: 앱 테스트\napp: tteonam\nstart: attach\nsteps:\n  - wait: 10\n',
    });
    const events: QaEventBody[] = [];
    const result = await runTests(
      { paths: [join(root, 'tests')], platform: 'all', events: { emit: (e) => events.push(e) } },
      {
        ...fakeDeps(root, d['desktop-chrome']),
        clock: d.android.clock,
        createDriver: (platform) => d[platform],
        pickDevice: async (platform) => ({ platform, id: `${platform}-1`, name: platform, osVersion: '1', state: 'booted', kind: platform.startsWith('desktop') ? 'browser' : 'emulator' }),
        ...overrides,
      },
    );
    return { result };
  };

  it('never opens another device while the preceding session cleanup is pending', { timeout: 5_000 }, async () => {
    const d = drivers();
    const closing = Promise.withResolvers<void>();
    const finishClose = Promise.withResolvers<void>();
    const active = new Set<Platform>();
    for (const platform of Object.keys(d) as Platform[]) {
      const driver = d[platform];
      const open = driver.open.bind(driver);
      const close = driver.close.bind(driver);
      driver.open = async target => {
        assert.equal(active.size, 0, `Opened ${platform} before ${[...active]} finished cleanup`);
        active.add(platform);
        await open(target);
      };
      driver.close = async () => {
        await close();
        if (platform === 'desktop-chrome') {
          closing.resolve();
          await finishClose.promise;
        }
        assert.ok(active.delete(platform));
      };
    }
    const pending = runAll(d);
    try {
      await Promise.race([closing.promise, pending.then(() => assert.fail('Run ended before Chrome cleanup'))]);
      assert.equal(d['desktop-safari'].called('open').length, 0);
      assert.deepEqual([...active], ['desktop-chrome']);
    } finally { finishClose.resolve(); }
    const { result } = await pending;
    assert.equal(result.tests.length, 6);
    assert.ok(result.tests.every(test => test.verdict === 'PASS'));
    assert.equal(active.size, 0);
  });

  it('stops later device preparation after an unexpected error and releases every acquired lock once', async () => {
    const d = drivers();
    const boom = new Error('증거 쓰기 실패');
    const acquired: string[] = [];
    const released: string[] = [];
    const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
    await assert.rejects(runAll(d, {
      admission,
      createDriver: platform => {
        if (platform === 'desktop-chrome') throw boom;
        return d[platform];
      },
      acquireLock: id => {
        acquired.push(id);
        return { release: () => { released.push(id); } };
      },
    }), boom);
    assert.deepEqual(released.sort(), acquired.sort());
    assert.equal(new Set(released).size, released.length);
    assert.equal(d['desktop-safari'].called('open').length, 0);
    assert.equal(admission.status().state, 'unknown');
  });

  it('quarantines an unconfirmed close and prevents a later device or entry point from opening', async () => {
    const d = drivers();
    const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
    const failure = new StepError({ status: 'uncertain', ms: 0, error: 'guest browser close unknown' });
    d['desktop-chrome'].closeError = failure;
    await assert.rejects(runAll(d, { admission }), failure);
    assert.equal(d['desktop-chrome'].called('close').length, 1);
    assert.equal(d['desktop-safari'].called('open').length, 0);
    assert.equal(admission.status().state, 'unknown');
    await assert.rejects(inspectScreen(
      { app: 'web-demo', platform: 'desktop-safari' },
      { ...fakeDeps(tempRoot(), d['desktop-safari']), admission },
    ), { code: 'execution_reconciliation_required' });
    assert.equal(d['desktop-safari'].called('open').length, 0);
  });

  it('continues sequentially after a proven session rejection and confirmed cleanup', async () => {
    const d = drivers();
    d['desktop-chrome'].openError = new RefusedError('guest browser unavailable');
    const { result } = await runAll(d);
    assert.equal(result.tests.find(test => test.platform === 'desktop-chrome')!.code, 'session_failed');
    assert.ok(result.tests.filter(test => test.platform !== 'desktop-chrome').every(test => test.verdict === 'PASS'));
  });

  it('quarantines an uncertain session start instead of authorizing the next device', async () => {
    const d = drivers();
    const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
    d['desktop-chrome'].openError = new StepError({ status: 'uncertain', ms: 0, error: 'guest session start unknown' });
    const { result } = await runAll(d, { admission });
    const failed = result.tests.find(test => test.platform === 'desktop-chrome')!;
    assert.deepEqual([failed.verdict, failed.code, failed.qaStatus], ['ERROR', 'session_failed', 'BLOCKED']);
    assert.equal(d['desktop-safari'].called('open').length, 0);
    assert.equal(admission.status().state, 'unknown');
  });

  it('reports a busy device without opening it and continues the remaining sequential work', async () => {
    const d = drivers();
    const { result } = await runAll(d, {
      acquireLock: id => {
        if (id === 'desktop-chrome-1') throw new Error('device already owned');
        return { release: () => undefined };
      },
    });
    const blocked = result.tests.find(test => test.platform === 'desktop-chrome')!;
    assert.deepEqual([blocked.verdict, blocked.code, blocked.qaStatus], ['ERROR', 'device_locked', 'BLOCKED']);
    assert.equal(d['desktop-chrome'].called('open').length, 0);
    assert.ok(result.tests.filter(test => test.platform !== 'desktop-chrome').every(test => test.verdict === 'PASS'));
  });
});

describe('smoke, capture and inspect on a desktop browser', () => {
  const lockLog = (log: string[], busy: string | null = null): Pick<RunnerDeps, 'acquireLock'> => {
    const take = (id: string) => {
      if (id === busy) throw new Error(`${id}: 다른 qa 프로세스(pid 4242)가 사용 중`);
      log.push(`acquire ${id}`);
      return { release: () => log.push(`release ${id}`) };
    };
    return { acquireLock: take };
  };
  const smoke = async (driver: FakeDriver, platform: Platform, deps: Partial<RunnerDeps>) => {
    const events: QaEventBody[] = [];
    const app = platform.startsWith('desktop') ? 'web-demo' : 'tteonam';
    const result = await runSmoke({ app, platform, events: { emit: (e) => events.push(e) } }, { ...fakeDeps(tempRoot(), driver), ...deps });
    return { t: result.tests[0]!, result, events };
  };
  const uncertainClose = () => new StepError({ status: 'uncertain', ms: 0, error: '브라우저 세션 종료를 확인하지 못했습니다: socket hang up' });
  const phone = () => new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));

  for (const cancelled of [false, true]) {
    it(cancelled ? 'cancels a queued entry point without touching the active flow' : 'queues another entry point until native cleanup and required evidence finish', { timeout: 5_000 }, async () => {
      const root = tempRoot();
      const admission = createExecutionAdmission(join(root, '.qa', 'test-admission'), { pollIntervalMs: 1 });
      const device = phone();
      const browser = new FakeDriver(index(), new FakeClock(), 'queued-browser');
      const closing = Promise.withResolvers<void>();
      const finishClose = Promise.withResolvers<void>();
      const queued = Promise.withResolvers<void>();
      const close = device.close.bind(device);
      let finalized = false;
      const open = browser.open.bind(browser);
      browser.open = async target => {
        assert.equal(finalized, true);
        await open(target);
      };
      device.close = async () => {
        await close();
        closing.resolve();
        await finishClose.promise;
      };
      const first = runSmoke({
        app: 'tteonam', platform: 'android',
        events: { emit: event => {
          if (event.type !== 'run.finished') return;
          assert.equal(admission.status().state, 'active');
          finalized = true;
        } },
      }, { ...fakeDeps(root, device), admission });
      const controller = new AbortController();
      let second: Promise<InspectResult> | undefined;
      let reachedCleanup = false;
      try {
        await Promise.race([closing.promise, first.then(() => assert.fail('Smoke ended before native cleanup'))]);
        const wait = admission.wait.bind(admission);
        second = inspectScreen({ app: 'web-demo', platform: 'desktop-chrome', signal: controller.signal }, {
          ...fakeDeps(root, browser),
          admission: { ...admission, wait: (ownerId, resourceId, signal) => {
            const pending = wait(ownerId, resourceId, signal);
            queued.resolve();
            return pending;
          } },
        });
        await queued.promise;
        assert.equal(browser.calls.length, 0);
        assert.equal(finalized, false);
        assert.equal(admission.status().state, 'active');
        if (cancelled) {
          controller.abort();
          await assert.rejects(second, { code: 'execution_cancelled', effect: 'not_started' });
          assert.equal(browser.calls.length, 0);
          assert.equal(admission.status().state, 'active');
        }
        reachedCleanup = true;
      } finally {
        if (!reachedCleanup) controller.abort();
        finishClose.resolve();
        await Promise.allSettled([first, ...((cancelled || !reachedCleanup) && second ? [second] : [])]);
      }
      await first;
      if (!cancelled) {
        assert.ok(second);
        await second;
        assert.equal(browser.called('open').length, 1);
      }
      assert.equal(finalized, true);
      assert.equal(admission.status().state, 'idle');
    });
  }

  it('quarantines unconfirmed native and desktop cleanup even when observation also fails', async () => {
    const cases = [
      ['desktop-chrome', new FakeDriver(index())],
      ['desktop-chrome', new FakeDriver({ ...index(), nodes: [] })],
      ['android', phone()],
    ] as const;
    for (const [platform, driver] of cases) {
      const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
      const failure = uncertainClose();
      driver.closeError = failure;
      await assert.rejects(smoke(driver, platform, { admission }), failure);
      assert.equal(driver.called('close').length, 1);
      assert.equal(admission.status().state, 'unknown');
    }
  });

  it('reports session start failure without retrying and quarantines only unconfirmed starts', async () => {
    for (const uncertain of [false, true]) {
      const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
      const driver = new FakeDriver(index());
      driver.openError = uncertain
        ? new StepError({ status: 'uncertain', ms: 0, error: 'guest session start unknown' })
        : new RefusedError('guest browser unavailable');
      const { t } = await smoke(driver, 'desktop-chrome', { admission });
      assert.deepEqual([t.verdict, t.code, t.qaStatus], ['ERROR', 'session_failed', 'BLOCKED']);
      assert.equal(driver.called('open').length, 1);
      assert.equal(admission.status().state, uncertain ? 'unknown' : 'idle');
    }
  });

  it('quarantines a sticky driver problem even when close resolves successfully', async () => {
    const chrome = new FakeDriver(index());
    const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
    const close = chrome.close.bind(chrome);
    let closed = false;
    chrome.close = async () => { await close(); closed = true; };
    chrome.displayProblem = () => closed ? 'guest browser end unknown' : null;
    await assert.rejects(smoke(chrome, 'desktop-chrome', { admission }), /guest browser end unknown/);
    assert.equal(chrome.called('close').length, 1);
    assert.equal(admission.status().state, 'unknown');
  });

  it('a smoke that fails after its session opened says so; it is not a session that could not be opened', async () => {
    for (const [platform, driver] of [['android', phone()], ['desktop-chrome', new FakeDriver(index())]] as const) {
      const broken = await smoke(driver, platform, {
        jev: () => {
          throw new Error('Jev 설정을 읽지 못함');
        },
      });
      assert.deepEqual([broken.t.verdict, broken.t.code], ['ERROR', 'internal'], platform);
      assert.equal(driver.called('open').length, 1, platform);
      assert.equal(driver.called('close').length, 1, platform);
    }
  });

  it('emits one final smoke verdict matching its stored events and summary', async () => {
    const broken = await smoke(new FakeDriver(index()), 'desktop-chrome', {
      jev: () => { throw new Error('Jev 설정을 읽지 못함'); },
    });
    assert.equal(broken.t.code, 'internal', broken.t.reason);
    const finished = broken.events.flatMap(e => e.type === 'test.finished' ? [[e.verdict, e.reason, e.durationMs]] : []);
    assert.deepEqual(finished, [['ERROR', broken.t.reason, broken.t.durationMs]]);
    const stored = readJsonl(join(broken.result.runDir, 'events.jsonl')).filter(e => e.type === 'test.finished');
    const summary = JSON.parse(readFileSync(join(broken.result.runDir, 'summary.json'), 'utf8')) as { tests: { verdict: string; reason: string }[] };
    assert.deepEqual(stored.map(e => [e.verdict, e.reason]), summary.tests.map(test => [test.verdict, test.reason]));

    const ok = await smoke(new FakeDriver(index()), 'desktop-chrome', {});
    assert.deepEqual(ok.events.flatMap(e => e.type === 'test.finished' ? [e.verdict] : []), ['PASS']);
    const busy = new FakeDriver(index());
    const refused = await smoke(busy, 'desktop-chrome', lockLog([], busy.deviceId));
    assert.deepEqual(refused.events.flatMap(e => e.type === 'test.finished' ? [e.verdict] : []), ['ERROR']);
  });

  it('releases the selected device after confirmed cleanup and refuses a busy device before opening', async () => {
    for (const [platform, driver] of [['desktop-chrome', new FakeDriver(index())], ['android', phone()]] as const) {
      const log: string[] = [];
      assert.equal((await smoke(driver, platform, lockLog(log))).t.verdict, 'PASS');
      assert.deepEqual(log, ['acquire ' + driver.deviceId, 'release ' + driver.deviceId]);
    }
    const driver = new FakeDriver(index());
    const refused = await smoke(driver, 'desktop-chrome', lockLog([], driver.deviceId));
    assert.deepEqual([refused.t.code, refused.t.qaStatus], ['device_locked', 'BLOCKED']);
    assert.equal(driver.called('open').length, 0);
  });

  it('capture and inspect quarantine native and desktop cleanup failures', async () => {
    for (const operation of ['capture', 'inspect'] as const) {
      for (const [platform, driver, app] of [['desktop-chrome', new FakeDriver(index()), 'web-demo'], ['android', phone(), 'tteonam']] as const) {
        const failure = new Error('session close unknown');
        driver.closeError = failure;
        const log: string[] = [];
        const admission = createExecutionAdmission(join(tempRoot(), '.qa', 'test-admission'));
        const deps = { ...fakeDeps(tempRoot(), driver), ...lockLog(log), admission };
        await assert.rejects(operation === 'capture'
          ? captureScreen({ app, platform, name: 'shot' }, deps)
          : inspectScreen({ app, platform }, deps), failure);
        assert.equal(driver.called('close').length, 1);
        assert.equal(admission.status().state, 'unknown');
        assert.deepEqual(log, ['acquire ' + driver.deviceId, 'release ' + driver.deviceId]);
      }
    }

    const refused = new FakeDriver(index());
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), refused), ...lockLog([], refused.deviceId) }), /다른 qa 프로세스/);
    assert.equal(refused.called('open').length, 0);
  });
});
