import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Verdict } from '../../src/core/types.ts';
import { qaStatus } from '../../src/report/status.ts';

describe('qaStatus', () => {
  it('maps verdict + code to the web-qa vocabulary, never to PASS unless the verdict is PASS', () => {
    const cases: [Verdict, string | null, string][] = [
      ['PASS', null, 'PASS'],
      ['FAIL', 'not_found', 'FAIL'],
      ['FAIL', 'origin_mismatch', 'FAIL'],
      ['INCONCLUSIVE', 'no_effect', 'INCONCLUSIVE'],
      ['ERROR', 'no_device', 'BLOCKED'],
      ['ERROR', 'session_failed', 'BLOCKED'],
      ['ERROR', 'page_not_ready', 'BLOCKED'],
      ['ERROR', 'blocked_by_policy', 'BLOCKED'],
      ['ERROR', 'commit_check_unavailable', 'BLOCKED'],
      ['ERROR', 'uncertain_action', 'BLOCKED'],
      ['ERROR', 'internal', 'BLOCKED'],
      ['ERROR', 'spec_invalid', 'NOT_RUN'],
      ['ERROR', 'cancelled', 'NOT_RUN'],
      ['SKIPPED', 'cancelled', 'NOT_RUN'],
      ['SKIPPED', null, 'SKIPPED'],
      // A code only reclassifies results that were not judged.
      ['FAIL', 'cancelled', 'FAIL'],
    ];
    for (const [verdict, code, want] of cases) assert.equal(qaStatus({ verdict, code }), want, `${verdict} ${code}`);
  });
});
