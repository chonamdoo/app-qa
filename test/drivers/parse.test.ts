import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBadging, parsePmPackages, parseSimctlApps } from '../../src/drivers/apps.ts';
import { parsePmPath } from '../../src/drivers/backup.ts';
import { androidDeviceInfo, chooseDevice, parseAdbDevices, parseGetprop, parseSimctlDevices } from '../../src/drivers/devices.ts';
import type { DeviceInfo } from '../../src/core/types.ts';

describe('adb devices -l', () => {
  it('parses device lines with properties and skips header/daemon notices', () => {
    const out = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 device:emu64a16k transport_id:10',
      'R58M123ABC             unauthorized usb:1-1 transport_id:3',
      '192.168.0.7:5555       offline transport_id:4',
      '',
    ].join('\n');
    const list = parseAdbDevices(out);
    assert.deepEqual(
      list.map((d) => [d.serial, d.state]),
      [
        ['emulator-5554', 'device'],
        ['R58M123ABC', 'unauthorized'],
        ['192.168.0.7:5555', 'offline'],
      ],
    );
    assert.equal(list[0]!.props.model, 'sdk_gphone16k_arm64');
  });

  it('builds DeviceInfo from getprop: AVD name, OS release, emulator kind; non-device states are offline', () => {
    const props = parseGetprop('[ro.boot.qemu]: [1]\n[ro.boot.qemu.avd_name]: [Medium_Phone]\n[ro.build.version.release]: [17]\n[ro.product.model]: [sdk_gphone16k_arm64]\n[empty.prop]: []\n');
    assert.equal(props['empty.prop'], '');
    const [emu, phone] = parseAdbDevices('emulator-5554 device model:x\nR58M123ABC unauthorized usb:1-1\n');
    assert.deepEqual(androidDeviceInfo(emu!, props), { platform: 'android', id: 'emulator-5554', name: 'Medium Phone', osVersion: '17', state: 'booted', kind: 'emulator' });
    const p = androidDeviceInfo(phone!, {});
    assert.equal(p.state, 'offline');
    assert.equal(p.kind, 'device');
  });
});

describe('simctl list -j devices', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'A', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        { udid: 'B', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
        { udid: 'C', name: 'iPhone Old', state: 'Shutdown', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-17-0-1': [{ udid: 'D', name: 'iPhone 15', state: 'Booting', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W', name: 'Apple Watch', state: 'Booted', isAvailable: true }],
    },
  });

  it('keeps available iOS simulators only, with dotted OS versions and mapped states', () => {
    const list = parseSimctlDevices(json);
    assert.deepEqual(
      list.map((d) => [d.id, d.osVersion, d.state]),
      [
        ['A', '26.5', 'booted'],
        ['B', '26.5', 'shutdown'],
        ['D', '17.0.1', 'offline'],
      ],
    );
    assert.ok(list.every((d) => d.platform === 'ios' && d.kind === 'simulator'));
  });
});

describe('chooseDevice', () => {
  const dev = (platform: DeviceInfo['platform'], id: string, state: DeviceInfo['state']): DeviceInfo => ({ platform, id, name: id, osVersion: '1', state, kind: 'emulator' });

  it('returns the only booted device of the platform, ignoring other platforms', () => {
    const d = chooseDevice([dev('ios', 'sim', 'booted'), dev('android', 'emu', 'booted'), dev('android', 'off', 'offline')], 'android');
    assert.equal(d.id, 'emu');
  });

  it('refuses when several are booted and no id is given (never guesses)', () => {
    assert.throws(() => chooseDevice([dev('ios', 'a', 'booted'), dev('ios', 'b', 'booted')], 'ios'), /여러 개.*a .*b /);
  });

  it('refuses unknown ids, non-booted ids, and platforms with nothing booted', () => {
    const list = [dev('ios', 'a', 'shutdown')];
    assert.throws(() => chooseDevice(list, 'ios', 'zzz'), /찾을 수 없습니다/);
    assert.throws(() => chooseDevice(list, 'ios', 'a'), /부팅되어 있지 않습니다/);
    assert.throws(() => chooseDevice(list, 'ios'), /부팅된 iOS 시뮬레이터가 없습니다/);
  });
});

describe('app listing parsers', () => {
  it('pm list packages -f: APK paths containing "=" keep the full path', () => {
    const out =
      'package:/data/app/~~Ekv89HJA4OnUKQwY0k43jg==/kr.tteonam.app-ib-4MlKhpyI0FRUg7yNijg==/base.apk=kr.tteonam.app versionCode:1\n' +
      'package:/data/app/~~x==/example.tickets-y==/base.apk=example.tickets\n';
    assert.deepEqual(parsePmPackages(out), [
      { apkPath: '/data/app/~~Ekv89HJA4OnUKQwY0k43jg==/kr.tteonam.app-ib-4MlKhpyI0FRUg7yNijg==/base.apk', appId: 'kr.tteonam.app', versionCode: '1' },
      { apkPath: '/data/app/~~x==/example.tickets-y==/base.apk', appId: 'example.tickets', versionCode: null },
    ]);
  });

  it('aapt2 badging: device-locale label wins over the default label', () => {
    const out = "package: name='kr.tteonam.app' versionCode='1' versionName='1.0.0' platformBuildVersionName='16'\napplication-label:'Tteonam'\napplication-label-ko:'떠남'\n";
    assert.deepEqual(parseBadging(out, 'ko-KR'), { label: '떠남', versionName: '1.0.0' });
    assert.deepEqual(parseBadging(out, 'en-US'), { label: 'Tteonam', versionName: '1.0.0' });
  });

  it('simctl listapps: only User apps, display name preferred', () => {
    const json = JSON.stringify({
      'kr.tteonam.app': { ApplicationType: 'User', CFBundleName: 'app', CFBundleDisplayName: '떠남', CFBundleVersion: '1' },
      'com.apple.Preferences': { ApplicationType: 'System', CFBundleDisplayName: 'Settings' },
    });
    assert.deepEqual(parseSimctlApps(json), [{ platform: 'ios', appId: 'kr.tteonam.app', label: '떠남', version: '1' }]);
  });

  it('pm path: base.apk first, then splits in name order', () => {
    const out = 'package:/data/app/x/split_config.xxhdpi.apk\npackage:/data/app/x/base.apk\npackage:/data/app/x/split_config.arm64_v8a.apk\n';
    assert.deepEqual(parsePmPath(out), ['/data/app/x/base.apk', '/data/app/x/split_config.arm64_v8a.apk', '/data/app/x/split_config.xxhdpi.apk']);
  });
});
