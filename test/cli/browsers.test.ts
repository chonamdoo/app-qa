import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Check } from '../../src/appium/setup.ts';
import { browserReadiness, type BrowserSteps } from '../../src/cli/browsers.ts';
import type { DeviceInfo } from '../../src/core/types.ts';

const device = (platform: 'android' | 'ios', id: string, state: DeviceInfo['state'] = 'booted'): DeviceInfo => ({
  platform,
  id,
  name: `${platform}-${id}`,
  osVersion: '1',
  state,
  kind: platform === 'android' ? 'emulator' : 'simulator',
});

/** Records which devices each step touched; every step passes unless `fail` names the device. */
function recordingSteps(fail: ReadonlySet<string> = new Set()): { steps: BrowserSteps; touched: string[] } {
  const touched: string[] = [];
  const step = (platform: string) => async (id: string): Promise<Check[]> => {
    touched.push(`${platform}:${id}`);
    if (fail.has(id)) throw new Error(`adb 실패 ${id}`);
    return [{ label: 'ok', ok: true, detail: id }];
  };
  return { steps: { desktop: async () => [{ label: 'Chrome', ok: true, detail: '153' }], mobile: { android: step('android'), ios: step('ios') } }, touched };
}

describe('browser readiness (qa setup --browsers / qa doctor)', () => {
  test('without a named device every booted device of each platform is handled; shutdown ones are not', async () => {
    const { steps, touched } = recordingSteps();
    const groups = await browserReadiness([device('android', 'e1'), device('android', 'e2'), device('ios', 's1', 'shutdown'), device('ios', 's2')], {}, steps);
    assert.deepEqual(touched, ['android:e1', 'android:e2', 'ios:s2']);
    assert.deepEqual(
      groups.map((g) => g.title),
      ['데스크톱 브라우저', 'Android Chrome · android-e1 (e1)', 'Android Chrome · android-e2 (e2)', 'iOS Safari · ios-s2 (s2)'],
    );
  });

  test('a platform with no booted device is skipped, not failed', async () => {
    const { steps, touched } = recordingSteps();
    const groups = await browserReadiness([device('ios', 's1', 'shutdown')], {}, steps);
    assert.deepEqual(touched, []);
    const mobile = groups.slice(1).flatMap((g) => g.checks);
    assert.ok(mobile.every((c) => c.ok && /건너뜀/.test(c.detail)), JSON.stringify(mobile));
  });

  test('a named device is the only one touched, and a missing or shut-down one fails', async () => {
    const { steps, touched } = recordingSteps();
    const devices = [device('android', 'e1'), device('android', 'e2'), device('ios', 's1', 'shutdown')];
    const groups = await browserReadiness(devices, { android: 'e2', ios: 's1' }, steps);
    assert.deepEqual(touched, ['android:e2']);
    const ios = groups.find((g) => g.title === 'iOS Safari')!;
    assert.equal(ios.checks[0]?.ok, false);
    assert.match(ios.checks[0]!.detail, /부팅되어 있지 않습니다/);
    const missing = await browserReadiness(devices, { android: 'nope' }, recordingSteps().steps);
    assert.equal(missing.find((g) => g.title === 'Android Chrome')?.checks[0]?.ok, false);
  });

  test('a step that throws becomes a failed check; the other devices still run', async () => {
    const { steps, touched } = recordingSteps(new Set(['e1']));
    const groups = await browserReadiness([device('android', 'e1'), device('android', 'e2')], {}, steps);
    assert.deepEqual(touched, ['android:e1', 'android:e2']);
    assert.deepEqual(
      groups.slice(1, 3).map((g) => g.checks[0]?.ok),
      [false, true],
    );
  });
});
