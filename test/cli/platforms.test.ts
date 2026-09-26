import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cmdApps } from '../../src/cli/commands/apps.ts';
import { cmdRun } from '../../src/cli/commands/run.ts';
import { cmdSetup } from '../../src/cli/commands/setup.ts';
import { cmdSmoke } from '../../src/cli/commands/smoke.ts';
import { parseDevices, parsePlatform } from '../../src/cli/platforms.ts';
import { PLATFORMS } from '../../src/core/platform.ts';

describe('--platform', () => {
  test('every platform is accepted; `all` only where the command takes it', () => {
    for (const p of PLATFORMS) {
      assert.equal(parsePlatform(p, true), p);
      assert.equal(parsePlatform(p, false), p);
    }
    assert.equal(parsePlatform('all', true), 'all');
    assert.match((parsePlatform('all', false) as { error: string }).error, /android\|ios\|desktop-chrome\|desktop-safari 중 하나/);
  });

  test('unknown values and inherited property names are usage errors', () => {
    for (const value of ['windows', 'desktop', 'Android', '', 'toString', '__proto__', 'constructor']) {
      assert.equal(typeof parsePlatform(value, true), 'object', value);
    }
  });
});

describe('--device', () => {
  test('<platform>:<id> names any platform; the id may contain colons', () => {
    assert.deepEqual(parseDevices(['desktop-chrome:desktop-chrome', 'android:192.168.0.2:5555', 'ios:D04B'], 'all'), {
      'desktop-chrome': 'desktop-chrome',
      android: '192.168.0.2:5555',
      ios: 'D04B',
    });
  });

  test('a bare id belongs to the single --platform, even when it contains a colon', () => {
    assert.deepEqual(parseDevices(['192.168.0.2:5555'], 'android'), { android: '192.168.0.2:5555' });
    assert.deepEqual(parseDevices(['desktop-safari'], 'desktop-safari'), { 'desktop-safari': 'desktop-safari' });
  });

  test('misuse is an error, never a silently ignored id', () => {
    assert.match((parseDevices(['emulator-5554'], 'all') as { error: string }).error, /<플랫폼>:<id>/);
    assert.match((parseDevices(['ios:D04B'], 'android') as { error: string }).error, /--platform android와 맞지 않습니다/);
    assert.match((parseDevices(['android:'], 'all') as { error: string }).error, /비어 있습니다/);
  });
});

describe('command argument checks (before any device is touched)', () => {
  test('qa apps rejects desktop browsers', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    assert.equal(await cmdApps(['--platform', 'desktop-chrome']), 2);
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /qa apps는 android, ios만 지원합니다/);
  });

  test('qa setup: --android/--ios need --browsers', async (t) => {
    t.mock.method(console, 'error', () => {});
    assert.equal(await cmdSetup(['--android', 'emulator-5554']), 2);
    assert.equal(await cmdSetup(['--ios', 'D04B']), 2);
  });

  test('qa run / qa smoke reject unknown platforms and mismatched devices', async (t) => {
    t.mock.method(console, 'error', () => {});
    assert.equal(await cmdRun(['--platform', 'windows']), 2);
    assert.equal(await cmdRun(['--platform', 'desktop-chrome', '--device', 'android:emulator-5554']), 2);
    assert.equal(await cmdSmoke(['--app', 'web-demo', '--platform', 'all', '--device', 'emulator-5554']), 2);
  });
});
