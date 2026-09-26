// `qa capture --app <id> --platform <platform> --name <name> [--device <id>]`
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from '../../core/config.ts';
import { captureScreen } from '../../runner/index.ts';
import { parsePlatform, PLATFORM_LIST } from '../platforms.ts';

const USAGE = `사용법: qa capture --app <id> --platform ${PLATFORM_LIST} --name <이름> [--device <id>]
  현재 화면을 fixtures/<platform>/<app>/<이름>.{xml,png,meta.json} 과
  .qa/inventory/<app>/<platform>/<이름>.json (qa plan이 실제 화면 문구로 쓰는 인벤토리)로 저장합니다.
종료 코드: 0 = 성공, 2 = 사용법·환경 오류`;

export async function cmdCapture(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: { app: { type: 'string' }, platform: { type: 'string' }, name: { type: 'string' }, device: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
  if (!values.app || !platform || !values.name) {
    console.error(USAGE);
    return 2;
  }
  try {
    const r = await captureScreen({ app: values.app, platform, deviceId: values.device, name: values.name });
    for (const f of [r.xml, r.png, r.meta, r.inventory]) console.log(`저장: ${relative(PATHS.root, f)}`);
    return 0;
  } catch (err) {
    console.error(`화면을 캡처할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
