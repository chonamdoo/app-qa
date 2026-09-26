// Derived result facts every report shows: the web-qa status of a result (web-qa skill vocabulary, next to the original
// verdict and code, which stay authoritative) and the platform label (the browser for web profiles).
import { PLATFORM_INFO } from '../core/platform.ts';
import type { Platform, Surface, Verdict } from '../core/types.ts';

/**
 * PASS/FAIL as judged; BLOCKED = the test could not be judged (environment, readiness, policy, commit check, uncertain
 * action, Jev, harness); NOT_RUN = never executed (invalid spec, cancelled); INCONCLUSIVE stays itself (never a pass).
 */
export type QaStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'BLOCKED' | 'NOT_RUN' | 'SKIPPED';

/** Display order. */
export const QA_STATUSES: readonly QaStatus[] = ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED', 'NOT_RUN', 'SKIPPED'];

const BY_VERDICT: Record<Verdict, QaStatus> = { PASS: 'PASS', FAIL: 'FAIL', INCONCLUSIVE: 'INCONCLUSIVE', ERROR: 'BLOCKED', SKIPPED: 'SKIPPED' };

/** Codes of results that never executed; any other ERROR is BLOCKED with its original code kept on the result. */
const NOT_RUN_CODES: Record<string, true> = { spec_invalid: true, cancelled: true };

export function qaStatus(result: { verdict: Verdict; code: string | null }): QaStatus {
  const unrun = result.verdict === 'ERROR' || result.verdict === 'SKIPPED';
  return unrun && result.code !== null && Object.hasOwn(NOT_RUN_CODES, result.code) ? 'NOT_RUN' : BY_VERDICT[result.verdict];
}

export function countQaStatuses(statuses: Iterable<QaStatus>): Record<QaStatus, number> {
  const counts: Record<QaStatus, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, BLOCKED: 0, NOT_RUN: 0, SKIPPED: 0 };
  for (const s of statuses) counts[s]++;
  return counts;
}

/** `Android` for an app, `Android Chrome` for a website on the same device. */
export function platformLabel(platform: Platform, surface: Surface): string {
  const info = PLATFORM_INFO[platform];
  return surface === 'web' ? info.webLabel : info.label;
}
