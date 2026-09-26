import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Platform, Snapshot } from '../../src/core/types.ts';
import { appTarget, inspectScreen, runTests } from '../../src/runner/index.ts';
import { AppProfile } from '../../src/spec/schema.ts';
import { FakeClock, FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { commitSafe, webCalibration } from '../helpers/jev-stub.ts';
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
    assert.deepEqual(claimed.sort(), ['android-1', 'desktop-chrome-1', 'desktop-safari-1', 'ios-1']);
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
