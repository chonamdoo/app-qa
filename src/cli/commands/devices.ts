// `qa devices` — Android devices/emulators and iOS simulators.
import { parseArgs } from 'node:util';
import type { Platform } from '../../core/types.ts';
import { listDevices } from '../../drivers/devices.ts';

const USAGE = `사용법: qa devices [--platform android|ios] [--all] [--json]
  기본은 부팅된 디바이스만 표시합니다. --all이면 꺼진 시뮬레이터도 표시합니다.
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
  if (values.platform !== undefined && values.platform !== 'android' && values.platform !== 'ios') {
    console.error(`--platform은 android 또는 ios여야 합니다.\n${USAGE}`);
    return 2;
  }
  let devices;
  try {
    devices = await listDevices(values.platform as Platform | undefined);
  } catch (err) {
    console.error(`디바이스 목록을 가져오지 못했습니다: ${(err as Error).message}`);
    return 1;
  }
  if (!values.all) devices = devices.filter((d) => d.state !== 'shutdown');
  if (values.json) {
    console.log(JSON.stringify(devices, null, 2));
    return 0;
  }
  if (devices.length === 0) {
    console.log('디바이스가 없습니다. 에뮬레이터 또는 시뮬레이터를 부팅하세요.');
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
