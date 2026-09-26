import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { listRuns, readPlanView } from '../../src/server/store.ts';

let root: string;

const jsonl = (...lines: (object | string)[]): string => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-store-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('events.jsonl validation', () => {
  test('run list skips malformed run lines and counts them instead of trusting their shape', async () => {
    const runsDir = join(root, 'runs-list');
    mkdirSync(join(runsDir, 'run-a'), { recursive: true });
    writeFileSync(
      join(runsDir, 'run-a', 'events.jsonl'),
      jsonl(
        { seq: 1, ts: '2026-09-26T01:00:00.000Z', type: 'run.started', runId: 'run-a', runDir: 'x', tests: [{ id: 't1', name: '로그인', platforms: ['android'], steps: ['탭'] }], devices: [] },
        { seq: 2, ts: '2026-09-26T01:00:01.000Z', type: 'log', level: 'info', source: 'x', message: 'waiting for "run.finished"' },
        { seq: 3, ts: '2026-09-26T01:00:02.000Z', type: 'run.finished', runId: 'run-a' },
        '{"seq":4,"ts":"2026-09-26T01:00:03.000Z","type":"run.finished","runId":"run-a","cou',
      ),
    );
    const [run] = await listRuns(runsDir);
    assert.equal(run?.finished, false);
    assert.equal(run?.counts, null);
    assert.equal(run?.startedAt, '2026-09-26T01:00:00.000Z');
    assert.deepEqual(run?.tests, [{ id: 't1', name: '로그인', platforms: ['android'] }]);
    assert.equal(run?.invalidEventLines, 2);
  });

  test('plan view results ignore test.finished lines with an unknown verdict or platform', async () => {
    const generated = join(root, 'generated');
    const runsDir = join(root, 'runs-plan');
    mkdirSync(join(generated, 'demo'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    mkdirSync(join(runsDir, 'run-b'), { recursive: true });
    writeFileSync(join(root, 'tests', 'login.e2e.yaml'), JSON.stringify({ id: 'login', name: '로그인', app: 'demo', platforms: ['android'], steps: [{ back: true }] }));
    writeFileSync(
      join(generated, 'demo', 'plan.json'),
      JSON.stringify({
        version: 1,
        app: 'demo',
        createdAt: '2026-09-26T00:00:00.000Z',
        llm: { provider: 'claude-cli', model: null },
        docs: [],
        requirements: [],
        tests: [{ file: 'tests/login.e2e.yaml', covers: [], status: 'draft', review: { addressesRequirement: null, unrelatedSteps: null, needsClarification: null, issues: [] } }],
        untestable: [],
      }),
    );
    const finished = { type: 'test.finished', runId: 'run-b', testId: 'login', platform: 'android', reason: '', durationMs: 1 };
    writeFileSync(
      join(runsDir, 'run-b', 'events.jsonl'),
      jsonl(
        { ...finished, seq: 1, ts: '2026-09-26T02:00:00.000Z', verdict: 'PASS' },
        { ...finished, seq: 2, ts: '2026-09-26T02:00:01.000Z', verdict: 'MAYBE' },
        { ...finished, seq: 3, ts: '2026-09-26T02:00:02.000Z', verdict: 'FAIL', platform: 'windows' },
      ),
    );
    const view = await readPlanView({ root, generatedDir: generated, runsDir, app: 'demo' });
    assert.ok(view !== null && !('error' in view), JSON.stringify(view));
    assert.deepEqual(view.tests[0]?.results, [{ platform: 'android', verdict: 'PASS', runId: 'run-b', ts: '2026-09-26T02:00:00.000Z' }]);
    assert.equal(view.invalidEventLines, 2);
  });
});
