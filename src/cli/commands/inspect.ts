// `qa inspect --app <id> --platform <platform> [--device <id>] [--json]`
import { parseArgs } from 'node:util';
import type { JobOutput } from '../../server/jobs.ts';
import { parsePlatform, PLATFORM_LIST } from '../platforms.ts';
import { connectEngineClient } from '../../core/agent-client.ts';
import { CliJobCancelled, runEngineJob } from '../engine.ts';

const USAGE = `사용법: qa inspect --app <id> --platform ${PLATFORM_LIST} [--device <id>] [--json]
  현재 화면(앱을 실행하지 않음, 웹 프로필은 시작 URL을 엶)의 후보 표: 역할·이름·상태·영역·위험·fast path 유일성·탭 지점
  이 프로젝트의 qa serve가 실행 중이어야 합니다. 데스크톱은 엔진 소유 guest에서만 실행합니다.
종료 코드: 0 = 성공, 2 = 사용법·환경 오류, 130 = 취소`;

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
    const client = await connectEngineClient();
    const job = await runEngineJob({ kind: 'inspect', params: { app: values.app, platform, deviceId: values.device } }, { client });
    if (job.state !== 'succeeded') throw new Error(job.message ?? '화면 조회 작업이 실패했습니다.');
    const output = await client.request<JobOutput>(`/api/jobs/${encodeURIComponent(job.id)}/output`);
    if (output.kind !== 'inspect') throw new Error('이 작업의 화면 조회 결과를 확인할 수 없습니다.');
    console.log(values.json ? JSON.stringify({ candidates: output.candidates, texts: output.texts, occluded: output.occluded }, null, 2) : output.table);
    return 0;
  } catch (err) {
    console.error(`화면을 조사할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof CliJobCancelled ? 130 : 2;
  }
}
