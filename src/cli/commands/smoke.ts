// `qa smoke --app <id> --platform <platform>|all [--device <id>] [--crawl tabs]`
import { parseArgs } from 'node:util';
import { PLATFORM_INFO } from '../../core/platform.ts';
import type { Platform, Verdict } from '../../core/types.ts';
import { consoleSink, exitCodeFor, formatCounts, formatQaCounts } from '../../report/console.ts';
import { QA_STATUSES, qaStatus, type QaStatus } from '../../report/status.ts';
import { runSmoke } from '../../runner/index.ts';
import { loadAppProfile } from '../../spec/load.ts';
import { profilePlatforms } from '../../spec/schema.ts';
import { parseDevices, parsePlatform, PLATFORM_CHOICE_LIST } from '../platforms.ts';
import { smokeEach } from '../smoke-each.ts';

const USAGE = `사용법: qa smoke --app <id> [--platform ${PLATFORM_CHOICE_LIST}] [--device <id>] [--crawl tabs]
  기본: 앱(웹 프로필은 시작 URL) 실행 → 안정화 → 상태 점검(크래시·RedBox·LogBox·빈 화면·페이지 오류) → 스크린샷·인벤토리 (관찰만)
  --platform all(기본): 앱 프로필이 가진 플랫폼 전부 (앱: android/ios, 웹: 프로필 web.platforms)
  --crawl tabs: 역할로 식별된 탭바 항목만 순회(위험 항목 제외) 후 첫 탭으로 복귀
  Jev 판단은 참고용 열로만 기록되며 판정에 쓰이지 않습니다.
종료 코드: 0 = 통과, 1 = 실패·판정 불가·오류, 2 = 사용법·환경 오류`;

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
  const choice = parsePlatform(values.platform, true);
  if (typeof choice === 'object') {
    console.error(`${choice.error}\n${USAGE}`);
    return 2;
  }
  if (!values.app || (values.crawl !== undefined && values.crawl !== 'tabs')) {
    console.error(USAGE);
    return 2;
  }
  const deviceIds = parseDevices(values.device, choice);
  if ('error' in deviceIds) {
    console.error(deviceIds.error);
    return 2;
  }
  const total: Record<Verdict, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 };
  const qa = Object.fromEntries(QA_STATUSES.map((s) => [s, 0])) as Record<QaStatus, number>;
  try {
    const app = values.app;
    const profile = loadAppProfile(app);
    const platforms: Platform[] = choice === 'all' ? profilePlatforms(profile) : [choice];
    const each = smokeEach(platforms, (platform) =>
      runSmoke({ app, platform, deviceId: deviceIds[platform], crawl: values.crawl === 'tabs' ? 'tabs' : undefined, events: consoleSink() }),
    );
    for await (const { platform, result: r, notRun } of each) {
      const label = profile.web ? PLATFORM_INFO[platform].webLabel : PLATFORM_INFO[platform].label;
      if (r === null) {
        total.ERROR++;
        qa[qaStatus({ verdict: 'ERROR', code: 'display_unknown' })]++;
        console.log(`[${label}] ERROR: ${notRun}`);
        continue;
      }
      for (const v of Object.keys(total) as Verdict[]) total[v] += r.counts[v];
      for (const s of QA_STATUSES) qa[s] += r.qaCounts[s];
      console.log(`[${label}] 리포트: ${r.reportPath}`);
    }
  } catch (err) {
    console.error(`스모크를 실행할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  console.log(`결과: ${formatCounts(total)}`);
  console.log(`QA 상태: ${formatQaCounts(qa)}`);
  return exitCodeFor(total);
}
