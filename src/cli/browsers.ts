// Browser readiness shared by `qa setup --browsers` (prepares the mobile browsers) and `qa doctor` (read-only checks).
import type { Check } from '../appium/setup.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { DeviceInfo } from '../core/types.ts';

type MobilePlatform = 'android' | 'ios';

export interface BrowserSteps {
  desktop: () => Promise<Check[]>;
  /** Per-device step: prepare (setup) or check only (doctor). */
  mobile: Record<MobilePlatform, (deviceId: string) => Promise<Check[]>>;
}

export interface CheckGroup {
  title: string;
  checks: Check[];
}

const MOBILE: readonly MobilePlatform[] = ['android', 'ios'];

/**
 * Desktop browser checks, then the mobile step on the named device of each platform, or on every booted one when none is
 * named. A named device that is missing or not booted fails; a platform with no booted device is skipped (not a failure).
 */
export async function browserReadiness(devices: readonly DeviceInfo[], named: Partial<Record<MobilePlatform, string>>, steps: BrowserSteps): Promise<CheckGroup[]> {
  const guard = async (label: string, step: () => Promise<Check[]>): Promise<Check[]> => {
    try {
      return await step();
    } catch (err) {
      return [{ label, ok: false, detail: (err as Error).message.slice(0, 400) }];
    }
  };
  const groups: CheckGroup[] = [{ title: '데스크톱 브라우저', checks: await guard('데스크톱 브라우저', steps.desktop) }];
  for (const platform of MOBILE) {
    const label = PLATFORM_INFO[platform].webLabel;
    const mine = devices.filter((d) => d.platform === platform);
    const id = named[platform];
    if (id !== undefined) {
      const device = mine.find((d) => d.id === id);
      if (!device || device.state !== 'booted') {
        const detail = device ? `${id} (${device.name})가 부팅되어 있지 않습니다 (상태: ${device.state})` : `${id}를 찾을 수 없습니다`;
        groups.push({ title: label, checks: [{ label, ok: false, detail, hint: '`qa devices --all`로 기기 ID를 확인하고 부팅하세요' }] });
        continue;
      }
    }
    const targets = mine.filter((d) => d.state === 'booted' && (id === undefined || d.id === id));
    if (targets.length === 0) {
      groups.push({ title: label, checks: [{ label, ok: true, detail: `부팅된 ${PLATFORM_INFO[platform].label} 기기 없음 — 건너뜀` }] });
      continue;
    }
    for (const device of targets) {
      groups.push({ title: `${label} · ${device.name} (${device.id})`, checks: await guard(label, () => steps.mobile[platform](device.id)) });
    }
  }
  return groups;
}
