// Driver actions over a scripted Appium server: lost or garbled answers are `uncertain`, never `completed`/`rejected`.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { W3C_ELEMENT_KEY } from '../../src/appium/client.ts';
import type { ActionOutcome } from '../../src/core/types.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { IosDriver } from '../../src/drivers/ios.ts';
import { scriptOf, startAppiumStub, type AppiumStub, type Reply } from './stubs.ts';

const APP = { kind: 'app' as const, platform: 'ios' as const, appId: 'kr.tteonam.app' };

describe('iOS hideKeyboard outcome', () => {
  /** Keyboard shown until a hideKeyboard answer arrives that `dismisses`; the hideKeyboard reply is scripted. */
  async function hide(hideReply: Reply, dismisses: boolean, shownReply?: Reply) {
    let shown = true;
    let sent = 0;
    const stub = await startAppiumStub((req) => {
      const script = scriptOf(req);
      if (script === 'mobile: isKeyboardShown') return shownReply ?? { body: { value: shown } };
      if (script === 'mobile: hideKeyboard') {
        sent++;
        if (dismisses) shown = false;
        return hideReply;
      }
      return undefined;
    });
    const driver = new IosDriver('SIM-UDID', { serverUrl: stub.url });
    try {
      await driver.open(APP);
      return { ...(await driver.hideKeyboard()), sent };
    } finally {
      await driver.close();
      stub.close();
    }
  }

  it('a dropped connection is uncertain (sent once, never retried) although the keyboard is still shown', async () => {
    const o = await hide('destroy', false);
    assert.equal(o.status, 'uncertain');
    assert.equal(o.sent, 1);
  });

  it('a garbled or error-less answer is uncertain', async () => {
    assert.equal((await hide({ body: {} }, false)).status, 'uncertain');
    assert.equal((await hide({ body: 'not json' }, false)).status, 'uncertain');
  });

  it('an unreadable keyboard state is uncertain, not "already hidden"', async () => {
    assert.equal((await hide({ body: { value: null } }, true, { body: { value: 'yes' } })).status, 'uncertain');
  });

  it('only an answered command with the keyboard verified still shown is rejected', async () => {
    const o = await hide({ body: { value: null } }, false);
    assert.equal(o.status, 'rejected');
    assert.match(o.error ?? '', /키보드/);
  });

  it('an answered command that dismissed the keyboard is completed', async () => {
    assert.equal((await hide({ body: { value: null } }, true)).status, 'completed');
  });
});

describe('gesture outcome on unvalidated 200 answers', () => {
  let stub: AppiumStub | null = null;
  afterEach(() => stub?.close());

  it('a tap answered with HTTP 200 but no W3C envelope is uncertain', async () => {
    stub = await startAppiumStub((req) => (req.path === '/session/s1/actions' ? { body: {} } : undefined));
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await driver.open({ kind: 'app', platform: 'android', appId: 'kr.tteonam.app' });
    assert.equal((await driver.tap({ x: 10, y: 10 })).status, 'uncertain');
    await driver.close();
  });

  it('a tap answered with a message-less W3C refusal is rejected', async () => {
    stub = await startAppiumStub((req) => (req.path === '/session/s1/actions' ? { body: { value: { error: 'move target out of bounds' } } } : undefined));
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await driver.open({ kind: 'app', platform: 'android', appId: 'kr.tteonam.app' });
    assert.equal((await driver.tap({ x: 10, y: 10 })).status, 'rejected');
    await driver.close();
  });

  it('an error that is not a known W3C refusal (inherited object keys, unknown codes, wrong shape) is uncertain', async () => {
    const bodies: unknown[] = [
      ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'no such thing'].map((error) => ({ value: { error, message: 'unvalidated' } })),
      { value: { error: 'no such element', message: 5 } },
      { value: { error: 'no such element', message: 'x', stacktrace: {} } },
    ];
    let reply: { status: number; body: unknown } = { status: 200, body: null };
    stub = await startAppiumStub((req) => (req.path === '/session/s1/actions' ? reply : undefined));
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await driver.open({ kind: 'app', platform: 'android', appId: 'kr.tteonam.app' });
    for (const status of [200, 404]) {
      for (const body of bodies) {
        reply = { status, body };
        assert.equal((await driver.tap({ x: 10, y: 10 })).status, 'uncertain', `${status} ${JSON.stringify(body)}`);
      }
    }
    await driver.close();
  });
});

describe('mutating commands succeed only with W3C value null', () => {
  const AT = { x: 10, y: 10 };
  /** Driver actions whose last device command is `path`. */
  const COMMANDS: Record<string, { path: string; platform: 'android' | 'ios'; act: (d: AndroidDriver | IosDriver) => Promise<ActionOutcome> }> = {
    'POST /actions (tap)': { path: '/session/s1/actions', platform: 'android', act: (d) => d.tap(AT) },
    'POST /element/:id/click (iOS back button)': { path: '/session/s1/element/B1/click', platform: 'ios', act: (d) => d.back() },
    'POST /element/:id/clear (clearText)': { path: '/session/s1/element/E1/clear', platform: 'android', act: (d) => d.clearText(AT) },
    'POST /element/:id/value (typeText)': { path: '/session/s1/element/E1/value', platform: 'android', act: (d) => d.typeText(AT, '대한항공') },
    'POST /keys (iOS enter)': { path: '/session/s1/keys', platform: 'ios', act: (d) => d.press('enter') },
  };

  /** Runs one command's action with `value` as that command's answer; the rest of the stub is a screen with one focused field and a nav-bar back button. */
  async function outcome(name: string, value: unknown): Promise<ActionOutcome> {
    const { path, platform, act } = COMMANDS[name]!;
    let typed = '';
    const stub = await startAppiumStub((req) => {
      if (req.path === path) {
        if (value === null && typeof req.body?.text === 'string') typed = req.body.text;
        return { body: { value } };
      }
      if (req.path === '/session/s1/element/active') return { body: { value: { [W3C_ELEMENT_KEY]: 'E1' } } };
      if (req.path === '/session/s1/element/E1/text') return { body: { value: typed } };
      if (req.path === '/session/s1/elements') return { body: { value: [{ [W3C_ELEMENT_KEY]: 'B1' }] } };
      if (req.path === '/session/s1/element/B1/rect') return { body: { value: { x: 0, y: 40, width: 60, height: 40 } } };
      if (scriptOf(req) === 'mobile: isKeyboardShown') return { body: { value: true } };
      return undefined;
    });
    const driver = platform === 'android' ? new AndroidDriver('emulator-5554', { serverUrl: stub.url }) : new IosDriver('SIM-UDID', { serverUrl: stub.url });
    try {
      await driver.open({ kind: 'app', platform, appId: 'kr.tteonam.app' });
      return await act(driver);
    } finally {
      await driver.close();
      stub.close();
    }
  }

  it('any other 200 value (object, false, true, "") is uncertain, never completed', async () => {
    for (const name of Object.keys(COMMANDS)) {
      for (const value of [{ done: true }, false, true, '']) {
        const o = await outcome(name, value);
        assert.equal(o.status, 'uncertain', `${name} → ${JSON.stringify(value)}: ${o.error}`);
      }
    }
  });

  it('value null is completed', async () => {
    for (const name of Object.keys(COMMANDS)) {
      const o = await outcome(name, null);
      assert.equal(o.status, 'completed', `${name}: ${o.error}`);
      assert.equal(o.error, undefined, name);
    }
  });
});

describe('mutating mobile: scripts succeed only with their documented answer', () => {
  const AT = { x: 10, y: 10 };
  const IOS_APP = { kind: 'app' as const, platform: 'ios' as const, appId: 'kr.tteonam.app' };
  const NOT_NULL = [{ done: true }, false, true, ''];
  /** Driver actions and the script whose answer is scripted; `documented` = the pinned drivers' success answers. */
  const SCRIPTS: Record<string, { platform: 'android' | 'ios'; script: string; documented: unknown[]; malformed: unknown[]; act: (d: AndroidDriver | IosDriver) => Promise<ActionOutcome> }> = {
    'Android press enter': { platform: 'android', script: 'mobile: pressKey', documented: [null], malformed: NOT_NULL, act: (d) => d.press('enter') },
    'Android typeText clipboard fallback': { platform: 'android', script: 'mobile: setClipboard', documented: [null], malformed: NOT_NULL, act: (d) => d.typeText(AT, '대한항공') },
    'iOS launch': { platform: 'ios', script: 'mobile: launchApp', documented: [null], malformed: NOT_NULL, act: (d) => d.launch(IOS_APP) },
    'iOS terminate': { platform: 'ios', script: 'mobile: terminateApp', documented: [true, false], malformed: [null, { terminated: true }, 'true', 1], act: (d) => d.terminate(IOS_APP) },
    'iOS hideKeyboard': { platform: 'ios', script: 'mobile: hideKeyboard', documented: [null], malformed: NOT_NULL, act: (d) => d.hideKeyboard() },
  };

  /**
   * Runs one action with `value` as its script's answer. The device performs every script it receives (the paste fills the
   * field, the keyboard hides), so only the answer decides the outcome. Screen: a focused Android field that setValue
   * leaves untouched (forcing the clipboard fallback) and a shown iOS keyboard.
   */
  async function outcome(name: string, value: unknown): Promise<ActionOutcome> {
    const { platform, script, act } = SCRIPTS[name]!;
    let field = '';
    let clipboard = '';
    let keyboard = true;
    const stub = await startAppiumStub((req) => {
      const s = scriptOf(req);
      const args = (req.body?.args as Record<string, unknown>[] | undefined)?.[0] ?? {};
      if (s === 'mobile: setClipboard') clipboard = Buffer.from(String(args.content), 'base64').toString('utf8');
      if (s === 'mobile: pressKey' && args.keycode === 279) field = clipboard;
      if (s === 'mobile: hideKeyboard') keyboard = false;
      if (s === script) return { body: { value } };
      if (s === 'mobile: isKeyboardShown') return { body: { value: keyboard } };
      if (req.path === '/session/s1/element/active') return { body: { value: { [W3C_ELEMENT_KEY]: 'E1' } } };
      if (req.path === '/session/s1/element/E1/text') return { body: { value: field } };
      return undefined;
    });
    const driver = platform === 'android' ? new AndroidDriver('emulator-5554', { serverUrl: stub.url }) : new IosDriver('SIM-UDID', { serverUrl: stub.url });
    try {
      await driver.open({ kind: 'app', platform, appId: 'kr.tteonam.app' });
      return await act(driver);
    } finally {
      await driver.close();
      stub.close();
    }
  }

  it('any other 200 value is uncertain, never completed', async () => {
    for (const [name, { script, malformed }] of Object.entries(SCRIPTS)) {
      for (const value of malformed) {
        const o = await outcome(name, value);
        assert.equal(o.status, 'uncertain', `${name} (${script}) → ${JSON.stringify(value)}: ${o.error}`);
      }
    }
  });

  it('the documented answer is completed', async () => {
    for (const [name, { script, documented }] of Object.entries(SCRIPTS)) {
      for (const value of documented) {
        const o = await outcome(name, value);
        assert.equal(o.status, 'completed', `${name} (${script}) → ${JSON.stringify(value)}: ${o.error}`);
        assert.equal(o.error, undefined, name);
      }
    }
  });
});
