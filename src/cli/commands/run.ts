// `qa run [paths...] --platform android|ios|all --device <id> --tag <t> --junit`
import { parseArgs } from 'node:util';
import type { Platform } from '../../core/types.ts';
import { consoleSink, exitCodeFor, formatCounts } from '../../report/console.ts';
import { runTests } from '../../runner/index.ts';
import { SpecError } from '../../spec/load.ts';

const USAGE = `사용법: qa run [경로...] [--platform android|ios|all] [--device <id>] [--tag <태그>] [--junit]
  경로: *.e2e.yaml 파일 또는 디렉터리 (기본 tests/)
  --device: 한 플랫폼이면 기기 ID, 여러 플랫폼이면 android:<id> / ios:<id> (반복 가능)
  --tag: 해당 태그가 있는 테스트만 (반복 가능)
  --junit: junit.xml도 생성
종료 코드: 0 = 모두 통과, 1 = 실패·판정 불가·오류 있음, 2 = 사용법·환경 오류`;

const PLATFORM_CHOICE: Record<string, Platform | 'all'> = { android: 'android', ios: 'ios', all: 'all' };

/** `--device` values → per-platform ids; null with a message on misuse. */
export function parseDevices(values: readonly string[], platform: Platform | 'all'): Partial<Record<Platform, string>> | string {
  const out: Partial<Record<Platform, string>> = {};
  for (const v of values) {
    const m = /^(android|ios):(.+)$/.exec(v);
    if (m) out[m[1] as Platform] = m[2]!;
    else if (platform === 'all') return `--platform all에서는 --device android:<id> 또는 ios:<id> 형식을 쓰세요: ${v}`;
    else out[platform] = v;
  }
  return out;
}

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
  const platform = PLATFORM_CHOICE[values.platform];
  if (!platform) {
    console.error(`--platform은 android, ios, all 중 하나여야 합니다.\n${USAGE}`);
    return 2;
  }
  const deviceIds = parseDevices(values.device, platform);
  if (typeof deviceIds === 'string') {
    console.error(deviceIds);
    return 2;
  }
  const controller = new AbortController();
  const onSigint = () => {
    console.error('\n취소 중… (진행 중인 스텝이 끝나면 멈춥니다)');
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const result = await runTests({
      paths: positionals,
      platform,
      deviceIds,
      tags: values.tag.length ? values.tag : undefined,
      junit: values.junit,
      events: consoleSink(),
      signal: controller.signal,
    });
    const specErrors = result.tests.filter((t) => t.code === 'spec_invalid');
    for (const t of specErrors) console.error(`\n테스트 파일 오류:\n${t.reason}`);
    console.log(`\n결과: ${formatCounts(result.counts) || '실행된 테스트 없음'}`);
    console.log(`리포트: ${result.reportPath}`);
    if (result.junitPath) console.log(`JUnit: ${result.junitPath}`);
    return exitCodeFor(result.counts);
  } catch (err) {
    console.error(err instanceof SpecError ? `테스트 파일 오류:\n${err.message}` : `실행할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
