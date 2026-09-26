// `qa calibrate` — measures Jev gates on the golden sets and writes calibration/<model>/<questionVersion>.json.
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from '../../core/config.ts';
import { runCalibration, type CalibrationReport } from '../../jev/calibrate.ts';
import { JevClient } from '../../jev/client.ts';
import { JevError, loadJevConfig, type JevMode } from '../../jev/config.ts';

const USAGE = `사용법: qa calibrate [옵션]
  --golden <dir>       골든셋 디렉터리 (기본: calibration/golden)
  --mode <m>           live | record | replay (기본: QA_JEV_MODE 또는 live)
  --recordings <dir>   record/replay 응답 디렉터리 (기본: .qa/jev/recordings)
  --reuse              녹화에 있는 요청은 다시 묻지 않고 재사용 (골든셋을 늘릴 때)
  --out <file>         결과 파일 (기본: calibration/<model>/q-v1.json)
  --concurrency <n>    동시 호출 수 (기본: 4)
종료 코드: 0 = 전체 통과, 1 = 사전등록 기준 미달(레코드에 failed로 기록), 2 = 오류`;

export async function cmdCalibrate(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        golden: { type: 'string' },
        mode: { type: 'string' },
        recordings: { type: 'string' },
        reuse: { type: 'boolean' },
        out: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    console.error('--concurrency는 1..16 정수여야 합니다');
    return 2;
  }
  try {
    const config = loadJevConfig(process.env, { mode: values.mode as JevMode | undefined, recordingsDir: values.recordings });
    const reuse = values.reuse ? new JevClient(loadJevConfig(process.env, { mode: 'replay', recordingsDir: config.recordingsDir })) : undefined;
    const report = await runCalibration({
      client: new JevClient(config),
      reuse,
      goldenDir: values.golden,
      out: values.out,
      concurrency,
      log: (line) => console.log(line),
    });
    console.log(renderReport(report));
    return report.calibration.status === 'calibrated' ? 0 : 1;
  } catch (err) {
    console.error(err instanceof JevError ? `Jev 오류 (${err.kind}): ${err.message}` : `캘리브레이션 실패: ${(err as Error).message}`);
    return 2;
  }
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function renderReport(r: CalibrationReport): string {
  const c = r.calibration;
  const { grounding, claim, which, commit, review } = r.reports;
  const g = c.grounding.gate;
  const rg = c.review.gate;
  const row = (name: string, n: number, metric: string, cw: number, status: string, gate: string) =>
    `${name.padEnd(10)} ${String(n).padStart(4)}  ${metric.padEnd(22)} ${String(cw).padStart(4)}   ${status.padEnd(10)}  ${gate}`;
  const lines = [
    '',
    `Jev 캘리브레이션 ${c.model} / ${c.questionVersion}`,
    'primitive   건수  지표                   확신오답  상태        임계값',
    row('grounding', grounding.n, `수용 ${pct(grounding.acceptance)}`, grounding.confidentWrong, grounding.status, `minTop ${g.minTop} · minGap ${g.minGap} · maxNone ${g.maxNone} · noneMin ${g.noneMin} · rescueGap ${g.rescueGap ?? '없음'}`),
    row('claim', claim.n, `수용 ${pct(claim.acceptance)}`, claim.confidentWrong, claim.status, `yes ≥ ${c.claim.gate.yes} · no ≤ ${c.claim.gate.no}`),
    row('which', which.n, `수용 ${pct(which.acceptance)}`, which.confidentWrong, which.status, `minTop ${c.which.gate.minTop} · minGap ${c.which.gate.minGap} · noneMin ${c.which.gate.noneMin}`),
    row('commit', commit.n, `오경보 ${commit.falseAlarms}/${commit.safe} (${pct(commit.falseAlarmRate)})`, commit.confidentWrong, commit.status, `risky ≥ ${c.commit.gate.risky}`),
    row('review', review.n, `good 승인 ${review.goodApproved}/${review.good} (${pct(review.goodApproval)})`, review.confidentWrong, review.status, `addresses ≥ ${rg.addressesMin} · unrelated ≤ ${rg.unrelatedMax} · clarification ≤ ${rg.clarificationMax}`),
    `grounding(비엄격, tap/type): 수용률 ${pct(r.groundingNonStrict.acceptance)}, 확신 오답 ${r.groundingNonStrict.confidentWrong}`,
    `commit: 잔여 위험 ${commit.risky} · 잔여 안전 ${commit.safe} · 결정적 정책이 이미 막아 제외 ${commit.covered.length}건${commit.covered.length ? ` (${commit.covered.map((x) => x.id).join(', ')})` : ''}`,
    '언어별 (수용/건수, 확신 오답):',
  ];
  for (const [name, rep] of Object.entries(r.reports)) {
    const { ko, en } = rep.byLang;
    lines.push(`  ${name.padEnd(10)} 한국어 ${ko.accepted}/${ko.n} (${ko.confidentWrong})   영어 ${en.accepted}/${en.n} (${en.confidentWrong})`);
  }
  lines.push(`호출 ${r.calls}회 (녹화 재사용 ${r.reused}) · 입력 토큰 ${r.inputTokens} · 지연 p50 ${r.latencyMs.p50}ms / p95 ${r.latencyMs.p95}ms`);
  lines.push(`기록: ${relative(PATHS.root, r.file)} (전체 상태: ${c.status})`);
  return lines.join('\n');
}
