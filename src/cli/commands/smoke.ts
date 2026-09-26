// `qa smoke --app <id> --platform android|ios|all [--device <id>] [--crawl tabs]`
import { parseArgs } from 'node:util';
import type { Platform, Verdict } from '../../core/types.ts';
import { consoleSink, exitCodeFor, formatCounts } from '../../report/console.ts';
import { runSmoke } from '../../runner/index.ts';
import { parseDevices } from './run.ts';

const USAGE = `사용법: qa smoke --app <id> [--platform android|ios|all] [--device <id>] [--crawl tabs]
  기본: 앱 실행 → 안정화 → 상태 점검(크래시·RedBox·LogBox·빈 화면) → 스크린샷·인벤토리 (관찰만)
  --crawl tabs: 역할로 식별된 탭바 항목만 순회(위험 항목 제외) 후 첫 탭으로 복귀
  Jev 판단은 참고용 열로만 기록되며 판정에 쓰이지 않습니다.
종료 코드: 0 = 통과, 1 = 실패·판정 불가·오류, 2 = 사용법·환경 오류`;

const PLATFORMS: Record<string, Platform[]> = { android: ['android'], ios: ['ios'], all: ['android', 'ios'] };

export async function cmdSmoke(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        app: { type: 'string' },
        platform: { type: 'string', default: 'all' },
        device: { type: 'string', multiple: true, default: [] },
        crawl: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const platforms = PLATFORMS[values.platform];
  if (!values.app || !platforms || (values.crawl !== undefined && values.crawl !== 'tabs')) {
    console.error(USAGE);
    return 2;
  }
  const deviceIds = parseDevices(values.device, values.platform === 'all' ? 'all' : platforms[0]!);
  if (typeof deviceIds === 'string') {
    console.error(deviceIds);
    return 2;
  }
  const total: Record<Verdict, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 };
  try {
    for (const platform of platforms) {
      const r = await runSmoke({ app: values.app, platform, deviceId: deviceIds[platform], crawl: values.crawl === 'tabs' ? 'tabs' : undefined, events: consoleSink() });
      for (const v of Object.keys(total) as Verdict[]) total[v] += r.counts[v];
      console.log(`[${platform}] 리포트: ${r.reportPath}`);
    }
  } catch (err) {
    console.error(`스모크를 실행할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(`결과: ${formatCounts(total)}`);
  return exitCodeFor(total);
}
