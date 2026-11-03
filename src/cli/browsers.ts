// Browser readiness shared by `qa setup --browsers` (prepares the mobile browsers) and `qa doctor` (read-only checks).
import type { Check } from '../appium/setup.ts';
import { connectAgentClient } from '../core/agent-client.ts';
import { PLATFORM_INFO } from '../core/platform.ts';
import type { DeviceInfo } from '../core/types.ts';

type MobilePlatform = 'android' | 'ios';

export const MOBILE_APPIUM_DRIVERS = ['uiautomator2', 'xcuitest'] as const;

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

export async function desktopBrowserChecks(): Promise<Check[]> {
  try {
    const client = await connectAgentClient();
    const { capabilities, runtimes, instances } = await client.request({ method: 'instance.list' });
    const checks: Check[] = runtimes.map(runtime => ({
      label: `${PLATFORM_INFO[runtime.platform].label} · ${runtime.runtime}`,
      ok: runtime.available,
      detail: runtime.reason ?? `${runtime.readiness} · 수집 범위 ${runtime.capture} · 첫 실제 프레임은 실행 점유 후 확인`,
    }));
    if (capabilities) checks.push({
      label: 'macOS guest 가상화', ok: capabilities.supported,
      detail: capabilities.supported ? `가용 메모리 ${capabilities.availableMemoryMiB} MiB / 물리 메모리 ${capabilities.physicalMemoryMiB} MiB · 최대 VM ${capabilities.maximumMachines}` : capabilities.reason ?? '이 호스트에서 guest 가상화를 사용할 수 없습니다',
    });
    if (!instances.length) checks.push({ label: '소유 브라우저 context', ok: false, detail: '엔진 소유 context가 없습니다', hint: '환경 및 기기에서 Chrome context 또는 준비된 실제 Safari worker를 선택하세요. 개인 브라우저는 대체 경로가 아닙니다.' });
    for (const instance of instances) checks.push({
      label: `${PLATFORM_INFO[instance.platform].label} · ${instance.name}`,
      ok: instance.state === 'ready',
      detail: `${instance.id} · ${instance.state} · ${instance.browserVersion ?? '브라우저 버전 미확인'}${instance.reason ? ` · ${instance.reason}` : ''}`,
      hint: instance.state === 'running' ? '현재 실행의 증거 확정·정리 후 순차 진행합니다' : instance.runtime === 'owned-chrome' ? '환경 및 기기에서 소유 Chrome context를 준비하세요. VM 설치는 필요하지 않습니다.' : '환경 및 기기에서 실제 macOS guest 내부 설정을 확인하세요',
    });
    return checks;
  } catch (err) {
    return [{ label: '소유 브라우저 엔진', ok: false, detail: err instanceof Error ? err.message : String(err), hint: '이 프로젝트에서 qa serve를 실행하세요. 개인 Safari 권한이나 Appium desktop driver로 대체하지 않습니다.' }];
  }
}

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
  const groups: CheckGroup[] = [{ title: '소유 데스크톱 브라우저', checks: await guard('소유 데스크톱 브라우저', steps.desktop) }];
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
