// Verdict algebra: a test is the worst of its steps (ERROR > FAIL > INCONCLUSIVE > PASS); SKIPPED never counts
// against a test, and a test whose every step was skipped is SKIPPED (never PASS without evidence).
import type { Verdict } from '../core/types.ts';

const VERDICT_RANK: Record<Verdict, number> = { SKIPPED: 0, PASS: 1, INCONCLUSIVE: 2, FAIL: 3, ERROR: 4 };

export function worstVerdict(verdicts: Iterable<Verdict>): Verdict {
  let worst: Verdict = 'SKIPPED';
  for (const v of verdicts) if (VERDICT_RANK[v] > VERDICT_RANK[worst]) worst = v;
  return worst;
}

export function countVerdicts(verdicts: Iterable<Verdict>): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 };
  for (const v of verdicts) counts[v]++;
  return counts;
}
