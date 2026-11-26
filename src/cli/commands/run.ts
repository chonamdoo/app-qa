// `qa run [paths...] --platform <platform>|all --device <platform>:<id> --tag <t> --junit`
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { connectEngineClient } from '../../core/agent-client.ts';
import { exitCodeFor } from '../../report/console.ts';
import { CliJobCancelled, printRunSummary, readJobRunSummary, runEngineJob } from '../engine.ts';
import { parseDevices, parsePlatform, PLATFORM_CHOICE_LIST } from '../platforms.ts';

const USAGE = `사용법: qa run [경로...] [--platform ${PLATFORM_CHOICE_LIST}] [--device <id>] [--tag <태그>] [--junit]
  경로: *.e2e.yaml 파일 또는 디렉터리 (기본 tests/)
  --platform all: 각 테스트의 앱 프로필이 가진 플랫폼 전부 (앱: android/ios, 웹: 프로필 web.platforms)
  --device: 한 플랫폼이면 기기 ID, 여러 플랫폼이면 <플랫폼>:<id> (예: android:emulator-5554, 반복 가능)
  --tag: 해당 태그가 있는 테스트만 (반복 가능)
  --junit: junit.xml도 생성
  이 프로젝트의 qa serve가 실행 중이어야 합니다. 데스크톱은 엔진 소유 guest에서만 실행합니다.
종료 코드: 0 = 모두 통과, 1 = 실패·판정 불가·오류 있음, 2 = 사용법·환경 오류, 130 = 취소`;

export async function cmdRun(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        platform: { type: 'string', default: 'all' },
        device: { type: 'string', multiple: true, default: [] },
        tag: { type: 'string', multiple: true, default: [] },
        junit: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const platform = parsePlatform(values.platform, true);
  if (typeof platform === 'object') {
    console.error(`${platform.error}\n${USAGE}`);
    return 2;
  }
  const deviceIds = parseDevices(values.device, platform);
  if ('error' in deviceIds) {
    console.error(deviceIds.error);
    return 2;
  }
  try {
    const client = await connectEngineClient();
    const job = await runEngineJob({ kind: 'run', params: { paths: positionals, platform, deviceIds, tags: values.tag.length ? values.tag : undefined, junit: values.junit } }, { client });
    const summary = await readJobRunSummary(client, job);
    if (!summary) {
      console.error(job.message ?? '엔진이 실행 요약을 남기지 않았습니다.');
      return job.state === 'failed' ? 2 : 1;
    }
    printRunSummary(job, summary);
    if (summary.junitPath && job.resultPath) console.log(`JUnit: ${join(dirname(job.resultPath), summary.junitPath)}`);
    return exitCodeFor(summary.counts);
  } catch (err) {
    console.error(`실행할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof CliJobCancelled ? 130 : 2;
  }
}
