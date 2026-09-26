import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { QaEventBody } from '../../src/core/events.ts';
import type { Platform, Point, Rect, Snapshot } from '../../src/core/types.ts';
import { acquireDisplayLock, clearDisplayUnknown, readDisplayUnknown, RefusedError, StepError } from '../../src/drivers/index.ts';
import { appTarget, captureScreen, inspectScreen, runSmoke, runTests, type RunnerDeps } from '../../src/runner/index.ts';
import { AppProfile } from '../../src/spec/schema.ts';
import { FakeClock, FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { choice, commitSafe, jevStub, noul, webCalibration } from '../helpers/jev-stub.ts';
import { displayDeps, fakeDeps, readJsonl, runYaml, tempRoot } from '../helpers/run.ts';

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
        acquireDisplayLock: () => {
          claimed.push('display');
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
    assert.deepEqual(claimed.sort(), ['android-1', 'desktop-chrome-1', 'desktop-safari-1', 'display', 'ios-1']);
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
      assert.match(replaced.t.reason, /Jev commit 확인 중 "도움말" 탭 지점의 요소가 다른 요소로 바뀜/);
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
    assert.match(replaced.t.reason, /Jev commit 확인 중 "도움말" 탭 지점의 요소가 다른 요소로 바뀜/);
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
        assert.match(replaced.t.reason, /Jev commit 확인 중 포커스된 "비밀번호"이\(가\) 다른 요소로 바뀜/, name);
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

describe('the desktop lane (every desktop browser on one display)', () => {
  const drivers = (): Record<Platform, FakeDriver> => {
    const clock = new FakeClock();
    return {
      android: new FakeDriver(fixtureSnapshot('android', 'web-demo', 'index'), clock),
      ios: new FakeDriver(fixtureSnapshot('ios', 'web-demo', 'index'), clock),
      'desktop-chrome': new FakeDriver(index(), clock),
      'desktop-safari': new FakeDriver({ ...index(), platform: 'desktop-safari' }, clock),
    };
  };
  /** A website test and an app test under `all`: the site runs on both desktop browsers (Chrome first), the app and the site on each device. */
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
    const rows = result.tests.map((t) => `${t.id} ${t.platform} ${t.verdict} ${t.code ?? '-'}`).sort();
    return { result, rows, events };
  };

  it('runs no further browser once a session end is unconfirmed; a device session end failure changes nothing', async () => {
    const d = drivers();
    d['desktop-chrome'].closeError = new StepError({ status: 'uncertain', ms: 0, error: '브라우저 세션 종료를 확인하지 못했습니다: socket hang up' });
    d.android.closeError = new Error('device offline');
    const { result, rows, events } = await runAll(d);
    assert.deepEqual(rows, [
      'app android PASS -',
      'app ios PASS -',
      'site android PASS -',
      'site desktop-chrome PASS -',
      'site desktop-safari ERROR display_unknown',
      'site ios PASS -',
    ]);
    const safari = result.tests.find((t) => t.platform === 'desktop-safari')!;
    assert.equal(safari.qaStatus, 'BLOCKED');
    assert.match(safari.reason, /데스크톱 화면 상태를 알 수 없어 .*Chrome \(macOS\) 세션 종료를 확인하지 못함 \(브라우저 세션 종료를 확인하지 못했습니다: socket hang up\)/);
    assert.equal(d['desktop-safari'].called('open').length, 0, 'Safari never opened a window next to the old one');
    assert.ok(events.some((e) => e.type === 'log' && e.level === 'error' && e.message === safari.reason));
  });

  it('runs no further browser after a session start that may have left a window; a refused start does not stop the lane', async () => {
    const uncertain = drivers();
    uncertain['desktop-chrome'].openError = new StepError({ status: 'uncertain', ms: 0, error: '세션 생성 시간 초과' });
    const stopped = await runAll(uncertain);
    assert.ok(stopped.rows.includes('site desktop-chrome ERROR session_failed'), stopped.rows.join('\n'));
    assert.ok(stopped.rows.includes('site desktop-safari ERROR display_unknown'), stopped.rows.join('\n'));
    assert.match(stopped.result.tests.find((t) => t.platform === 'desktop-safari')!.reason, /Chrome \(macOS\) 세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음/);
    assert.equal(uncertain['desktop-safari'].called('open').length, 0);

    const refused = drivers();
    refused['desktop-chrome'].openError = new RefusedError('Chrome 실행 파일 없음');
    const went = await runAll(refused);
    assert.ok(went.rows.includes('site desktop-chrome ERROR session_failed'), went.rows.join('\n'));
    assert.ok(went.rows.includes('site desktop-safari PASS -'), went.rows.join('\n'));
  });

  it('a session end left unconfirmed inside a test stops the lane when that test ends: the rest of its app and every later browser are display_unknown, never started', async () => {
    const LOST = '브라우저 세션 종료를 확인하지 못했습니다: socket hang up';
    const cause = `Chrome (macOS) 테스트 s1 중 세션 시작 또는 종료를 확인하지 못함 (${LOST})`;
    for (const closes of ['fails', 'confirms'] as const) {
      const shared = join(tempRoot(), 'app-qa-display');
      const d = drivers();
      const chrome = d['desktop-chrome'];
      chrome.endError = LOST;
      // close() fails on the lost session (the desktop driver's behaviour); even one that reports an end changes nothing.
      const close = chrome.close.bind(chrome);
      if (closes === 'confirms') chrome.close = () => close().catch(() => undefined);
      const root = tempRoot({
        'tests/s1.e2e.yaml': web('  - assertText: 상품 3개\n', 'launch\nreset: clear'),
        'tests/s2.e2e.yaml': web('  - assertText: 상품 3개\n'),
        'tests/s3.e2e.yaml': web('  - assertText: 상품 3개\n'),
      });
      const events: QaEventBody[] = [];
      const result = await runTests(
        { paths: [join(root, 'tests')], platform: 'all', events: { emit: (e) => events.push(e) } },
        {
          ...fakeDeps(root, chrome),
          ...displayDeps(shared),
          clock: d.android.clock,
          createDriver: (platform) => d[platform],
          pickDevice: async (platform) => ({ platform, id: `${platform}-1`, name: platform, osVersion: '1', state: 'booted', kind: platform.startsWith('desktop') ? 'browser' : 'emulator' }),
        },
      );
      const rows = result.tests.map((t) => `${t.id} ${t.platform} ${t.verdict} ${t.code ?? '-'}`).sort();
      assert.deepEqual(rows, [
        's1 android PASS -',
        's1 desktop-chrome ERROR uncertain_action',
        's1 desktop-safari ERROR display_unknown',
        's1 ios PASS -',
        's2 android PASS -',
        's2 desktop-chrome ERROR display_unknown',
        's2 desktop-safari ERROR display_unknown',
        's2 ios PASS -',
        's3 android PASS -',
        's3 desktop-chrome ERROR display_unknown',
        's3 desktop-safari ERROR display_unknown',
        's3 ios PASS -',
      ], closes);
      const first = result.tests.find((t) => t.id === 's1' && t.platform === 'desktop-chrome')!;
      assert.match(first.reason, /행동 결과 불확실\(reset\): 브라우저 세션 종료를 확인하지 못했습니다: socket hang up/, `${closes}: the test that lost the session keeps its own result`);
      for (const t of result.tests.filter((t) => t.code === 'display_unknown')) {
        assert.equal(t.qaStatus, 'BLOCKED');
        assert.equal(t.reason, `데스크톱 화면 상태를 알 수 없어 남은 브라우저 테스트를 실행하지 않음: ${cause}`, closes);
      }
      // Never started (no test.started); the lost Chrome session is closed once, as before; Safari never opens.
      const started = events.flatMap((e) => (e.type === 'test.started' && e.platform.startsWith('desktop') ? [`${e.testId} ${e.platform}`] : []));
      assert.deepEqual(started, ['s1 desktop-chrome'], closes);
      assert.equal(chrome.called('close').length, 1, closes);
      assert.equal(d['desktop-safari'].called('open').length, 0, closes);
      // Recorded once, from the driver's own reason; it stays after the display lock goes, whatever close() said.
      assert.equal(events.filter((e) => e.type === 'log' && e.level === 'error' && /데스크톱 화면 상태를 알 수 없어/.test(e.message)).length, 1, closes);
      const record = readDisplayUnknown({ dir: shared });
      assert.deepEqual([record?.runId, record?.reason], [result.runId, cause], closes);
    }
  });

  it('releases every claimed lock once when a desktop slot throws, each only after its own lane finished', async () => {
    const d = drivers();
    const boom = new Error('증거 쓰기 실패');
    const released: string[] = [];
    await assert.rejects(
      runAll(d, {
        createDriver: (platform) => {
          if (platform === 'desktop-chrome') throw boom;
          return d[platform];
        },
        acquireLock: (id) => ({ release: () => released.push(`${id} closes=${d[id.replace(/-1$/, '') as Platform].called('close').length}`) }),
        acquireDisplayLock: () => ({ release: () => released.push(`display closes=${d['desktop-chrome'].called('close').length + d['desktop-safari'].called('close').length}`) }),
      }),
      boom,
    );
    // Devices ran both apps (two sessions closed) before their locks went; Safari never ran behind the throwing Chrome.
    assert.deepEqual(released.sort(), ['android-1 closes=2', 'desktop-chrome-1 closes=0', 'desktop-safari-1 closes=0', 'display closes=0', 'ios-1 closes=2']);
  });

  it('holds the display lock from before the first browser opens until the last one closed; a run without a desktop platform never takes it', async () => {
    const d = drivers();
    const browsers = (method: string) => d['desktop-chrome'].called(method).length + d['desktop-safari'].called(method).length;
    const log: string[] = [];
    const { rows } = await runAll(d, {
      acquireDisplayLock: () => {
        log.push(`acquire display opens=${browsers('open')}`);
        return { release: () => log.push(`release display closes=${browsers('close')}`) };
      },
    });
    assert.ok(rows.every((r) => r.endsWith('PASS -')), rows.join('\n'));
    assert.deepEqual(log, ['acquire display opens=0', 'release display closes=2']);

    // `all` with only an app test plans no desktop platform.
    const root = tempRoot({ 'tests/app.e2e.yaml': 'name: 앱 테스트\napp: tteonam\nstart: attach\nsteps:\n  - wait: 10\n' });
    const taken: string[] = [];
    const apps = drivers();
    const { tests } = await runTests(
      { paths: [join(root, 'tests')], platform: 'all' },
      {
        ...fakeDeps(root, apps.android),
        createDriver: (platform) => apps[platform],
        pickDevice: async (platform) => ({ platform, id: `${platform}-1`, name: platform, osVersion: '1', state: 'booted', kind: 'emulator' }),
        acquireLock: (id) => {
          taken.push(id);
          return { release: () => undefined };
        },
        acquireDisplayLock: () => {
          taken.push('display');
          return { release: () => undefined };
        },
      },
    );
    assert.deepEqual(tests.map((t) => `${t.platform} ${t.verdict}`).sort(), ['android PASS', 'ios PASS']);
    assert.deepEqual(taken.sort(), ['android-1', 'ios-1']);
  });

  it('a display held by a qa process of any checkout refuses every desktop platform like a busy device; devices still run', async () => {
    // The display lock is one host file, not a project's: a live holder from another checkout (another project root —
    // here this test process) refuses this run's browsers.
    const shared = join(tempRoot(), 'app-qa-display');
    const other = acquireDisplayLock({ dir: shared });
    const d = drivers();
    const held = await runAll(d, displayDeps(shared));
    other.release();
    assert.deepEqual(held.rows, [
      'app android PASS -',
      'app ios PASS -',
      'site android PASS -',
      'site desktop-chrome ERROR device_locked',
      'site desktop-safari ERROR device_locked',
      'site ios PASS -',
    ]);
    for (const t of held.result.tests.filter((t) => t.platform.startsWith('desktop'))) {
      assert.equal(t.qaStatus, 'BLOCKED');
      assert.match(t.reason, new RegExp(`^데스크톱 화면: 다른 qa 프로세스\\(pid ${process.pid}, `));
    }
    assert.equal(d['desktop-chrome'].called('open').length + d['desktop-safari'].called('open').length, 0);
    // Once released, a run from yet another project root opens its browsers.
    const free = await runAll(drivers(), displayDeps(shared));
    assert.ok(free.rows.every((r) => r.endsWith('PASS -')), free.rows.join('\n'));
    // The same outcome as a browser whose own lock is held.
    const device = await runAll(drivers(), {
      acquireLock: (id) => {
        if (id === 'desktop-chrome-1') throw new Error(`${id}: 다른 qa 프로세스(pid 4242)가 사용 중`);
        return { release: () => undefined };
      },
    });
    const chrome = (r: typeof held) => r.result.tests.find((t) => t.platform === 'desktop-chrome')!;
    assert.deepEqual([chrome(device).verdict, chrome(device).code, chrome(device).qaStatus], [chrome(held).verdict, chrome(held).code, chrome(held).qaStatus]);
  });

  it('a display left unknown is recorded host-wide before its lock goes: no run of any checkout opens a browser until it is cleared; devices still run', async () => {
    const shared = join(tempRoot(), 'app-qa-display');
    const lost = drivers();
    lost['desktop-chrome'].closeError = new StepError({ status: 'uncertain', ms: 0, error: '브라우저 세션 종료를 확인하지 못했습니다: socket hang up' });
    const released: boolean[] = [];
    const first = await runAll(lost, {
      ...displayDeps(shared),
      acquireDisplayLock: () => {
        const lock = acquireDisplayLock({ dir: shared });
        return { release: () => (released.push(readDisplayUnknown({ dir: shared }) !== null), lock.release()) };
      },
    });
    assert.ok(first.rows.includes('site desktop-safari ERROR display_unknown'), first.rows.join('\n'));
    assert.deepEqual(released, [true], 'recorded before the display lock was released');
    const record = readDisplayUnknown({ dir: shared })!;
    assert.equal(record.runId, first.result.runId);
    assert.equal(record.reason, 'Chrome (macOS) 세션 종료를 확인하지 못함 (브라우저 세션 종료를 확인하지 못했습니다: socket hang up)');

    // The next run, from another project root: no browser opens, the devices run.
    const next = drivers();
    const blocked = await runAll(next, displayDeps(shared));
    assert.deepEqual(blocked.rows, [
      'app android PASS -',
      'app ios PASS -',
      'site android PASS -',
      'site desktop-chrome ERROR display_unknown',
      'site desktop-safari ERROR display_unknown',
      'site ios PASS -',
    ]);
    for (const t of blocked.result.tests.filter((t) => t.platform.startsWith('desktop'))) {
      assert.equal(t.qaStatus, 'BLOCKED');
      assert.match(t.reason, /^데스크톱 화면 상태를 알 수 없어 브라우저를 열지 않음 \(.* 실행 .*: Chrome \(macOS\) 세션 종료를 확인하지 못함 .*\) — 화면에 남은 브라우저 창을 닫은 뒤 qa setup --browsers로 해제하세요$/);
    }
    assert.equal(next['desktop-chrome'].called('open').length + next['desktop-safari'].called('open').length, 0);

    // Cleared (`qa setup --browsers`, after the leftover windows were closed): browsers run again.
    assert.equal(clearDisplayUnknown({ dir: shared }), true);
    const again = await runAll(drivers(), displayDeps(shared));
    assert.ok(again.rows.every((r) => r.endsWith('PASS -')), again.rows.join('\n'));
  });
});

describe('smoke, capture and inspect on a desktop browser', () => {
  const lockLog = (log: string[], busy: string | null = null): Pick<RunnerDeps, 'acquireLock' | 'acquireDisplayLock'> => {
    const take = (id: string) => {
      if (id === busy) throw new Error(`${id}: 다른 qa 프로세스(pid 4242)가 사용 중`);
      log.push(`acquire ${id}`);
      return { release: () => log.push(`release ${id}`) };
    };
    return { acquireLock: take, acquireDisplayLock: () => take('display') };
  };
  const smoke = async (driver: FakeDriver, platform: Platform, deps: Partial<RunnerDeps>) => {
    const events: QaEventBody[] = [];
    const app = platform.startsWith('desktop') ? 'web-demo' : 'tteonam';
    const result = await runSmoke({ app, platform, events: { emit: (e) => events.push(e) } }, { ...fakeDeps(tempRoot(), driver), ...deps });
    return { t: result.tests[0]!, result, events };
  };
  const uncertainClose = () => new StepError({ status: 'uncertain', ms: 0, error: '브라우저 세션 종료를 확인하지 못했습니다: socket hang up' });
  const phone = () => new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));

  it('a smoke whose browser session end is unconfirmed is ERROR display_unknown; a device session end failure changes nothing', async () => {
    const chrome = new FakeDriver(index());
    chrome.closeError = new StepError({ status: 'uncertain', ms: 0, error: '브라우저 세션 종료를 확인하지 못했습니다: socket hang up' });
    const lost = await smoke(chrome, 'desktop-chrome', lockLog([]));
    assert.equal(lost.t.verdict, 'ERROR', lost.t.reason);
    assert.equal(lost.t.code, 'display_unknown');
    assert.equal(lost.t.qaStatus, 'BLOCKED');
    assert.deepEqual(lost.result.counts.ERROR, 1);
    assert.match(lost.t.reason, /^데스크톱 화면 상태를 알 수 없음: Chrome \(macOS\) 세션 종료를 확인하지 못함 \(브라우저 세션 종료를 확인하지 못했습니다: socket hang up\)$/);
    assert.ok(lost.events.some((e) => e.type === 'log' && e.level === 'error' && e.message === lost.t.reason));

    // A smoke that already failed keeps its own result in the reason.
    const blank = new FakeDriver({ ...index(), nodes: [] });
    blank.closeError = new Error('socket hang up');
    const both = await smoke(blank, 'desktop-chrome', lockLog([]));
    assert.equal(both.t.code, 'display_unknown', both.t.reason);
    assert.match(both.t.reason, /세션 종료를 확인하지 못함 \(socket hang up\); 스모크 결과 ERROR page_not_ready: /);

    // A session start that failed without a refusal may have left a window too; a refused one did not.
    const hung = new FakeDriver(index());
    hung.openError = new StepError({ status: 'uncertain', ms: 0, error: '세션 생성 시간 초과' });
    const started = await smoke(hung, 'desktop-chrome', lockLog([]));
    assert.equal(started.t.code, 'display_unknown', started.t.reason);
    assert.match(started.t.reason, /세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음 \(세션 생성 시간 초과\); 스모크 결과 ERROR session_failed/);
    const missing = new FakeDriver(index());
    missing.openError = new RefusedError('Chrome 실행 파일 없음');
    assert.equal((await smoke(missing, 'desktop-chrome', lockLog([]))).t.code, 'session_failed');

    const device = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    device.closeError = new Error('device offline');
    assert.equal((await smoke(device, 'android', lockLog([]))).t.verdict, 'PASS');
  });

  it('a smoke whose relaunch leaves the session end unconfirmed is ERROR display_unknown from the driver’s own reason, recorded once, even when close() then reports an end', async () => {
    const LOST = '브라우저 세션 종료를 확인하지 못했습니다: socket hang up';
    for (const closes of ['fails', 'confirms'] as const) {
      const shared = join(tempRoot(), 'app-qa-display');
      const chrome = new FakeDriver(index());
      chrome.endError = LOST;
      if (closes === 'confirms') chrome.close = async () => undefined;
      const lost = await smoke(chrome, 'desktop-chrome', displayDeps(shared));
      assert.deepEqual([lost.t.verdict, lost.t.code, lost.t.qaStatus], ['ERROR', 'display_unknown', 'BLOCKED'], `${closes}: ${lost.t.reason}`);
      const cause = `Chrome (macOS) 스모크 중 세션 시작 또는 종료를 확인하지 못함 (${LOST})`;
      assert.ok(lost.t.reason.startsWith(`데스크톱 화면 상태를 알 수 없음: ${cause}; 스모크 결과 ERROR uncertain_action: `), `${closes}: ${lost.t.reason}`);
      assert.equal(lost.events.filter((e) => e.type === 'log' && e.level === 'error' && /데스크톱 화면 상태를 알 수 없음/.test(e.message)).length, 1, closes);
      // The record stays (the window may be on screen), whatever close() said.
      assert.equal(readDisplayUnknown({ dir: shared })?.reason, cause, closes);
    }
  });

  it('a smoke that fails after its session opened says so; it is not a session that could not be opened', async () => {
    for (const [platform, driver] of [['android', phone()], ['desktop-chrome', new FakeDriver(index())]] as const) {
      const broken = await smoke(driver, platform, {
        jev: () => {
          throw new Error('Jev 설정을 읽지 못함');
        },
      });
      assert.deepEqual([broken.t.verdict, broken.t.code, broken.t.reason], ['ERROR', 'internal', '실행 오류: Jev 설정을 읽지 못함'], platform);
      assert.equal(driver.called('open').length, 1, platform);
      assert.equal(driver.called('close').length, 1, platform);
    }
  });

  it('the smoke’s one test.finished carries the final verdict, after the session end: the event stream agrees with summary.json', async () => {
    const chrome = new FakeDriver(index());
    chrome.closeError = uncertainClose();
    const lost = await smoke(chrome, 'desktop-chrome', {});
    assert.equal(lost.t.code, 'display_unknown', lost.t.reason);
    const finished = lost.events.flatMap((e) => (e.type === 'test.finished' ? [[e.verdict, e.reason, e.durationMs]] : []));
    assert.deepEqual(finished, [['ERROR', lost.t.reason, lost.t.durationMs]]);
    // The stored stream (what `qa serve` and the Mac app replay) says what summary.json says.
    const stored = readJsonl(join(lost.result.runDir, 'events.jsonl')).filter((e) => e.type === 'test.finished');
    const summary = JSON.parse(readFileSync(join(lost.result.runDir, 'summary.json'), 'utf8')) as { tests: { verdict: string; reason: string }[] };
    assert.deepEqual(stored.map((e) => [e.verdict, e.reason]), summary.tests.map((t) => [t.verdict, t.reason]));

    const ok = await smoke(new FakeDriver(index()), 'desktop-chrome', {});
    assert.deepEqual(ok.events.flatMap((e) => (e.type === 'test.finished' ? [e.verdict] : [])), ['PASS']);
    const refused = await smoke(new FakeDriver(index()), 'desktop-chrome', lockLog([], 'display'));
    assert.deepEqual(refused.events.flatMap((e) => (e.type === 'test.finished' ? [e.verdict] : [])), ['ERROR']);
  });

  it('a smoke, capture or inspect that leaves the display unknown records it before its lock goes; none opens a browser until it is cleared; devices still run', async () => {
    const shared = join(tempRoot(), 'app-qa-display');
    const log: string[] = [];
    const chrome = new FakeDriver(index());
    chrome.closeError = uncertainClose();
    const lost = await smoke(chrome, 'desktop-chrome', {
      ...displayDeps(shared),
      acquireDisplayLock: () => {
        const lock = acquireDisplayLock({ dir: shared });
        return { release: () => (log.push(`release display, recorded ${readDisplayUnknown({ dir: shared }) !== null}`), lock.release()) };
      },
    });
    assert.equal(lost.t.code, 'display_unknown', lost.t.reason);
    assert.deepEqual(log, ['release display, recorded true']);
    assert.deepEqual(readDisplayUnknown({ dir: shared }), { since: readDisplayUnknown({ dir: shared })!.since, reason: 'Chrome (macOS) 세션 종료를 확인하지 못함 (브라우저 세션 종료를 확인하지 못했습니다: socket hang up)', runId: lost.result.runId });

    // Another smoke (any project root), a capture and an inspect: refused before any browser opens.
    const safari = new FakeDriver({ ...index(), platform: 'desktop-safari' });
    const next = await smoke(safari, 'desktop-safari', displayDeps(shared));
    assert.deepEqual([next.t.verdict, next.t.code, next.t.qaStatus], ['ERROR', 'display_unknown', 'BLOCKED']);
    assert.match(next.t.reason, /^데스크톱 화면 상태를 알 수 없어 브라우저를 열지 않음 \(.*: Chrome \(macOS\) 세션 종료를 확인하지 못함 .*\) — 화면에 남은 브라우저 창을 닫은 뒤 qa setup --browsers로 해제하세요$/);
    const screen = new FakeDriver(index());
    await assert.rejects(captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, { ...fakeDeps(tempRoot(), screen), ...displayDeps(shared) }), /qa setup --browsers로 해제하세요/);
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), screen), ...displayDeps(shared) }), /qa setup --browsers로 해제하세요/);
    assert.equal(safari.called('open').length + screen.called('open').length, 0);
    assert.equal((await smoke(phone(), 'android', displayDeps(shared))).t.verdict, 'PASS');

    // Cleared: browsers open again. A capture whose session start is unconfirmed records it as well.
    assert.equal(clearDisplayUnknown({ dir: shared }), true);
    assert.equal((await smoke(new FakeDriver(index()), 'desktop-chrome', displayDeps(shared))).t.verdict, 'PASS');
    const hung = new FakeDriver(index());
    hung.openError = new StepError({ status: 'uncertain', ms: 0, error: '세션 생성 시간 초과' });
    await assert.rejects(
      captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, { ...fakeDeps(tempRoot(), hung), ...displayDeps(shared) }),
      /^Error: 데스크톱 화면 상태를 알 수 없음: Chrome \(macOS\) 세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음 \(세션 생성 시간 초과\)$/,
    );
    assert.equal(readDisplayUnknown({ dir: shared })?.reason, 'Chrome (macOS) 세션 시작이 확인되지 않은 채 실패해 창이 남았을 수 있음 (세션 생성 시간 초과)');
  });

  it('a display state that cannot be recorded keeps the display lock for the rest of the process, and says so', async () => {
    const log: string[] = [];
    const chrome = new FakeDriver(index());
    chrome.closeError = uncertainClose();
    // This process's own record (before the browser opened) is written; the unconfirmed end cannot be.
    let writes = 0;
    const lost = await smoke(chrome, 'desktop-chrome', {
      ...lockLog(log),
      markDisplayUnknown: () => {
        if (writes++ > 0) throw new Error('EACCES: permission denied');
      },
    });
    assert.equal(lost.t.code, 'display_unknown', lost.t.reason);
    assert.deepEqual(log, ['acquire display', `acquire ${chrome.deviceId}`, `release ${chrome.deviceId}`]);
    assert.ok(lost.events.some((e) => e.type === 'log' && e.level === 'error' && /데스크톱 화면 상태를 기록하지 못해 이 프로세스가 끝날 때까지 화면 잠금을 유지함 \(EACCES: permission denied\)/.test(e.message)));
  });

  it('smoke takes the display lock for a desktop browser only and releases it; a held display refuses it like a busy device', async () => {
    const log: string[] = [];
    const chrome = new FakeDriver(index());
    assert.equal((await smoke(chrome, 'desktop-chrome', lockLog(log))).t.verdict, 'PASS');
    assert.deepEqual(log, ['acquire display', `acquire ${chrome.deviceId}`, `release ${chrome.deviceId}`, 'release display']);

    const deviceLog: string[] = [];
    const device = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    await smoke(device, 'android', lockLog(deviceLog));
    assert.deepEqual(deviceLog, [`acquire ${device.deviceId}`, `release ${device.deviceId}`]);

    const refused = new FakeDriver(index());
    const busy = await smoke(refused, 'desktop-chrome', lockLog([], 'display'));
    assert.equal(busy.t.code, 'device_locked', busy.t.reason);
    assert.equal(busy.t.qaStatus, 'BLOCKED');
    assert.equal(refused.called('open').length, 0);
  });

  it('capture and inspect lock the display, and throw when the browser session end is unconfirmed', async () => {
    const log: string[] = [];
    const lost = new FakeDriver(index());
    lost.closeError = new Error('socket hang up');
    await assert.rejects(captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, { ...fakeDeps(tempRoot(), lost), ...lockLog(log) }), /^Error: 데스크톱 화면 상태를 알 수 없음: Chrome \(macOS\) 세션 종료를 확인하지 못함 \(socket hang up\)$/);
    assert.deepEqual(log, ['acquire display', `acquire ${lost.deviceId}`, `release ${lost.deviceId}`, 'release display']);
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), lost), ...lockLog([]) }), /데스크톱 화면 상태를 알 수 없음/);

    const device = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    device.closeError = new Error('device offline');
    const deviceLog: string[] = [];
    await captureScreen({ app: 'tteonam', platform: 'android', name: 'shot' }, { ...fakeDeps(tempRoot(), device), ...lockLog(deviceLog) });
    assert.deepEqual(deviceLog, [`acquire ${device.deviceId}`, `release ${device.deviceId}`]);

    const refused = new FakeDriver(index());
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), refused), ...lockLog([], 'display') }), /display: 다른 qa 프로세스/);
    assert.equal(refused.called('open').length, 0);
  });
});
