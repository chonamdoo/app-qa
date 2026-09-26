// `qa inspect --app <id> --platform <platform> [--device <id>] [--json]`
import { parseArgs } from 'node:util';
import { inspectScreen } from '../../runner/index.ts';
import { parsePlatform, PLATFORM_LIST } from '../platforms.ts';

const USAGE = `사용법: qa inspect --app <id> --platform ${PLATFORM_LIST} [--device <id>] [--json]
  현재 화면(앱을 실행하지 않음, 웹 프로필은 시작 URL을 엶)의 후보 표: 역할·이름·상태·영역·위험·fast path 유일성·탭 지점
종료 코드: 0 = 성공, 2 = 사용법·환경 오류`;

export async function cmdInspect(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: { app: { type: 'string' }, platform: { type: 'string' }, device: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
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
  if (!values.app || !platform) {
    console.error(USAGE);
    return 2;
  }
  try {
    const { table, model } = await inspectScreen({ app: values.app, platform, deviceId: values.device });
    console.log(values.json ? JSON.stringify({ candidates: model.candidates, texts: model.texts, occluded: model.occludedNodeIds.length }, null, 2) : table);
    return 0;
  } catch (err) {
    console.error(`화면을 조사할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
