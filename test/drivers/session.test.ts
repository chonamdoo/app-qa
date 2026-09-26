// Driver actions over a scripted Appium server: lost or garbled answers are `uncertain`, never `completed`/`rejected`.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { IosDriver } from '../../src/drivers/ios.ts';
import { scriptOf, startAppiumStub, type AppiumStub, type Reply } from './stubs.ts';

const APP = { platform: 'ios' as const, appId: 'kr.tteonam.app' };

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
    await driver.open({ platform: 'android', appId: 'kr.tteonam.app' });
    assert.equal((await driver.tap({ x: 10, y: 10 })).status, 'uncertain');
    await driver.close();
  });

  it('a tap answered with a message-less W3C refusal is rejected', async () => {
    stub = await startAppiumStub((req) => (req.path === '/session/s1/actions' ? { body: { value: { error: 'move target out of bounds' } } } : undefined));
    const driver = new AndroidDriver('emulator-5554', { serverUrl: stub.url });
    await driver.open({ platform: 'android', appId: 'kr.tteonam.app' });
    assert.equal((await driver.tap({ x: 10, y: 10 })).status, 'rejected');
    await driver.close();
  });
});
