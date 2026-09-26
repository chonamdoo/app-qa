// DesktopWebDriver over a scripted W3C browser: real-input request bodies, read-back verification, refusals before
// dispatch, and lost or garbled answers as `uncertain`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { W3C_ELEMENT_KEY, W3C_KEYS } from '../../src/appium/client.ts';
import { PATHS } from '../../src/core/config.ts';
import type { DeviceInfo, WebTarget } from '../../src/core/types.ts';
import { failureStatus } from '../../src/drivers/base.ts';
import { chooseDevice } from '../../src/drivers/devices.ts';
import { DESKTOP_SCRIPTS, DesktopWebDriver } from '../../src/drivers/desktop.ts';
import type { Reply, StubRequest } from './stubs.ts';
import { sampleExtract, startW3CStub, type FakePage, type W3CStub } from './w3c-stub.ts';

const CHROME: WebTarget = { kind: 'web', platform: 'desktop-chrome', appId: 'chrome', url: 'http://localhost:4173/', origins: ['http://localhost:4173'], viewport: { width: 1280, height: 800 } };
const SAFARI: WebTarget = { ...CHROME, platform: 'desktop-safari', appId: 'safari' };
const AT = { x: 400.6, y: 107.2 };

/** Opens a driver on a fresh fake browser, runs `fn`, closes both. */
async function withDriver<T>(init: Partial<FakePage>, fn: (d: DesktopWebDriver, stub: W3CStub) => Promise<T>, override?: (req: StubRequest) => Reply | undefined, target = CHROME): Promise<T> {
  const stub = await startW3CStub(init, override);
  const driver = new DesktopWebDriver(target.platform as 'desktop-chrome' | 'desktop-safari', target.platform, { serverUrl: stub.url });
  try {
    await driver.open(target);
    return await fn(driver, stub);
  } finally {
    await driver.close();
    stub.close();
  }
}

const posted = (stub: W3CStub, path: string) => stub.requests.filter((r) => r.method === 'POST' && r.path === `/session/s1${path}`);
/** Values of every keyDown, in order. */
const keysDown = (stub: W3CStub) => stub.sources().flatMap((s) => (s.type === 'key' ? (s.actions as { type: string; value: string }[]).filter((a) => a.type === 'keyDown').map((a) => a.value) : []));
const CLEAR = [W3C_KEYS.meta, 'a', W3C_KEYS.backspace];

describe('open', () => {
  it('sizes the window so the viewport (not the window) equals the profile viewport', async () => {
    await withDriver({ chrome: { width: 0, height: 87 }, window: { x: 200, y: 100, width: 1000, height: 700 } }, async (_d, stub) => {
      assert.deepEqual(posted(stub, '/window/rect').at(-1)?.body, { x: 0, y: 0, width: 1280, height: 887 });
    });
  });

  it('fails and ends the session when the screen cannot fit the viewport: refused, the window is confirmed gone', async () => {
    const stub = await startW3CStub({ maxWindow: { width: 1440, height: 850 } });
    const driver = new DesktopWebDriver('desktop-chrome', 'desktop-chrome', { serverUrl: stub.url });
    try {
      await assert.rejects(driver.open(CHROME), (err: Error) => /뷰포트를 1280×800로 맞추지 못했습니다 \(현재 1280×763\)/.test(err.message) && failureStatus(err) === 'rejected');
      assert.ok(stub.requests.some((r) => r.method === 'DELETE' && r.path === '/session/s1'));
    } finally {
      stub.close();
    }
  });

  it('a failed session request is uncertain (a window may exist), and so is an unconfirmed end after an unfitted viewport', async () => {
    const answers: Record<string, (req: StubRequest) => Reply | undefined> = {
      'dropped connection': (req) => (req.method === 'POST' && req.path === '/session' ? 'destroy' : undefined),
      'session not created after launch': (req) => (req.method === 'POST' && req.path === '/session' ? { status: 500, body: { value: { error: 'session not created', message: 'chrome not reachable' } } } : undefined),
      'unfitted viewport, DELETE lost': (req) => (req.method === 'DELETE' ? 'destroy' : undefined),
    };
    for (const [name, override] of Object.entries(answers)) {
      const stub = await startW3CStub({ maxWindow: { width: 1440, height: 850 } }, override);
      try {
        const driver = new DesktopWebDriver('desktop-chrome', 'desktop-chrome', { serverUrl: stub.url });
        await assert.rejects(driver.open(CHROME), (err: Error) => failureStatus(err) === 'uncertain', name);
        assert.equal((await driver.launch(CHROME)).status, 'uncertain', name);
        await assert.rejects(driver.close(), (err: Error) => failureStatus(err) === 'uncertain', name);
        assert.equal(stub.requests.filter((r) => r.method === 'POST' && r.path === '/session').length, 1, `${name}: no second session`);
      } finally {
        stub.close();
      }
    }
  });

  it('refuses a target that is not a web profile for this browser, or whose start URL a device driver would refuse', async () => {
    const stub = await startW3CStub();
    try {
      for (const target of [
        { ...SAFARI },
        { ...CHROME, appId: 'com.android.chrome' },
        { ...CHROME, url: 'javascript:alert(1)' },
        { ...CHROME, url: 'http://qa:hunter2@localhost:4173/' },
        { ...CHROME, url: 'http://evil.example/' },
        { ...CHROME, origins: ['http://localhost:4173/path'] },
        { kind: 'app', platform: 'desktop-chrome', appId: 'chrome' } as const,
      ]) {
        const driver = new DesktopWebDriver('desktop-chrome', 'desktop-chrome', { serverUrl: stub.url });
        await assert.rejects(driver.open(target), { name: 'RefusedError' }, JSON.stringify(target));
        const launched = await driver.launch(target);
        assert.equal(launched.status, 'rejected', JSON.stringify(target));
        assert.doesNotMatch(launched.error ?? '', /hunter2/);
      }
      assert.equal(stub.requests.length, 0);
    } finally {
      stub.close();
    }
  });

  it('a Safari session refused for remote automation names the fix', async () => {
    const refusal = (req: StubRequest): Reply | undefined =>
      req.path === '/session'
        ? { status: 500, body: { value: { error: 'session not created', message: "Could not create a session: You must enable the 'Allow Remote Automation' option in Safari's Develop menu to control Safari via WebDriver." } } }
        : undefined;
    const stub = await startW3CStub({}, refusal);
    try {
      const driver = new DesktopWebDriver('desktop-safari', 'desktop-safari', { serverUrl: stub.url });
      await assert.rejects(driver.open(SAFARI), (err: Error) => err.name === 'RefusedError' && /원격 자동화 허용/.test(err.message) && /sudo safaridriver --enable/.test(err.message));
      const launched = await driver.launch(SAFARI);
      assert.equal(launched.status, 'rejected');
      assert.match(launched.error ?? '', /원격 자동화/);
    } finally {
      stub.close();
    }
  });
});

describe('snapshot', () => {
  it('parses the page extract into a web snapshot', async () => {
    await withDriver({ extract: sampleExtract({ truncated: true }) }, async (d) => {
      const s = await d.snapshot({ screenshot: true });
      assert.equal(s.surface, 'web');
      assert.equal(s.pageUrl, 'http://localhost:4173/?q=1');
      assert.deepEqual(s.screen, { x: 0, y: 0, width: 1280, height: 800 });
      assert.equal(s.foregroundApp, 'chrome');
      assert.equal(s.keyboardShown, false);
      assert.equal(s.depthCapped, true);
      assert.ok(s.nodes.some((n) => n.className === 'web:button' && n.text === '검색'));
      assert.ok(s.screenshotPng && s.screenshotPng.length > 8);
    });
  });

  it('a malformed extract throws instead of producing an empty screen', async () => {
    for (const extract of [null, { url: 'x' }, sampleExtract({ nodes: [] }), sampleExtract({ width: 'wide' })]) {
      await withDriver({ extract }, async (d) => {
        await assert.rejects(d.snapshot());
      });
    }
  });
});

describe('real input', () => {
  it('tap and longPress are mouse pointer actions at rounded viewport CSS px', async () => {
    await withDriver({}, async (d, stub) => {
      assert.equal((await d.tap(AT)).status, 'completed');
      assert.equal((await d.longPress(AT, 900)).status, 'completed');
      const [tap, hold] = stub.sources();
      for (const [source, pause] of [[tap, 60], [hold, 900]] as const) {
        assert.deepEqual(source, {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [{ type: 'pointerMove', duration: 0, x: 401, y: 107, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: pause }, { type: 'pointerUp', button: 0 }],
        });
      }
    });
  });

  it('swipe is a wheel scroll at `from` by (from − to) on a fresh wheel source each time, never a drag or a script scroll', async () => {
    await withDriver({}, async (d, stub) => {
      assert.equal((await d.swipe({ x: 640, y: 600 }, { x: 600, y: 300 }, 250)).status, 'completed');
      assert.equal((await d.swipe({ x: 640, y: 600 }, { x: 640, y: 200 }, 250)).status, 'completed');
      // Safari 26 scrolls once per wheel source: a reused id would leave the second scroll without effect.
      assert.deepEqual(stub.sources(), [
        { type: 'wheel', id: 'wheel-1', actions: [{ type: 'scroll', origin: 'viewport', x: 640, y: 600, deltaX: 40, deltaY: 300, duration: 250 }] },
        { type: 'wheel', id: 'wheel-2', actions: [{ type: 'scroll', origin: 'viewport', x: 640, y: 600, deltaX: 0, deltaY: 400, duration: 250 }] },
      ]);
      assert.deepEqual(stub.scripts().filter((s) => s !== 'viewport'), []);
    });
  });

  it('press sends the W3C key; back is history back', async () => {
    await withDriver({}, async (d, stub) => {
      for (const k of ['enter', 'tab', 'escape', 'delete'] as const) assert.equal((await d.press(k)).status, 'completed');
      assert.deepEqual(keysDown(stub), [W3C_KEYS.enter, W3C_KEYS.tab, W3C_KEYS.escape, W3C_KEYS.backspace]);
      assert.equal((await d.press('back')).status, 'completed');
      assert.equal(posted(stub, '/back').length, 1);
    });
  });
});

describe('Safari input needs its window in front', () => {
  it('an unfocused Safari page is raised before the input; one that stays behind is refused with nothing sent', async () => {
    await withDriver({ front: false }, async (d, stub) => {
      assert.equal((await d.tap(AT)).status, 'completed');
      assert.equal(posted(stub, '/window').length, 1);
      assert.equal(stub.sources().length, 1);
    }, undefined, SAFARI);
    await withDriver({ front: false, raises: false }, async (d, stub) => {
      const tapped = await d.tap(AT);
      assert.equal(tapped.status, 'rejected');
      assert.match(tapped.error ?? '', /Safari 창이 앞으로 오지 않아 입력을 보내지 않았습니다/);
      assert.equal((await d.typeText(AT, 'qa')).status, 'rejected');
      assert.deepEqual(stub.sources(), []);
    }, undefined, SAFARI);
  });

  it('Chrome takes input in a background window without being raised', async () => {
    await withDriver({ front: false, raises: false }, async (d, stub) => {
      assert.equal((await d.tap(AT)).status, 'completed');
      assert.equal(posted(stub, '/window').length, 0);
      assert.ok(!stub.scripts().includes('focused'));
    });
  });
});

describe('typeText / clearText', () => {
  it('clears with ⌘A + Backspace, types every character as a key, and reads the value back', async () => {
    await withDriver({ field: { value: '이전 값', password: false } }, async (d, stub) => {
      const o = await d.typeText(AT, '한글');
      assert.deepEqual({ ...o, ms: 0 }, { status: 'completed', ms: 0, readBack: '한글', path: 'keys' });
      assert.deepEqual(keysDown(stub), [...CLEAR, '한', '글']);
      assert.equal(stub.page.field?.value, '한글');
    });
  });

  it('append moves the caret to the end and expects old + new text', async () => {
    await withDriver({ field: { value: '한', password: false } }, async (d, stub) => {
      const o = await d.typeText(AT, '글', { append: true });
      assert.equal(o.readBack, '한글');
      assert.equal(o.error, undefined);
      assert.deepEqual(keysDown(stub), [W3C_KEYS.meta, W3C_KEYS.arrowDown, '글']);
    });
  });

  it('a read-back that differs is INPUT_UNVERIFIED (completed, never retried)', async () => {
    await withDriver({ field: { value: '', password: false, maxLength: 1 } }, async (d, stub) => {
      const o = await d.typeText(AT, '한글', { submit: true });
      assert.equal(o.status, 'completed');
      assert.match(o.error ?? '', /^INPUT_UNVERIFIED: 기대 "한글", 실제 "한"/);
      assert.equal(o.readBack, '한');
      assert.equal(posted(stub, '/actions').length, 2); // click + one key dispatch; no retry, no Enter
    });
  });

  it('a click that focused no editable field is uncertain (it was sent; its effect is unknown), and no key is sent', async () => {
    await withDriver({ field: null }, async (d, stub) => {
      for (const o of [await d.typeText(AT, '한글'), await d.clearText(AT)]) {
        assert.equal(o.status, 'uncertain');
        assert.match(o.error ?? '', /편집 가능한 입력 포커스/);
      }
      assert.equal(posted(stub, '/actions').length, 2);
      assert.deepEqual(keysDown(stub), []);
    });
  });

  it('text carrying a WebDriver special key (e.g. U+E007 Enter) is rejected before anything is dispatched', async () => {
    await withDriver({}, async (d, stub) => {
      assert.equal((await d.typeText(AT, `abc${W3C_KEYS.enter}`)).status, 'rejected');
      assert.equal(posted(stub, '/actions').length, 0);
    });
  });

  it('secure values are compared by length and masked everywhere, even on mismatch', async () => {
    await withDriver({ field: { value: '', password: true, maxLength: 4 } }, async (d) => {
      const o = await d.typeText(AT, 'secret12');
      assert.equal(o.readBack, '••••');
      assert.equal(o.error, 'INPUT_UNVERIFIED: 기대 "••••••••", 실제 "••••"');
    });
    await withDriver({ field: { value: '', password: false } }, async (d, stub) => {
      const o = await d.typeText(AT, 'secret12', { secure: true });
      assert.deepEqual([o.status, o.readBack, o.error], ['completed', '••••••••', undefined]);
      const fieldReads = stub.requests.filter((r) => r.path.endsWith('/execute/sync') && Array.isArray(r.body?.args) && r.body.args.length === 2);
      assert.ok(fieldReads.length > 0 && fieldReads.every((r) => (r.body!.args as unknown[])[1] === true));
    });
  });

  it('a refused read after the keys were delivered is INPUT_UNVERIFIED, never rejected', async () => {
    const staleRead = (req: StubRequest): Reply | undefined =>
      req.path === '/session/s1/execute/sync' && (req.body?.args as unknown[] | undefined)?.[0] ? { status: 404, body: { value: { error: 'stale element reference', message: 'gone' } } } : undefined;
    await withDriver(
      {},
      async (d) => {
        const o = await d.typeText(AT, '한글');
        assert.equal(o.status, 'completed');
        assert.match(o.error ?? '', /^INPUT_UNVERIFIED: 입력 후 값을 읽지 못했습니다/);
      },
      staleRead,
    );
  });

  it('clearText verifies the field became empty', async () => {
    await withDriver({ field: { value: '대한항공', password: false } }, async (d, stub) => {
      const o = await d.clearText(AT);
      assert.deepEqual([o.status, o.readBack, o.error, o.path], ['completed', '', undefined, 'keys']);
      assert.deepEqual(keysDown(stub), CLEAR);
    });
    await withDriver({ field: { value: '대한항공', password: false, ignoresClear: true } }, async (d) => {
      const o = await d.clearText(AT);
      assert.equal(o.status, 'completed');
      assert.equal(o.error, 'INPUT_UNVERIFIED: 지운 뒤 값 "대한항"'); // ⌘A ignored: Backspace removed one character
    });
  });
});

describe('back', () => {
  it('is refused without an earlier page in the site, and sends no /back', async () => {
    for (const history of [{ length: 1, canGoBack: null }, { length: 3, canGoBack: false }]) {
      await withDriver({ history }, async (d, stub) => {
        const o = await d.back();
        assert.equal(o.status, 'rejected', JSON.stringify(history));
        assert.equal(posted(stub, '/back').length, 0);
      });
    }
  });

  it('with history (and no Navigation API) it is POST /back', async () => {
    await withDriver({ history: { length: 2, canGoBack: null } }, async (d, stub) => {
      assert.equal((await d.back()).status, 'completed');
      assert.equal(posted(stub, '/back').length, 1);
    });
  });
});

describe('unsupported operations are refused before dispatch', () => {
  it('permissions, launch arguments, reinstall, location, non-http urls, credentials, other origins', async () => {
    await withDriver({}, async (d, stub) => {
      const outcomes = [
        await d.launch(CHROME, { permissions: { location: 'allow' } }),
        await d.launch(CHROME, { arguments: ['--x'] }),
        await d.reset(CHROME, 'reinstall'),
        await d.setLocation(37.5, 127),
        await d.openUrl(CHROME, 'javascript:alert(1)'),
        await d.openUrl(CHROME, 'file:///etc/passwd'),
        await d.openUrl(CHROME, 'http://qa:hunter2@localhost:4173/login.html'),
        await d.openUrl(CHROME, 'https://evil.example/login.html'),
        await d.openUrl(CHROME, 'http://localhost:4174/'),
      ];
      assert.deepEqual(outcomes.map((o) => o.status), Array(9).fill('rejected'));
      assert.ok(outcomes.every((o) => !o.error?.includes('hunter2')));
      assert.equal(posted(stub, '/url').length, 0);
      assert.equal((await d.openUrl(CHROME, 'http://localhost:4173/login.html')).status, 'completed');
    });
  });
});

describe('outcomes of lost or garbled answers', () => {
  it('a dropped connection is uncertain for tap, typing keys, navigation and back', async () => {
    const cases: [string, (d: DesktopWebDriver) => Promise<{ status: string }>][] = [
      ['/session/s1/actions', (d) => d.tap(AT)],
      ['/session/s1/url', (d) => d.launch(CHROME)],
      ['/session/s1/back', (d) => d.back()],
    ];
    for (const [path, act] of cases) {
      await withDriver({}, async (d) => assert.equal((await act(d)).status, 'uncertain', path), (req) => (req.path === path ? 'destroy' : undefined));
    }
    let actions = 0;
    await withDriver({}, async (d) => assert.equal((await d.typeText(AT, '한글')).status, 'uncertain'), (req) => (req.path === '/session/s1/actions' && ++actions === 2 ? 'destroy' : undefined));
  });

  it('mutating commands complete only with W3C value null', async () => {
    const cases: [string, (d: DesktopWebDriver) => Promise<{ status: string }>][] = [
      ['/session/s1/actions', (d) => d.press('enter')],
      ['/session/s1/url', (d) => d.openUrl(CHROME, 'http://localhost:4173/login.html')],
      ['/session/s1/back', (d) => d.back()],
    ];
    for (const [path, act] of cases) {
      for (const value of [true, '', { done: true }]) {
        await withDriver({}, async (d) => assert.equal((await act(d)).status, 'uncertain', `${path} → ${JSON.stringify(value)}`), (req) => (req.path === path ? { body: { value } } : undefined));
      }
    }
  });

  it('a crashed tab is uncertain and becomes crash evidence', async () => {
    const since = new Date().toISOString();
    await withDriver(
      {},
      async (d) => {
        assert.equal((await d.tap(AT)).status, 'uncertain');
        const crashes = await d.crashArtifacts(CHROME, since);
        assert.equal(crashes.length, 1);
        assert.match(crashes[0]!.content, /tab crashed/);
        assert.deepEqual(await d.crashArtifacts(CHROME, new Date(Date.now() + 60_000).toISOString()), []);
      },
      (req) => (req.path === '/session/s1/actions' ? { status: 500, body: { value: { error: 'unknown error', message: 'unknown error: tab crashed' } } } : undefined),
    );
  });
});

describe('ending the browser session', () => {
  const DELETE_FAILURES: Record<string, Reply> = {
    'dropped connection': 'destroy',
    'garbled answer': { body: { value: { deleted: true } } },
    'W3C error': { status: 500, body: { value: { error: 'unknown error', message: 'quit failed' } } },
  };
  const deletes = (stub: W3CStub) => stub.requests.filter((r) => r.method === 'DELETE' && r.path === '/session/s1').length;
  const sessionRequests = (stub: W3CStub) => stub.requests.filter((r) => r.method === 'POST' && r.path === '/session').length;
  /** Every driver call that would start or end a session, as its outcome status (`open`/`close` throw). */
  const SESSION_CALLS: Record<string, (d: DesktopWebDriver) => Promise<string>> = {
    terminate: async (d) => (await d.terminate(CHROME)).status,
    'reset clear': async (d) => (await d.reset(CHROME, 'clear')).status,
    'reset relaunch': async (d) => (await d.reset(CHROME, 'relaunch')).status,
    launch: async (d) => (await d.launch(CHROME)).status,
    open: (d) => d.open(CHROME).then(() => 'completed', failureStatus),
    close: (d) => d.close().then(() => 'completed', failureStatus),
  };

  it('an unconfirmed end inside a test (terminate, reset clear, open replacing the session) is not forgotten: no new session, every later start or end is uncertain', async () => {
    const ends: Record<string, (d: DesktopWebDriver) => Promise<string>> = { terminate: SESSION_CALLS.terminate!, 'reset clear': SESSION_CALLS['reset clear']!, open: SESSION_CALLS.open! };
    for (const [name, reply] of Object.entries(DELETE_FAILURES)) {
      for (const [first, end] of Object.entries(ends)) {
        const label = `${name}, ${first}`;
        const stub = await startW3CStub({}, (req) => (req.method === 'DELETE' ? reply : undefined));
        try {
          const driver = new DesktopWebDriver('desktop-chrome', 'desktop-chrome', { serverUrl: stub.url });
          await driver.open(CHROME);
          assert.equal(await end(driver), 'uncertain', label);
          for (const [call, run] of Object.entries(SESSION_CALLS)) assert.equal(await run(driver), 'uncertain', `${label} → ${call}`);
          await assert.rejects(driver.close(), (err: Error) => failureStatus(err) === 'uncertain' && /세션 종료를 확인하지 못했습니다/.test(err.message), label);
          assert.equal(sessionRequests(stub), 1, `${label}: no second session`);
          assert.equal(deletes(stub), 1, `${label}: the lost session is not ended again`);
          assert.equal(posted(stub, '/url').length, 0, `${label}: nothing navigated`);
        } finally {
          stub.close();
        }
      }
    }
  });

  it('a session request lost inside a test (launch after a confirmed end) keeps the window unknown: close is uncertain', async () => {
    const stub = await startW3CStub({}, (req) => (req.method === 'POST' && req.path === '/session' && sessionRequests(stub) === 2 ? 'destroy' : undefined));
    try {
      const driver = new DesktopWebDriver('desktop-chrome', 'desktop-chrome', { serverUrl: stub.url });
      await driver.open(CHROME);
      assert.equal((await driver.terminate(CHROME)).status, 'completed');
      assert.equal((await driver.launch(CHROME)).status, 'uncertain');
      assert.equal((await driver.launch(CHROME)).status, 'uncertain');
      await assert.rejects(driver.close(), (err: Error) => failureStatus(err) === 'uncertain' && /창이 남았을 수 있음/.test(err.message));
      assert.equal(sessionRequests(stub), 2);
    } finally {
      stub.close();
    }
  });

  it('a confirmed DELETE completes terminate; reset clear opens a fresh session at the start URL', async () => {
    await withDriver({}, async (d, stub) => {
      assert.equal((await d.reset(CHROME, 'clear')).status, 'completed');
      assert.equal(deletes(stub), 1);
      assert.equal(stub.requests.filter((r) => r.method === 'POST' && r.path === '/session').length, 2);
      assert.deepEqual(posted(stub, '/url').map((r) => r.body), [{ url: CHROME.url }]);
      assert.equal((await d.terminate(CHROME)).status, 'completed');
    });
  });
});

describe('isHittable', () => {
  const target = { x: 564, y: 86, width: 60, height: 44 };

  it('is true when the hit element or an ancestor occupies the target box (±2 px)', async () => {
    const cases: [unknown, boolean][] = [
      [[[570, 90, 20, 20], [565.5, 84.2, 61.8, 45.9], [0, 0, 1280, 2000]], true],
      [[[0, 0, 1265, 800], [0, 0, 1280, 800]], false],
      [[[567, 86, 60, 44]], false],
      [[], false],
    ];
    for (const [hitBoxes, expected] of cases) {
      await withDriver({ hitBoxes }, async (d) => assert.equal(await d.isHittable({ x: 594, y: 108 }, target), expected, JSON.stringify(hitBoxes)));
    }
  });

  it('cannot tell without a target, and a garbled answer throws', async () => {
    await withDriver({ hitBoxes: 'nope' }, async (d, stub) => {
      assert.equal(await d.isHittable({ x: 1, y: 1 }, null), undefined);
      assert.equal(stub.scripts().filter((s) => s === 'hit').length, 0);
      await assert.rejects(d.isHittable({ x: 1, y: 1 }, target));
    });
  });
});

describe('elementIdAt', () => {
  const ref = (id: string) => ({ [W3C_ELEMENT_KEY]: id });

  it('is the W3C reference of the element at the (rounded) point; it changes when the page swaps the element', async () => {
    await withDriver({ element: ref('E-old') }, async (d, stub) => {
      assert.equal(await d.elementIdAt(AT), 'E-old');
      assert.deepEqual(posted(stub, '/execute/sync').at(-1)?.body, { script: DESKTOP_SCRIPTS.element, args: [401, 107] });
      assert.equal(await d.elementIdAt(AT), 'E-old');
      stub.page.element = ref('E-new'); // same box, name and state; another element
      assert.equal(await d.elementIdAt(AT), 'E-new');
    });
  });

  it('is null when nothing is there; a garbled answer throws', async () => {
    await withDriver({ element: null }, async (d, stub) => {
      assert.equal(await d.elementIdAt({ x: 5000, y: 5000 }), null);
      for (const garbled of ['E1', { [W3C_ELEMENT_KEY]: '' }, { id: 'E1' }, [ref('E1')]]) {
        stub.page.element = garbled;
        await assert.rejects(d.elementIdAt(AT), /elementFromPoint: unexpected response/, JSON.stringify(garbled));
      }
    });
  });
});

describe('focusedElementId', () => {
  const ref = (id: string) => ({ [W3C_ELEMENT_KEY]: id });

  it('is the W3C reference of the focused element; it changes when the page swaps the element', async () => {
    await withDriver({ active: ref('F-old') }, async (d, stub) => {
      assert.equal(await d.focusedElementId(), 'F-old');
      assert.deepEqual(posted(stub, '/execute/sync').at(-1)?.body, { script: DESKTOP_SCRIPTS.active, args: [] });
      assert.equal(await d.focusedElementId(), 'F-old');
      stub.page.active = ref('F-new'); // same tree path, box, value and state; another element
      assert.equal(await d.focusedElementId(), 'F-new');
    });
  });

  it('is null when nothing is focused; a garbled answer throws', async () => {
    await withDriver({ active: null }, async (d, stub) => {
      assert.equal(await d.focusedElementId(), null);
      for (const garbled of ['F1', true, { [W3C_ELEMENT_KEY]: '' }, { id: 'F1' }, [ref('F1')]]) {
        stub.page.active = garbled;
        await assert.rejects(d.focusedElementId(), /activeElement: unexpected response/, JSON.stringify(garbled));
      }
    });
  });

  it('the page script returns the deepest focused element through open shadow roots, and null for the body or no focus', () => {
    const body = { shadowRoot: null };
    const html = { shadowRoot: null };
    const active = (activeElement: unknown): unknown => new Function('document', DESKTOP_SCRIPTS.active)({ activeElement, body, documentElement: html });
    const input = { shadowRoot: null };
    const host = { shadowRoot: { activeElement: input } };
    const closedHost = { shadowRoot: null };
    const hostWithoutFocus = { shadowRoot: { activeElement: null } };
    assert.equal(active(input), input);
    assert.equal(active(host), input);
    assert.equal(active({ shadowRoot: { activeElement: host } }), input);
    assert.equal(active(closedHost), closedHost);
    assert.equal(active(hostWithoutFocus), hostWithoutFocus);
    for (const nothing of [body, html, null]) assert.equal(active(nothing), null);
  });
});

describe('console logs', () => {
  it('Chrome console lines are sanitized before they reach the file, and sliced by time', async () => {
    const before = new Set(readdirSync(PATHS.logs, { withFileTypes: false }).map(String));
    const now = Date.now();
    try {
      await withDriver(
        {
          console: [
            { timestamp: now - 60_000, level: 'INFO', message: 'old line' },
            { timestamp: now, level: 'SEVERE', message: 'token=hunter2 failed\n    at app.js:1' },
          ],
        },
        async (d) => {
          await d.startLogs(CHROME, (line) => line.replace(/hunter2/g, '***'));
          const slice = await d.logSlice(new Date(now - 1000).toISOString(), new Date(now + 1000).toISOString());
          assert.match(slice, /SEVERE token=\*\*\* failed\n {4}at app\.js:1$/);
          assert.doesNotMatch(slice, /old line/);
        },
      );
      const files = readdirSync(PATHS.logs).filter((f) => f.startsWith('desktop-chrome-') && !before.has(f));
      assert.equal(files.length, 1);
      const file = join(PATHS.logs, files[0]!);
      assert.doesNotMatch(readFileSync(file, 'utf8'), /hunter2/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      for (const f of readdirSync(PATHS.logs).filter((f) => f.startsWith('desktop-chrome-') && !before.has(f))) rmSync(join(PATHS.logs, f), { force: true });
    }
  });

  it('Safari has no console log over WebDriver', async () => {
    await withDriver({}, async (d) => await assert.rejects(d.startLogs(SAFARI, (l) => l), /콘솔 로그 미지원/), undefined, SAFARI);
  });
});

describe('chooseDevice for desktop browsers', () => {
  const browser = (platform: DeviceInfo['platform'], state: DeviceInfo['state']): DeviceInfo => ({ platform, id: platform, name: 'Chrome 153', osVersion: '26.6', state, kind: 'browser' });

  it('picks the browser of the platform and names a missing browser as a browser, not a device to boot', () => {
    assert.equal(chooseDevice([browser('desktop-safari', 'booted'), browser('desktop-chrome', 'booted')], 'desktop-chrome').platform, 'desktop-chrome');
    assert.throws(() => chooseDevice([browser('desktop-chrome', 'offline')], 'desktop-chrome'), /^Error: Chrome \(macOS\)을\(를\) 사용할 수 없습니다/);
    assert.throws(() => chooseDevice([browser('desktop-chrome', 'offline')], 'desktop-chrome', 'desktop-chrome'), /Chrome 153을\(를\) 사용할 수 없습니다 \(브라우저 또는 WebDriver 없음/);
  });
});
