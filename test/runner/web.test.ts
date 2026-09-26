import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { QaEventBody } from '../../src/core/events.ts';
import type { Platform, Point, Snapshot } from '../../src/core/types.ts';
import { RefusedError, StepError } from '../../src/drivers/index.ts';
import { appTarget, captureScreen, inspectScreen, runSmoke, runTests, type RunnerDeps } from '../../src/runner/index.ts';
import { AppProfile } from '../../src/spec/schema.ts';
import { FakeClock, FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { choice, commitSafe, jevStub, noul, webCalibration } from '../helpers/jev-stub.ts';
import { fakeDeps, runYaml, tempRoot } from '../helpers/run.ts';

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
    assert.deepEqual(claimed.sort(), ['android-1', 'desktop-chrome-1', 'desktop-display', 'desktop-safari-1', 'ios-1']);
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
        acquireLock: (id) => {
          const closes = () => (id === 'desktop-display' ? d['desktop-chrome'].called('close').length + d['desktop-safari'].called('close').length : d[id.replace(/-1$/, '') as Platform].called('close').length);
          return { release: () => released.push(`${id} closes=${closes()}`) };
        },
      }),
      boom,
    );
    // Devices ran both apps (two sessions closed) before their locks went; Safari never ran behind the throwing Chrome.
    assert.deepEqual(released.sort(), ['android-1 closes=2', 'desktop-chrome-1 closes=0', 'desktop-display closes=0', 'desktop-safari-1 closes=0', 'ios-1 closes=2']);
  });

  it('holds the display lock from before the first browser opens until the last one closed; a run without a desktop platform never takes it', async () => {
    const d = drivers();
    const browsers = (method: string) => d['desktop-chrome'].called(method).length + d['desktop-safari'].called(method).length;
    const log: string[] = [];
    const { rows } = await runAll(d, {
      acquireLock: (id) => {
        log.push(`acquire ${id} opens=${browsers('open')}`);
        return { release: () => log.push(`release ${id} closes=${browsers('close')}`) };
      },
    });
    assert.ok(rows.every((r) => r.endsWith('PASS -')), rows.join('\n'));
    assert.deepEqual(
      log.filter((l) => l.includes('desktop-display')),
      ['acquire desktop-display opens=0', 'release desktop-display closes=2'],
    );

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
      },
    );
    assert.deepEqual(tests.map((t) => `${t.platform} ${t.verdict}`).sort(), ['android PASS', 'ios PASS']);
    assert.deepEqual(taken.sort(), ['android-1', 'ios-1']);
  });

  it('a display held by another qa process refuses every desktop platform like a busy device; devices still run', async () => {
    const outcome = async (busy: string) => {
      const d = drivers();
      const { result, rows } = await runAll(d, {
        acquireLock: (id) => {
          if (id === busy) throw new Error(`${id}: 다른 qa 프로세스(pid 4242)가 사용 중`);
          return { release: () => undefined };
        },
      });
      return { d, result, rows };
    };
    const display = await outcome('desktop-display');
    assert.deepEqual(display.rows, [
      'app android PASS -',
      'app ios PASS -',
      'site android PASS -',
      'site desktop-chrome ERROR device_locked',
      'site desktop-safari ERROR device_locked',
      'site ios PASS -',
    ]);
    for (const t of display.result.tests.filter((t) => t.platform.startsWith('desktop'))) {
      assert.equal(t.qaStatus, 'BLOCKED');
      assert.match(t.reason, /데스크톱 화면 사용 중: desktop-display: 다른 qa 프로세스\(pid 4242\)가 사용 중/);
    }
    assert.equal(display.d['desktop-chrome'].called('open').length + display.d['desktop-safari'].called('open').length, 0);
    // The same outcome as a browser whose own lock is held.
    const device = await outcome('desktop-chrome-1');
    const chrome = (r: typeof display) => r.result.tests.find((t) => t.platform === 'desktop-chrome')!;
    assert.deepEqual([chrome(device).verdict, chrome(device).code, chrome(device).qaStatus], [chrome(display).verdict, chrome(display).code, chrome(display).qaStatus]);
  });
});

describe('smoke, capture and inspect on a desktop browser', () => {
  const lockLog = (log: string[], busy: string | null = null): Pick<RunnerDeps, 'acquireLock'> => ({
    acquireLock: (id) => {
      if (id === busy) throw new Error(`${id}: 다른 qa 프로세스(pid 4242)가 사용 중`);
      log.push(`acquire ${id}`);
      return { release: () => log.push(`release ${id}`) };
    },
  });
  const smoke = async (driver: FakeDriver, platform: Platform, locks: Pick<RunnerDeps, 'acquireLock'>) => {
    const events: QaEventBody[] = [];
    const app = platform.startsWith('desktop') ? 'web-demo' : 'tteonam';
    const result = await runSmoke({ app, platform, events: { emit: (e) => events.push(e) } }, { ...fakeDeps(tempRoot(), driver), ...locks });
    return { t: result.tests[0]!, result, events };
  };

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

  it('smoke takes the display lock for a desktop browser only and releases it; a held display refuses it like a busy device', async () => {
    const log: string[] = [];
    const chrome = new FakeDriver(index());
    assert.equal((await smoke(chrome, 'desktop-chrome', lockLog(log))).t.verdict, 'PASS');
    assert.deepEqual(log, ['acquire desktop-display', `acquire ${chrome.deviceId}`, `release ${chrome.deviceId}`, 'release desktop-display']);

    const deviceLog: string[] = [];
    const device = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    await smoke(device, 'android', lockLog(deviceLog));
    assert.deepEqual(deviceLog, [`acquire ${device.deviceId}`, `release ${device.deviceId}`]);

    const refused = new FakeDriver(index());
    const busy = await smoke(refused, 'desktop-chrome', lockLog([], 'desktop-display'));
    assert.equal(busy.t.code, 'device_locked', busy.t.reason);
    assert.equal(busy.t.qaStatus, 'BLOCKED');
    assert.equal(refused.called('open').length, 0);
  });

  it('capture and inspect lock the display, and throw when the browser session end is unconfirmed', async () => {
    const log: string[] = [];
    const lost = new FakeDriver(index());
    lost.closeError = new Error('socket hang up');
    await assert.rejects(captureScreen({ app: 'web-demo', platform: 'desktop-chrome', name: 'shot' }, { ...fakeDeps(tempRoot(), lost), ...lockLog(log) }), /^Error: 데스크톱 화면 상태를 알 수 없음: Chrome \(macOS\) 세션 종료를 확인하지 못함 \(socket hang up\)$/);
    assert.deepEqual(log, ['acquire desktop-display', `acquire ${lost.deviceId}`, `release ${lost.deviceId}`, 'release desktop-display']);
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), lost), ...lockLog([]) }), /데스크톱 화면 상태를 알 수 없음/);

    const device = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    device.closeError = new Error('device offline');
    const deviceLog: string[] = [];
    await captureScreen({ app: 'tteonam', platform: 'android', name: 'shot' }, { ...fakeDeps(tempRoot(), device), ...lockLog(deviceLog) });
    assert.deepEqual(deviceLog, [`acquire ${device.deviceId}`, `release ${device.deviceId}`]);

    const refused = new FakeDriver(index());
    await assert.rejects(inspectScreen({ app: 'web-demo', platform: 'desktop-chrome' }, { ...fakeDeps(tempRoot(), refused), ...lockLog([], 'desktop-display') }), /desktop-display: 다른 qa 프로세스/);
    assert.equal(refused.called('open').length, 0);
  });
});
