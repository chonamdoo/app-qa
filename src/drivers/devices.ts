// Device discovery: `adb devices -l` + getprop, `xcrun simctl list -j devices`.
import { adb, adbShell, CommandError, xcrun } from '../appium/exec.ts';
import type { DeviceInfo, Platform } from '../core/types.ts';

export interface AdbDeviceLine {
  serial: string;
  /** adb state: device | offline | unauthorized | recovery | … */
  state: string;
  props: Record<string, string>;
}

/** Parses `adb devices -l`. Skips the header, daemon notices and blank lines. */
export function parseAdbDevices(out: string): AdbDeviceLine[] {
  const devices: AdbDeviceLine[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader|host|no permissions|authorizing|connecting)\b(.*)$/.exec(line.trim());
    if (!m || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const props: Record<string, string> = {};
    for (const kv of m[3]!.trim().split(/\s+/)) {
      const i = kv.indexOf(':');
      if (i > 0) props[kv.slice(0, i)] = kv.slice(i + 1);
    }
    devices.push({ serial: m[1]!, state: m[2]!, props });
  }
  return devices;
}

/** Parses `getprop` output lines `[key]: [value]`. */
export function parseGetprop(out: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const m of out.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm)) props[m[1]!] = m[2]!;
  return props;
}

export function androidDeviceInfo(line: AdbDeviceLine, props: Record<string, string>): DeviceInfo {
  const emulator = line.serial.startsWith('emulator-') || props['ro.kernel.qemu'] === '1' || props['ro.boot.qemu'] === '1';
  const avd = props['ro.boot.qemu.avd_name'] ?? props['ro.kernel.qemu.avd_name'];
  const model = props['ro.product.model'] ?? line.props.model ?? line.serial;
  return {
    platform: 'android',
    id: line.serial,
    name: avd ? avd.replace(/_/g, ' ') : model.replace(/_/g, ' '),
    osVersion: props['ro.build.version.release'] ?? '',
    state: line.state === 'device' ? 'booted' : 'offline',
    kind: emulator ? 'emulator' : 'device',
  };
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

/** Parses `xcrun simctl list -j devices`: available iOS simulators only (watchOS/tvOS/visionOS runtimes skipped). */
export function parseSimctlDevices(json: string): DeviceInfo[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, SimctlDevice[]> };
  const out: DeviceInfo[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    const m = /SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(runtime);
    if (!m) continue;
    const osVersion = [m[1], m[2], m[3]].filter((x) => x !== undefined).join('.');
    for (const d of list) {
      if (d.isAvailable === false) continue;
      out.push({
        platform: 'ios',
        id: d.udid,
        name: d.name,
        osVersion,
        state: d.state === 'Booted' ? 'booted' : d.state === 'Shutdown' ? 'shutdown' : 'offline',
        kind: 'simulator',
      });
    }
  }
  return out;
}

const missingTool = (err: unknown) => err instanceof CommandError && err.spawnCode === 'ENOENT';

async function androidDevices(): Promise<DeviceInfo[]> {
  const lines = parseAdbDevices(await adb(null, ['devices', '-l'], { timeoutMs: 15_000 }));
  return Promise.all(
    lines.map(async (line) => {
      const props = line.state === 'device' ? parseGetprop(await adbShell(line.serial, ['getprop'], { timeoutMs: 15_000 })) : {};
      return androidDeviceInfo(line, props);
    }),
  );
}

/**
 * Android devices/emulators known to adb and available iOS simulators (booted first).
 * A platform whose host tool is missing (no adb / no xcrun) is skipped; other failures throw.
 */
export async function listDevices(platform?: Platform): Promise<DeviceInfo[]> {
  const jobs: Promise<DeviceInfo[]>[] = [];
  if (platform !== 'ios') jobs.push(androidDevices().catch((err) => (missingTool(err) ? [] : Promise.reject(err))));
  if (platform !== 'android') {
    jobs.push(
      xcrun(['simctl', 'list', '-j', 'devices'], { timeoutMs: 30_000 })
        .then(parseSimctlDevices)
        .catch((err) => (missingTool(err) ? [] : Promise.reject(err))),
    );
  }
  const all = (await Promise.all(jobs)).flat();
  const rank = { booted: 0, offline: 1, shutdown: 2 };
  return all.sort((a, b) => rank[a.state] - rank[b.state] || a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
}

/** Chooses the device for a run: explicit id must exist and be booted; otherwise exactly one booted device of the platform. */
export function chooseDevice(devices: DeviceInfo[], platform: Platform, id?: string): DeviceInfo {
  const mine = devices.filter((d) => d.platform === platform);
  if (id) {
    const d = mine.find((x) => x.id === id);
    if (!d) throw new Error(`${platform} 디바이스 '${id}'를 찾을 수 없습니다. \`qa devices\`로 확인하세요.`);
    if (d.state !== 'booted') throw new Error(`${platform} 디바이스 '${id}' (${d.name})가 부팅되어 있지 않습니다 (상태: ${d.state}).`);
    return d;
  }
  const booted = mine.filter((d) => d.state === 'booted');
  if (booted.length === 1) return booted[0]!;
  if (booted.length === 0) throw new Error(`부팅된 ${platform === 'android' ? 'Android 에뮬레이터/기기' : 'iOS 시뮬레이터'}가 없습니다.`);
  throw new Error(`부팅된 ${platform} 디바이스가 여러 개입니다. --device로 지정하세요: ${booted.map((d) => `${d.id} (${d.name})`).join(', ')}`);
}

export async function pickDevice(platform: Platform, id?: string): Promise<DeviceInfo> {
  return chooseDevice(await listDevices(platform), platform, id);
}
