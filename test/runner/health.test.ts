import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import type { AppTarget, Snapshot, WebTarget } from '../../src/core/types.ts';
import { buildScreenModel } from '../../src/observe/index.ts';
import type { Manifest } from '../../src/report/manifest.ts';
import { checkHealth } from '../../src/runner/health.ts';
import { dHash, decodePng, hammingHex } from '../../src/runner/image.ts';
import { FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { commitSafe } from '../helpers/jev-stub.ts';
import { runYaml } from '../helpers/run.ts';

/** Minimal RGB PNG with one colour (filter 0 rows). */
function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const TTEONAM: AppTarget = { kind: 'app', platform: 'android', appId: 'kr.tteonam.app' };

function health(snap: Snapshot, target: AppTarget = TTEONAM) {
  const model = buildScreenModel(snap, {});
  return checkHealth(model, snap.screenshotPng ? decodePng(snap.screenshotPng) : null, target);
}

describe('health rules', () => {
  it('detects the RN RedBox on android/ticketestimate', () => {
    const kinds = health(fixtureSnapshot('android', 'ticketestimate', 'launch'), { ...TTEONAM, appId: 'com.ticketestimate' }).map((f) => `${f.kind}:${f.severity}`);
    assert.deepEqual(kinds, ['rn_redbox:fail']);
  });

  it('is clean on a healthy tteonam screen', () => {
    assert.deepEqual(health(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' })), []);
  });

  it('flags a blank screen only when tree, OCR and pixels are all empty', () => {
    const empty = { ...fixtureSnapshot('android', 'tteonam', 'launch'), nodes: [], screenshotPng: solidPng(90, 200, [255, 255, 255]) };
    assert.deepEqual(health(empty).map((f) => f.kind), ['blank_screen']);
    const logo = solidPng(90, 200, [255, 255, 255]);
    assert.deepEqual(health({ ...fixtureSnapshot('android', 'tteonam', 'launch'), screenshotPng: logo }), [], 'a solid screenshot with content in the tree is not blank');
  });

  it('keeps a collapsed LogBox warning a WARN', () => {
    const snap = fixtureSnapshot('android', 'tteonam', 'launch', { patch: [['text="출발했어요"', 'text="Open debugger to view warnings."']] });
    assert.deepEqual(health(snap).map((f) => `${f.kind}:${f.severity}`), ['rn_logbox_warning:warn']);
  });

  it('dHash separates different screens and matches identical ones', () => {
    const a = decodePng(readFileSync('fixtures/android/tteonam/launch.png'))!;
    const b = decodePng(readFileSync('fixtures/android/tteonam/tab-departures.png'))!;
    assert.equal(hammingHex(dHash(a), dHash(a)), 0);
    assert.ok(hammingHex(dHash(a), dHash(b)) >= 7);
  });

  it('fails app_not_foreground after a tap and attaches the log slice and crash artifacts', async () => {
    const launch = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' });
    const driver = new FakeDriver(launch);
    driver.crashes = [{ name: 'crash-1.txt', content: 'FATAL EXCEPTION: main' }];
    driver.onTap = (p) => (hits(launch, '출국장', p) ? { ...fixtureSnapshot('android', 'settings', 'launch'), foregroundApp: 'com.android.settings' } : null);
    const { result } = await runYaml({ 'tests/crash.e2e.yaml': 'name: crash\napp: tteonam\nstart: attach\nsteps:\n  - tap: 출국장\n  - tap: 주차\n' }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'app_not_foreground');
    assert.equal(driver.called('tap').length, 1, 'the test stops at the failing step');
    assert.ok(t.logs && existsSync(join(result.runDir, t.logs)));
    assert.equal(t.crash.length, 1);
    assert.equal(readFileSync(join(result.runDir, t.crash[0]!), 'utf8'), 'FATAL EXCEPTION: main');
    const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.ok(manifest.entries.some((e) => e.kind === 'crash'));
    assert.ok(manifest.entries.some((e) => e.kind === 'log' && e.relativePath.endsWith('device.log')));
  });

  it('counts a canvas-only change (identical tree, different pixels) via dHash', async () => {
    const launch = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' });
    const driver = new FakeDriver(launch);
    const repainted = { ...launch, screenshotPng: new Uint8Array(readFileSync('fixtures/android/tteonam/tab-departures.png')) };
    driver.onTap = () => repainted;
    const { result } = await runYaml({ 'tests/canvas.e2e.yaml': 'name: canvas\napp: tteonam\nstart: attach\nsteps:\n  - tap: 출국장\n' }, driver, { jev: commitSafe().setup });
    const tap = result.tests[0]!.steps[1]!;
    assert.equal(tap.verdict, 'PASS', tap.reason);
    assert.equal(tap.settle?.changed, true);
  });
});

describe('web health rules', () => {
  const site = (platform: WebTarget['platform'], appId: string): WebTarget => ({
    kind: 'web',
    platform,
    appId,
    url: 'http://localhost:4173/',
    origins: ['http://localhost:4173'],
    viewport: { width: 1280, height: 800 },
  });
  const CHROME = site('desktop-chrome', 'chrome');
  const kinds = (snap: Snapshot, target: WebTarget) => health(snap, target).map((f) => f.kind);

  it('checks the desktop page origin from the full href', () => {
    const page = (pageUrl: string | null) => fixtureSnapshot('desktop-chrome', 'web-demo', 'index', { pageUrl });
    assert.deepEqual(kinds(page('http://localhost:4173/login.html?next=1'), CHROME), []);
    assert.deepEqual(kinds(page(null), CHROME), [], 'no URL: nothing to judge');
    for (const off of ['https://localhost:4173/', 'http://localhost:4174/', 'https://evil.example/', 'about:blank']) {
      assert.deepEqual(kinds(page(off), CHROME), ['origin_mismatch'], off);
    }
  });

  it('reads the mobile address bar as host[:port] (Safari drops the port, bidi marks and www.) or a full URL', () => {
    const android = site('android', 'com.android.chrome');
    const ios = site('ios', 'com.apple.mobilesafari');
    const bar = (platform: 'android' | 'ios', pageUrl: string) => fixtureSnapshot(platform, 'web-demo', 'index', { pageUrl });
    for (const shown of ['localhost:4173', 'localhost:4173/login.html', 'http://localhost:4173/x']) assert.deepEqual(kinds(bar('android', shown), android), [], shown);
    assert.deepEqual(kinds(bar('ios', '\u200Elocalhost'), ios), []);
    assert.deepEqual(kinds(bar('ios', 'www.localhost'), ios), []);
    // A hint or search text in the bar tells nothing.
    assert.deepEqual(kinds(bar('android', '검색어 또는 URL 입력'), android), []);
    for (const shown of ['localhost:9999', 'evil.example', 'https://localhost:4173/']) assert.deepEqual(kinds(bar('android', shown), android), ['origin_mismatch'], shown);
    assert.deepEqual(kinds(bar('ios', '\u200Eevil.example'), ios), ['origin_mismatch']);
  });

  it('fails Chrome and Safari error pages, and only on websites', () => {
    for (const text of ['ERR_CONNECTION_REFUSED', '사이트에 연결할 수 없음', 'This site can’t be reached', 'Safari에서 페이지를 열 수 없습니다', 'Safari Can’t Open the Page', '서버에 연결할 수 없음']) {
      const snap = fixtureSnapshot('desktop-chrome', 'web-demo', 'index', { patch: [['text="상품 3개"', `text="${text}"`]] });
      assert.deepEqual(kinds(snap, CHROME), ['page_load_error'], text);
    }
    const app = fixtureSnapshot('android', 'tteonam', 'launch', { patch: [['text="출발했어요"', 'text="ERR_CONNECTION_REFUSED"']] });
    assert.deepEqual(health(app), [], 'an app may show the text; the browser error page rule is for websites');
  });

  it('does not read a red web page as a React Native RedBox', () => {
    const red = { ...fixtureSnapshot('desktop-chrome', 'web-demo', 'index'), screenshotPng: solidPng(90, 200, [230, 20, 20]) };
    assert.deepEqual(kinds(red, CHROME), []);
    assert.deepEqual(health({ ...fixtureSnapshot('android', 'tteonam', 'launch'), screenshotPng: solidPng(90, 200, [230, 20, 20]) }).map((f) => f.kind), ['rn_redbox']);
  });
});
