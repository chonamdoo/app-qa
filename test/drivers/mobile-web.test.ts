// Web targets on the native drivers (Android Chrome, iOS Safari) over a fake adb / xcrun and a scripted Appium server:
// target validation, Chrome readiness and prep, localhost port routing ownership, VIEW intents, simctl openurl,
// address-bar page URL, Safari back button and the Safari website-data wipe.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { W3C_ELEMENT_KEY } from '../../src/appium/client.ts';
import { adb } from '../../src/appium/exec.ts';
import type { AppTarget, WebTarget } from '../../src/core/types.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { targetProblem } from '../../src/drivers/appid.ts';
import { listApps } from '../../src/drivers/apps.ts';
import { backupApp } from '../../src/drivers/backup.ts';
import { failureStatus } from '../../src/drivers/base.ts';
import { prepareAndroidChrome } from '../../src/drivers/browser-prep.ts';
import { IosDriver } from '../../src/drivers/ios.ts';
import { installFakeAdb, installFakeXcrun, scriptOf, startAppiumStub, type AppiumStub, type FakeAdb, type FakeXcrun } from './stubs.ts';

const VIEWPORT = { width: 1280, height: 800 };
const CHROME_WEB: WebTarget = {
  kind: 'web',
  platform: 'android',
  appId: 'com.android.chrome',
  url: 'http://localhost:4173/',
  origins: ['http://localhost:4173', 'http://127.0.0.1:9000', 'https://cdn.example.com'],
  viewport: VIEWPORT,
};
const SAFARI_WEB: WebTarget = { kind: 'web', platform: 'ios', appId: 'com.apple.mobilesafari', url: 'http://localhost:4173/', origins: ['http://localhost:4173'], viewport: VIEWPORT };
const UDID = 'SIM-UDID';
const VIEW_INTENT = ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d'];
const TAB_REUSE = ['-p', 'com.android.chrome', '--es', 'com.android.browser.application_id', 'app-qa'];

/** Chrome installed and prepared the way `qa setup --browsers` leaves it. */
function prepareChrome(fake: FakeAdb): void {
  fake.state('chrome-installed', '1');
  fake.state('debug_app', 'com.android.chrome\n');
  fake.state('chrome-command-line', '_ --disable-fre --no-first-run --no-default-browser-check\n');
  fake.state('granted', 'android.permission.POST_NOTIFICATIONS\n');
}

const amCalls = (fake: FakeAdb) => fake.deviceCalls().filter((c) => c[0] === 'am');

describe('web target validation on the native drivers', () => {
  let fake: FakeAdb;
  beforeEach(() => {
    fake = installFakeAdb();
  });
  afterEach(() => fake.restore());

  it('accepts the platform browser with an http(s) start URL inside its origins', () => {
    assert.equal(targetProblem('android', CHROME_WEB), null);
    assert.equal(targetProblem('ios', SAFARI_WEB), null);
    assert.equal(targetProblem('ios', { ...SAFARI_WEB, origins: [] }), null, 'no declared origins = the start URL origin');
  });

  it('refuses desktop, wrong-browser and unsafe-URL targets before any host command runs', async () => {
    const android = new AndroidDriver('emulator-5554');
    const ios = new IosDriver(UDID);
    const bad: [AppTarget, RegExp][] = [
      [{ ...CHROME_WEB, platform: 'desktop-chrome', appId: 'chrome' }, /Android 드라이버는 Chrome \(macOS\) 대상을 실행할 수 없습니다/],
      [{ kind: 'app', platform: 'desktop-safari', appId: 'kr.tteonam.app' }, /Android 드라이버는 Safari \(macOS\) 대상을/],
      [{ ...SAFARI_WEB }, /Android 드라이버는 iOS 대상을/],
      [{ ...CHROME_WEB, appId: 'org.mozilla.firefox' }, /브라우저 ID가 올바르지 않습니다/],
      [{ ...CHROME_WEB, url: 'http://qa:hunter2@localhost:4173/' }, /계정 정보/],
      [{ ...CHROME_WEB, url: 'javascript:alert(1)' }, /http\(s\) 주소만/],
      [{ ...CHROME_WEB, url: 'file:///etc/passwd' }, /http\(s\) 주소만/],
      [{ ...CHROME_WEB, origins: ['http://localhost:4173/admin'] }, /scheme:\/\/host\[:port\]/],
      [{ ...CHROME_WEB, url: 'https://evil.example/' }, /허용된 origin\(.*\) 밖의 주소는 열지 않습니다: https:\/\/evil\.example/],
    ];
    for (const [target, reason] of bad) {
      for (const o of [await android.launch(target), await android.openUrl(target, 'http://localhost:4173/'), await android.reset(target, 'clear'), await android.terminate(target)]) {
        assert.equal(o.status, 'rejected', `${JSON.stringify(target)}: ${o.error}`);
        assert.match(o.error ?? '', reason);
        assert.doesNotMatch(o.error ?? '', /hunter2/, 'credentials are never echoed');
      }
      await assert.rejects(android.open(target), reason);
    }
    assert.equal((await ios.launch({ ...CHROME_WEB, platform: 'ios' })).status, 'rejected', 'Chrome is not the iOS browser');
    assert.deepEqual(fake.hostCalls(), []);
  });

  it('a web openUrl outside the allowed origins or not http(s) is refused', async () => {
    const android = new AndroidDriver('emulator-5554');
    for (const url of ['https://evil.example/login', 'intent://scan#Intent;end', 'http://localhost:5000/']) {
      const o = await android.openUrl(CHROME_WEB, url);
      assert.equal(o.status, 'rejected', url);
    }
    assert.deepEqual(amCalls(fake), []);
  });

  it('desktop platforms have no installed apps to list or back up (no fallthrough to a device)', async () => {
    await assert.rejects(listApps('desktop-chrome', 'desktop-chrome'), /Chrome \(macOS\)에는 설치 앱 목록이 없습니다/);
    await assert.rejects(backupApp('desktop-safari', 'desktop-safari', 'kr.tteonam.app'), /Safari \(macOS\)에는 설치 앱이 없어/);
    assert.deepEqual(fake.hostCalls(), []);
  });
});

describe('Android Chrome web targets', () => {
  let fake: FakeAdb;
  let stub: AppiumStub | null = null;
  beforeEach(() => {
    fake = installFakeAdb();
  });
  afterEach(() => {
    stub?.close();
    stub = null;
    fake.restore();
  });

  it('launch routes every localhost origin port, then loads the start URL in the app-qa tab', async () => {
    const o = await new AndroidDriver('emulator-5554').launch(CHROME_WEB);
    assert.equal(o.status, 'completed', o.error ?? '');
    assert.deepEqual(fake.reverseList(), ['host-1 tcp:4173 tcp:4173', 'host-1 tcp:9000 tcp:9000'], 'the https CDN origin is not a host port');
    assert.deepEqual(amCalls(fake), [[...VIEW_INTENT, 'http://localhost:4173/', ...TAB_REUSE]]);
  });

  it('openUrl reuses the same tab for an allowed URL', async () => {
    const o = await new AndroidDriver('emulator-5554').openUrl(CHROME_WEB, 'http://127.0.0.1:9000/login?next=%2F');
    assert.equal(o.status, 'completed', o.error ?? '');
    assert.deepEqual(amCalls(fake), [[...VIEW_INTENT, 'http://127.0.0.1:9000/login?next=%2F', ...TAB_REUSE]]);
  });

  it('an identical existing port mapping is reused and not owned: close removes only the mapping it created', async () => {
    fake.addReverse('tcp:4173', 'tcp:4173');
    const driver = new AndroidDriver('emulator-5554');
    assert.equal((await driver.launch(CHROME_WEB)).status, 'completed');
    assert.deepEqual(fake.reverseList(), ['host-1 tcp:4173 tcp:4173', 'host-1 tcp:9000 tcp:9000']);
    await driver.close();
    assert.deepEqual(fake.reverseList(), ['host-1 tcp:4173 tcp:4173']);
  });

  it('a mapping it created but someone re-pointed before close is left alone', async () => {
    const driver = new AndroidDriver('emulator-5554');
    assert.equal((await driver.launch({ ...CHROME_WEB, origins: [] })).status, 'completed');
    await adb('emulator-5554', ['reverse', '--remove', 'tcp:4173']);
    fake.addReverse('tcp:4173', 'tcp:5000');
    await driver.close();
    assert.deepEqual(fake.reverseList(), ['host-1 tcp:4173 tcp:5000']);
  });

  it('a device port already routed elsewhere is rejected: nothing is rebound and Chrome is not started', async () => {
    fake.addReverse('tcp:4173', 'tcp:8081');
    const o = await new AndroidDriver('emulator-5554').launch(CHROME_WEB);
    assert.equal(o.status, 'rejected', o.error ?? '');
    assert.match(o.error ?? '', /tcp:4173.*tcp:8081/);
    assert.deepEqual(fake.reverseList(), ['host-1 tcp:4173 tcp:8081']);
    assert.deepEqual(amCalls(fake), []);
  });

  it('open refuses a web target while Chrome is unprepared (no session), naming the setup command', async () => {
    stub = await startAppiumStub(() => undefined);
    fake.state('chrome-installed', '1');
    fake.state('chrome-command-line', '_ --disable-fre\n');
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    const err: unknown = await driver.open(CHROME_WEB).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error, String(err));
    assert.equal(failureStatus(err), 'rejected');
    assert.match(err.message, /디버그 앱/);
    assert.match(err.message, /--no-first-run --no-default-browser-check/);
    assert.match(err.message, /알림 권한/);
    assert.match(err.message, /`qa setup --browsers --android emulator-5554`/);
    assert.equal(stub.requests.length, 0);
    prepareChrome(fake);
    await driver.open(CHROME_WEB);
    assert.ok(stub.requests.some((r) => r.method === 'POST' && r.path === '/session'));
    await driver.close();
  });

  it('snapshot of a web target is surface web with the url_bar text as pageUrl; an app target stays app/null', async () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><hierarchy index="0" class="hierarchy" rotation="0" width="1080" height="2400">' +
      '<android.widget.FrameLayout index="0" package="com.android.chrome" class="android.widget.FrameLayout" text="" resource-id="" bounds="[0,0][1080,2400]" displayed="true">' +
      '<android.widget.EditText index="0" package="com.android.chrome" class="android.widget.EditText" text="localhost:4173" resource-id="com.android.chrome:id/url_bar" bounds="[150,120][900,240]" displayed="true"/>' +
      '<android.widget.Button index="1" package="com.android.chrome" class="android.widget.Button" text="검색" resource-id="" bounds="[40,600][400,700]" clickable="true" displayed="true"/>' +
      '</android.widget.FrameLayout></hierarchy>';
    stub = await startAppiumStub((req) => (req.path === '/session/s1/source' ? { body: { value: xml } } : undefined));
    prepareChrome(fake);
    const web = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await web.open(CHROME_WEB);
    const shot = await web.snapshot();
    assert.equal(shot.surface, 'web');
    assert.equal(shot.pageUrl, 'localhost:4173');
    await web.close();
    const app = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await app.open({ kind: 'app', platform: 'android', appId: 'com.android.chrome' });
    const native = await app.snapshot();
    assert.equal(native.surface, 'app');
    assert.equal(native.pageUrl, null);
    await app.close();
  });

  it("reset clear wipes Chrome's data, prepares it again, then reloads the start URL; reinstall is rejected", async () => {
    prepareChrome(fake);
    const driver = new AndroidDriver('emulator-5554');
    const o = await driver.reset(CHROME_WEB, 'clear');
    assert.equal(o.status, 'completed', o.error ?? '');
    const calls = fake.deviceCalls().map((c) => c.slice(0, 3).join(' '));
    const at = (cmd: string) => calls.indexOf(cmd);
    assert.ok(at('am force-stop com.android.chrome') >= 0 && at('am force-stop com.android.chrome') < at('pm clear com.android.chrome'), calls.join('\n'));
    assert.ok(at('pm clear com.android.chrome') < at('pm grant com.android.chrome'), 'notifications are granted again after pm clear');
    assert.ok(at('pm grant com.android.chrome') < at('am start -W'), 'the page is loaded after the prep');
    assert.match(fake.state('granted') ?? '', /POST_NOTIFICATIONS/);
    const before = fake.deviceCalls().length;
    const reinstall = await driver.reset(CHROME_WEB, 'reinstall');
    assert.equal(reinstall.status, 'rejected');
    assert.match(reinstall.error ?? '', /재설치하지 않습니다/);
    assert.equal(fake.deviceCalls().length, before, 'nothing ran on the device');
  });

  /**
   * Chrome session with the keyboard shown on login.html. `onRead(n)` runs on the n-th address-bar lookup, `onBack` when
   * BACK arrives; `page.url` is what the address bar shows.
   */
  async function chromeWithKeyboard(script: { onRead?: (n: number) => void; onBack: (page: { url: string }) => void }) {
    prepareChrome(fake);
    fake.state('ime-visible', 'true');
    const page = { url: 'localhost:4173/login.html' };
    const keys: number[] = [];
    let reads = 0;
    stub = await startAppiumStub((req) => {
      if (req.path === '/session/s1/elements' && req.body?.using === 'id' && req.body.value === 'com.android.chrome:id/url_bar') {
        script.onRead?.(++reads);
        return { body: { value: [{ [W3C_ELEMENT_KEY]: 'U1' }] } };
      }
      if (req.path === '/session/s1/element/U1/text') return { body: { value: page.url } };
      if (scriptOf(req) !== 'mobile: pressKey') return undefined;
      const { keycode } = (req.body?.args as { keycode: number }[])[0]!;
      keys.push(keycode);
      if (keycode === 4) script.onBack(page);
      return { body: { value: null } };
    });
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await driver.open(CHROME_WEB);
    return { driver, keys };
  }

  it('hideKeyboard on a web page never sends ESC (Chrome clears a search field on it): BACK only while the keyboard is shown', async () => {
    const { driver, keys } = await chromeWithKeyboard({ onBack: () => fake.state('ime-visible', 'false') });
    const o = await driver.hideKeyboard();
    assert.equal(o.status, 'completed', o.error ?? '');
    assert.deepEqual(keys, [4]);
    assert.deepEqual(await driver.hideKeyboard().then((x) => [x.status, keys.length]), ['completed', 1], 'no key while the keyboard is hidden');
    await driver.close();
  });

  it('a keyboard that closes before BACK is sent gets no BACK at all', async () => {
    const { driver, keys } = await chromeWithKeyboard({ onRead: (n) => n === 1 && fake.state('ime-visible', 'false'), onBack: () => undefined });
    const o = await driver.hideKeyboard();
    assert.equal(o.status, 'completed', o.error ?? '');
    assert.deepEqual(keys, []);
    await driver.close();
  });

  it('BACK that reached Chrome and navigated (the address bar changed) is uncertain, never completed', async () => {
    const { driver } = await chromeWithKeyboard({
      onBack: (page) => {
        fake.state('ime-visible', 'false');
        page.url = 'localhost:4173';
      },
    });
    const o = await driver.hideKeyboard();
    assert.equal(o.status, 'uncertain', o.error ?? '');
    assert.match(o.error ?? '', /키보드 닫기 중 페이지 이동 발생/);
    await driver.close();
  });
});

describe('prepareAndroidChrome', () => {
  let fake: FakeAdb;
  beforeEach(() => {
    fake = installFakeAdb();
  });
  afterEach(() => fake.restore());

  const mutating = (fake: FakeAdb) =>
    [...fake.deviceCalls().map((c) => c.slice(0, 2).join(' ')), ...fake.hostCalls().map((c) => c[2] ?? '')].filter((c) =>
      ['am set-debug-app', 'am force-stop', 'pm grant', 'push'].includes(c),
    );

  it('prepares once (keeping flags already in the file) and is a no-op when run again', async () => {
    fake.state('chrome-installed', '1');
    fake.state('chrome-command-line', 'chrome --enable-logging\n');
    const first = await prepareAndroidChrome('emulator-5554');
    assert.ok(first.every((c) => c.ok), JSON.stringify(first));
    assert.equal(fake.state('debug_app'), 'com.android.chrome\n');
    assert.equal(fake.state('chrome-command-line'), 'chrome --enable-logging --disable-fre --no-first-run --no-default-browser-check\n');
    assert.deepEqual(mutating(fake).toSorted(), ['am force-stop', 'am set-debug-app', 'pm grant', 'push']);
    const second = await prepareAndroidChrome('emulator-5554');
    assert.ok(second.every((c) => c.ok));
    assert.equal(mutating(fake).length, 4, 'the second run changed nothing');
  });

  it('reports a missing Chrome without changing the device', async () => {
    const checks = await prepareAndroidChrome('emulator-5554');
    assert.deepEqual(
      checks.map((c) => [c.label, c.ok]),
      [['Android Chrome', false]],
    );
    assert.deepEqual(mutating(fake), []);
  });
});

describe('iOS Safari web targets', () => {
  let xcrun: FakeXcrun;
  let stub: AppiumStub | null = null;
  beforeEach(() => {
    xcrun = installFakeXcrun(UDID);
  });
  afterEach(() => {
    stub?.close();
    stub = null;
    xcrun.restore();
  });

  const openurls = () => xcrun.calls().filter((c) => c[1] === 'openurl');

  it('launch and openUrl open the URL in Safari with simctl openurl; other origins and launch options are refused', async () => {
    const driver = new IosDriver(UDID);
    assert.equal((await driver.launch(SAFARI_WEB)).status, 'completed');
    assert.equal((await driver.openUrl(SAFARI_WEB, 'http://localhost:4173/login.html')).status, 'completed');
    assert.equal((await driver.openUrl(SAFARI_WEB, 'https://evil.example/')).status, 'rejected');
    assert.equal((await driver.launch(SAFARI_WEB, { permissions: { location: 'allow' } })).status, 'rejected');
    assert.deepEqual(openurls(), [
      ['simctl', 'openurl', UDID, 'http://localhost:4173/'],
      ['simctl', 'openurl', UDID, 'http://localhost:4173/login.html'],
    ]);
  });

  it('open refuses a UDID that is not a booted simulator (physical devices unsupported) before creating a session', async () => {
    stub = await startAppiumStub(() => undefined);
    const driver = new IosDriver('00008120-001A2B3C4D5E6F70', { serverUrl: stub.url });
    await assert.rejects(driver.open({ ...SAFARI_WEB }), /시뮬레이터에서만 지원/);
    assert.deepEqual(stub.requests, []);
  });

  /** Safari session whose page source and back button are scripted; returns the driver and the click count. */
  async function safari(opts: { source?: string; back?: 'enabled' | 'disabled' | 'absent' }) {
    const clicks: string[] = [];
    stub = await startAppiumStub((req) => {
      if (req.path === '/session/s1/source' && opts.source) return { body: { value: opts.source } };
      if (req.path === '/session/s1/elements' && String(req.body?.value).includes('name == "BackButton"')) {
        return { body: { value: opts.back === 'absent' ? [] : [{ [W3C_ELEMENT_KEY]: 'B1' }] } };
      }
      if (req.path === '/session/s1/element/B1/attribute/enabled') return { body: { value: String(opts.back === 'enabled') } };
      if (req.path === '/session/s1/element/B1/click') clicks.push(req.path);
      if (scriptOf(req) === 'mobile: terminateApp') return { body: { value: true } };
      return undefined;
    });
    const driver = new IosDriver(UDID, { serverUrl: stub.url });
    await driver.open(SAFARI_WEB);
    return { driver, clicks };
  }

  it("back taps Safari's back button when enabled; disabled or missing is rejected without any other gesture", async () => {
    for (const [back, status] of [
      ['enabled', 'completed'],
      ['disabled', 'rejected'],
      ['absent', 'rejected'],
    ] as const) {
      const { driver, clicks } = await safari({ back });
      const o = await driver.back();
      assert.equal(o.status, status, `${back}: ${o.error}`);
      assert.equal(clicks.length, back === 'enabled' ? 1 : 0, back);
      assert.ok(!stub!.requests.some((r) => r.path === '/session/s1/actions'), `${back}: no swipe fallback`);
      if (back !== 'enabled') assert.match(o.error ?? '', /Safari 뒤로 버튼/);
      await driver.close();
      stub!.close();
    }
  });

  it("hideKeyboard on a web page taps the Done button of Safari's form bar; without one it is rejected", async () => {
    for (const done of [true, false]) {
      let keyboard = true;
      const sent: string[] = [];
      stub = await startAppiumStub((req) => {
        const script = scriptOf(req);
        if (script) sent.push(script);
        if (script === 'mobile: isKeyboardShown') return { body: { value: keyboard } };
        if (req.path === '/session/s1/elements' && String(req.body?.value).includes('XCUIElementTypeToolbar')) return { body: { value: done ? [{ [W3C_ELEMENT_KEY]: 'D1' }] : [] } };
        if (req.path === '/session/s1/element/D1/click') keyboard = false;
        return undefined;
      });
      const driver = new IosDriver(UDID, { serverUrl: stub.url });
      await driver.open(SAFARI_WEB);
      const o = await driver.hideKeyboard();
      assert.equal(o.status, done ? 'completed' : 'rejected', o.error ?? '');
      assert.equal(keyboard, !done);
      assert.ok(!sent.includes('mobile: hideKeyboard'), 'WDA keyboard dismissal (keyboard keys only) is not used on web pages');
      await driver.close();
      stub.close();
    }
  });

  it('snapshot pageUrl is the address field value without the left-to-right mark', async () => {
    const source =
      '<?xml version="1.0" encoding="UTF-8"?><AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Safari" label="Safari" enabled="true" x="0" y="0" width="402" height="874" bundleId="com.apple.mobilesafari">' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="BackButton" label="뒤로" enabled="false" x="34" y="792" width="48" height="48"/>' +
      '<XCUIElementTypeTextField type="XCUIElementTypeTextField" value="\u200Elocalhost" name="TabBarItemTitle" label="주소" enabled="true" x="165" y="806" width="72" height="21"/>' +
      '</XCUIElementTypeApplication></AppiumAUT>';
    const { driver } = await safari({ source });
    const shot = await driver.snapshot();
    assert.equal(shot.surface, 'web');
    assert.equal(shot.pageUrl, 'localhost');
    await driver.close();
  });

  it("reset clear empties only Safari's website data in this simulator's container, then reopens the start URL", async () => {
    const files = {
      wiped: [
        'Library/WebKit/com.apple.mobilesafari/WebsiteData/Default/salt/salt/LocalStorage/localstorage.sqlite3',
        'Library/Cookies/Cookies.binarycookies',
        'Library/HTTPStorages/com.apple.mobilesafari/httpstorages.sqlite',
        'Library/Caches/com.apple.mobilesafari/WebKit/NetworkCache/Version 17/Records/r',
      ],
      kept: ['Library/Safari/Bookmarks.db', 'Library/Preferences/com.apple.mobilesafari.plist', 'Library/WebKit/ContentExtensions/list'],
    };
    for (const rel of [...files.wiped, ...files.kept]) {
      mkdirSync(dirname(join(xcrun.container, rel)), { recursive: true });
      writeFileSync(join(xcrun.container, rel), 'x');
    }
    const { driver } = await safari({});
    const o = await driver.reset(SAFARI_WEB, 'clear');
    assert.equal(o.status, 'completed', o.error ?? '');
    for (const rel of files.kept) assert.ok(existsSync(join(xcrun.container, rel)), `kept ${rel}`);
    for (const dir of ['Library/WebKit/com.apple.mobilesafari/WebsiteData', 'Library/Cookies', 'Library/HTTPStorages', 'Library/Caches/com.apple.mobilesafari/WebKit']) {
      assert.deepEqual(readdirSync(join(xcrun.container, dir)), [], `emptied ${dir}`);
    }
    assert.ok(stub!.requests.some((r) => scriptOf(r) === 'mobile: terminateApp'), 'Safari was terminated');
    assert.deepEqual(openurls(), [['simctl', 'openurl', UDID, 'http://localhost:4173/']]);
    assert.ok(!xcrun.calls().some((c) => c[1] === 'keychain' || c[1] === 'uninstall'), 'no keychain reset or reinstall for web');
    await driver.close();
  });

  it('reset clear refuses to delete from a container path that is not this simulator’s app data; reinstall is rejected', async () => {
    const elsewhere = join(xcrun.root, 'Users', 'me', 'Library', 'Cookies');
    mkdirSync(join(elsewhere, 'Library', 'Cookies'), { recursive: true });
    writeFileSync(join(elsewhere, 'Library', 'Cookies', 'Cookies.binarycookies'), 'x');
    xcrun.reportContainer(elsewhere);
    const { driver } = await safari({});
    const o = await driver.reset(SAFARI_WEB, 'clear');
    assert.notEqual(o.status, 'completed');
    assert.match(o.error ?? '', /지우지 않습니다/);
    assert.ok(existsSync(join(elsewhere, 'Library', 'Cookies', 'Cookies.binarycookies')));
    assert.deepEqual(openurls(), []);
    const reinstall = await driver.reset(SAFARI_WEB, 'reinstall');
    assert.equal(reinstall.status, 'rejected');
    await driver.close();
  });
});
