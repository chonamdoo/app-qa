// `qa capture --app <id> --platform <platform> --name <name> [--device <id>]`
import { parseArgs } from 'node:util';
import { CliJobCancelled, runEngineJob } from '../engine.ts';
import { parsePlatform, PLATFORM_LIST } from '../platforms.ts';
import { relative } from 'node:path';
import { connectEngineClient } from '../../core/agent-client.ts';
import { PATHS } from '../../core/config.ts';
import type { JobOutput } from '../../server/jobs.ts';

const USAGE = `사용법: qa capture --app <id> --platform ${PLATFORM_LIST} --name <이름> [--device <id>]
  현재 화면을 fixtures/<platform>/<app>/<이름>.{xml,png,meta.json} 과
  .qa/inventory/<app>/<platform>/<이름>.json (qa plan이 실제 화면 문구로 쓰는 인벤토리)로 저장합니다.
  이 프로젝트의 qa serve가 실행 중이어야 합니다. 데스크톱은 엔진 소유 guest에서만 실행합니다.
종료 코드: 0 = 성공, 2 = 사용법·환경 오류, 130 = 취소`;

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
  if (!values.app || !platform || !values.name || !/^[\w.-]+$/.test(values.name)) {
    console.error(USAGE);
    return 2;
  }
  try {
    const client = await connectEngineClient();
    const job = await runEngineJob({ kind: 'capture', params: { app: values.app, platform, deviceId: values.device, name: values.name } }, { client });
    if (job.state !== 'succeeded') {
      console.error(job.message ?? '화면 캡처 작업이 실패했습니다.');
      return 2;
    }
    const output = await client.request<JobOutput>(`/api/jobs/${encodeURIComponent(job.id)}/output`);
    if (output.kind !== 'capture') throw new Error('이 작업의 실제 캡처 파일을 확인할 수 없습니다.');
    for (const file of [output.files.xml, output.files.png, output.files.meta, output.files.inventory]) console.log(`저장: ${relative(PATHS.root, file)}`);
    return 0;
  } catch (err) {
    console.error(`화면을 캡처할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof CliJobCancelled ? 130 : 2;
  }
}
