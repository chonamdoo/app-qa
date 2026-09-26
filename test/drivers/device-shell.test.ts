// Host commands through a fake `adb` whose `shell` is a real /bin/sh: app ids are validated before anything runs,
// every device-shell argument arrives verbatim, and permission/recording commands touch only what they must.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { adb, adbShell, CommandError } from '../../src/appium/exec.ts';
import { AndroidDriver } from '../../src/drivers/android.ts';
import { backupApp, findBackup } from '../../src/drivers/backup.ts';
import { failureStatus } from '../../src/drivers/base.ts';
import { IosDriver } from '../../src/drivers/ios.ts';
import { startRecording, stopRecording } from '../../src/drivers/screen.ts';
import { installFakeAdb, type FakeAdb } from './stubs.ts';

const APP = { platform: 'android' as const, appId: 'kr.tteonam.app' };
const HOSTILE_IDS = ['kr.tteonam.app; reboot', '../../etc', 'kr.tteonam/../../x', "kr.tteonam.app' '", '$(id)'];

describe('device shell safety', () => {
  let fake: FakeAdb;
  let scratch: string;
  beforeEach(() => {
    fake = installFakeAdb();
    scratch = mkdtempSync(join(tmpdir(), 'qa-shell-'));
  });
  afterEach(() => {
    fake.restore();
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.FAKE_APPOPS_FAIL;
  });

  it('every driver entry refuses an invalid app id before any host command runs', async () => {
    const android = new AndroidDriver('emulator-5554');
    const ios = new IosDriver('SIM-UDID');
    for (const appId of HOSTILE_IDS) {
      const a = { platform: 'android' as const, appId };
      const i = { platform: 'ios' as const, appId };
      for (const o of [
        await android.launch(a),
        await android.terminate(a),
        await android.openUrl(a, 'tteonam://home'),
        await android.reset(a, 'clear'),
        await ios.launch(i),
        await ios.terminate(i),
        await ios.reset(i, 'reinstall'),
      ]) {
        assert.equal(o.status, 'rejected', `${appId}: ${o.error}`);
        assert.match(o.error ?? '', /ID가 올바르지 않습니다/);
      }
      await assert.rejects(android.open(a), /ID가 올바르지 않습니다/);
      await assert.rejects(android.startLogs(a, (line) => line), /ID가 올바르지 않습니다/);
    }
    assert.deepEqual(fake.hostCalls(), []);
  });

  it('backups refuse invalid ids (no traversal out of .qa/apps) before touching the device', async () => {
    for (const appId of HOSTILE_IDS) {
      await assert.rejects(backupApp('android', 'emulator-5554', appId), /ID가 올바르지 않습니다/);
      assert.throws(() => findBackup('ios', appId), /ID가 올바르지 않습니다/);
    }
    assert.deepEqual(fake.hostCalls(), []);
  });

  it('launch passes permissions, component and extras to the device verbatim (no shell expansion)', async () => {
    const pwned = join(scratch, 'pwned');
    const perm = `kr.tteonam.PERM;touch ${pwned}`;
    const extra = `a b'$(touch ${pwned})\`touch ${pwned}\`"`;
    const o = await new AndroidDriver('emulator-5554').launch(APP, { permissions: { [perm]: 'unset' }, arguments: ['--es', 'q', extra] });
    assert.equal(o.status, 'completed', o.error ?? '');
    assert.deepEqual(fake.deviceCalls(), [
      ['pm', 'revoke', 'kr.tteonam.app', perm],
      ['pm', 'clear-permission-flags', 'kr.tteonam.app', perm, 'user-set', 'user-fixed'],
      ['cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', 'kr.tteonam.app'],
      ['am', 'start', '-W', '-n', 'kr.tteonam.app/.MainActivity', '--es', 'q', extra],
    ]);
    assert.equal(existsSync(pwned), false);
  });

  it('a permission change the device refuses is not ignored', async () => {
    process.env.FAKE_APPOPS_FAIL = '1';
    const o = await new AndroidDriver('emulator-5554').launch(APP, { permissions: { location: 'deny' } });
    assert.equal(o.status, 'rejected');
    assert.match(o.error ?? '', /appops/);
    assert.ok(!fake.deviceCalls().some((c) => c[0] === 'am'), 'the app must not be launched with the wrong permission state');
  });

  it('stopping a recording signals only the screenrecord this process started', async () => {
    const foreign = spawn(join(fake.root, 'device', 'screenrecord'), ['/sdcard/foreign.mp4'], { env: { ...process.env }, stdio: 'ignore' });
    try {
      const file = join(scratch, 'rec.mp4');
      await startRecording('android', 'emulator-5554', file);
      assert.equal(await stopRecording('android', 'emulator-5554', file), file);
      assert.equal(readFileSync(file, 'utf8'), 'mp4\n'); // finalized by SIGINT, then pulled
      await delay(100);
      assert.equal(foreign.exitCode, null, 'another tool’s screenrecord keeps running');
      assert.equal(foreign.signalCode, null);
      assert.ok(!fake.deviceCalls().some((c) => c[0] === 'pkill'));
    } finally {
      foreign.kill('SIGKILL');
    }
  });
});

describe('host command outcome when the adb transport drops', () => {
  let fake: FakeAdb;
  beforeEach(() => {
    fake = installFakeAdb();
  });
  afterEach(() => fake.restore());

  // adb's messages for a lost device or stream; exit 255 = shell v2 stream lost, 137 = device command killed by SIGKILL.
  const DROPS: [stderr: string, exit: number][] = [
    ['error: closed', 1],
    ['adb: device offline', 1],
    ["adb: device 'emulator-5554' not found", 1],
    ['adb: no devices/emulators found', 1],
    ["error: protocol fault (couldn't read status): Connection reset by peer", 1],
    ['', 255],
    ['', 137],
  ];

  it('a drop after `am start` ran is uncertain, never rejected', async () => {
    for (const [stderr, exit] of DROPS) {
      fake.dropAfter('am start', stderr, exit);
      const o = await new AndroidDriver('emulator-5554').launch(APP);
      assert.equal(o.status, 'uncertain', `${stderr || '(no stderr)'} / exit ${exit}: ${o.error}`);
    }
    assert.equal(fake.deviceCalls().filter((c) => c[0] === 'am').length, DROPS.length, 'the device ran am start every time');
  });

  it('a drop after `pm clear` ran is uncertain, never rejected', async () => {
    for (const [stderr, exit] of DROPS) {
      fake.dropAfter('pm clear', stderr, exit);
      const err: unknown = await adbShell('emulator-5554', ['pm', 'clear', 'kr.tteonam.app']).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof CommandError, String(err));
      assert.equal(failureStatus(err), 'uncertain', `${stderr || '(no stderr)'} / exit ${exit}`);
    }
  });

  it('a permission command whose exit status never arrived is uncertain, and the app is not launched', async () => {
    fake.dropAfter('pm grant', '', 0);
    const o = await new AndroidDriver('emulator-5554').launch(APP, { permissions: { camera: 'allow' } });
    assert.equal(o.status, 'uncertain', o.error ?? '');
    assert.ok(!fake.deviceCalls().some((c) => c[0] === 'am'));
  });

  it('an install the package manager refuses is rejected', async () => {
    fake.failInstall('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]');
    const err: unknown = await adb('emulator-5554', ['install', '-r', '-d', '/data/local/tmp/app.apk']).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof CommandError, String(err));
    assert.match(err.stderr, /INSTALL_FAILED_VERSION_DOWNGRADE/);
    assert.equal(failureStatus(err), 'rejected');
  });
});
