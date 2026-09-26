// `qa report <runId|latest>` — regenerate report.html (and junit.xml if the run had one) from summary.json.
import { parseArgs } from 'node:util';
import { latestRunId, regenerateReport } from '../../report/index.ts';

const USAGE = `사용법: qa report <실행ID|latest>
  저장된 summary.json으로 report.html을 다시 만듭니다 (계획·문서 변경이 추적 매트릭스에 반영됨).
종료 코드: 0 = 성공, 2 = 사용법 오류·실행 기록 없음`;

export async function cmdReport(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { help: { type: 'boolean', short: 'h' } } });
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const [arg] = parsed.positionals;
  if (!arg || parsed.positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const runId = arg === 'latest' ? latestRunId() : arg;
  if (!runId) {
    console.error('실행 기록이 없습니다.');
    return 2;
  }
  try {
    const { reportPath, junitPath } = regenerateReport(runId);
    console.log(`리포트: ${reportPath}`);
    if (junitPath) console.log(`JUnit: ${junitPath}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}
