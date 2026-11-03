import { parseArgs } from 'node:util';
import { connectEngineClient } from '../../core/agent-client.ts';
import type { DeviceInfo } from '../../core/types.ts';
import { parsePlatform, PLATFORM_LIST } from '../platforms.ts';

const USAGE = `사용법: qa devices [--platform ${PLATFORM_LIST}] [--all] [--json]
  이 프로젝트의 qa serve가 관리하는 디바이스와 guest 브라우저 context를 표시합니다.
  기본은 꺼진 시뮬레이터를 제외합니다. --all이면 꺼진 시뮬레이터도 표시합니다.
종료 코드: 0 = 성공, 1 = 조회 실패, 2 = 사용법 오류`;

const STATE_LABEL: Record<string, string> = { booted: '부팅됨', shutdown: '꺼짐', offline: '오프라인' };

export async function cmdDevices(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { platform: { type: 'string' }, all: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const platform = values.platform === undefined ? undefined : parsePlatform(values.platform, false);
  if (typeof platform === 'object') {
    console.error(`${platform.error}\n${USAGE}`);
    return 2;
  }
  let devices: DeviceInfo[];
  try {
    const client = await connectEngineClient();
    const response = await client.request<{ devices: DeviceInfo[] }>('/api/devices');
    devices = response.devices.filter((device) => !platform || device.platform === platform);
  } catch (err) {
    console.error(`디바이스 목록을 가져오지 못했습니다. 이 프로젝트에서 qa serve를 실행하세요: ${(err as Error).message}`);
    return 1;
  }
  if (!values.all) devices = devices.filter((d) => d.state !== 'shutdown');
  if (values.json) {
    console.log(JSON.stringify(devices, null, 2));
    return 0;
  }
  if (devices.length === 0) {
    console.log('디바이스가 없습니다. 에뮬레이터·시뮬레이터를 부팅하거나 QAutra에서 guest 브라우저 인스턴스를 준비하세요.');
    return 0;
  }
  const rows = devices.map((d) => [d.platform, d.id, d.name, d.osVersion, STATE_LABEL[d.state] ?? d.state, d.kind]);
  const header = ['플랫폼', 'ID', '이름', 'OS', '상태', '종류'];
  // Hangul/CJK occupy two terminal columns.
  const width = (s: string) => [...s].reduce((w, ch) => w + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(ch) ? 2 : 1), 0);
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]!))));
  for (const r of [header, ...rows]) console.log(r.map((c, i) => c + ' '.repeat(widths[i]! - width(c))).join('  ').trimEnd());
  return 0;
}
