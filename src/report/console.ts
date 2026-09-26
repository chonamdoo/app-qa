// Terminal rendering of run events and results for the CLI (Korean, one line per step).
import type { EventSink, QaEventBody } from '../core/events.ts';
import type { Verdict } from '../core/types.ts';

const MARK: Record<Verdict, string> = { PASS: '✓', FAIL: '✗', INCONCLUSIVE: '?', ERROR: '!', SKIPPED: '-' };

/** Prints test/step progress; decisions, actions and logs at warn level and above only. */
export function consoleSink(print: (line: string) => void = (l) => console.log(l)): EventSink {
  const labels = new Map<string, string>();
  return {
    emit(e: QaEventBody) {
      switch (e.type) {
        case 'run.started':
          print(`실행 ${e.runId} — 테스트 ${e.tests.length}개, 기기 ${e.devices.map((d) => `${d.platform}:${d.name}`).join(', ') || '없음'}`);
          break;
        case 'test.started':
          print(`\n▶ ${e.name} [${e.platform}]`);
          break;
        case 'step.started':
          labels.set(`${e.testId} ${e.platform}`, e.label);
          break;
        case 'step.finished':
          print(`  ${MARK[e.verdict]} ${labels.get(`${e.testId} ${e.platform}`) ?? `#${e.index + 1}`} — ${e.reason}`);
          break;
        case 'test.finished':
          print(`■ ${e.testId} [${e.platform}] ${e.verdict} (${(e.durationMs / 1000).toFixed(1)}초) ${e.verdict === 'PASS' ? '' : e.reason.split('\n')[0]}`);
          break;
        case 'log':
          if (e.level !== 'info') print(`  [${e.level === 'warn' ? '경고' : '오류'}] ${e.message}`);
          break;
        default:
          break;
      }
    },
  };
}

export function formatCounts(counts: Record<Verdict, number>): string {
  return (Object.keys(MARK) as Verdict[])
    .filter((v) => counts[v] > 0)
    .map((v) => `${v} ${counts[v]}`)
    .join(' · ');
}

/** 0 only when something ran and nothing failed, errored or stayed inconclusive (fail-closed). */
export function exitCodeFor(counts: Record<Verdict, number>): number {
  const executed = counts.PASS + counts.FAIL + counts.INCONCLUSIVE + counts.ERROR;
  return executed > 0 && counts.FAIL + counts.ERROR + counts.INCONCLUSIVE === 0 ? 0 : 1;
}
