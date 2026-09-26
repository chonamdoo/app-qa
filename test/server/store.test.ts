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
    const view = await readPlanView({ root, generatedDir: generated, runsDir, appsDir: join(root, 'apps'), app: 'demo' });
    assert.ok(view !== null && !('error' in view), JSON.stringify(view));
    assert.deepEqual(view.tests[0]?.results, [{ platform: 'android', verdict: 'PASS', runId: 'run-b', ts: '2026-09-26T02:00:00.000Z' }]);
    assert.equal(view.invalidEventLines, 2);
  });

  test('runs on desktop browsers are read like device runs, not dropped as malformed', async () => {
    const runsDir = join(root, 'runs-web');
    mkdirSync(join(runsDir, 'run-w'), { recursive: true });
    writeFileSync(
      join(runsDir, 'run-w', 'events.jsonl'),
      jsonl(
        {
          seq: 1,
          ts: '2026-09-26T03:00:00.000Z',
          type: 'run.started',
          runId: 'run-w',
          runDir: 'x',
          tests: [{ id: 'search', name: '검색', platforms: ['desktop-chrome', 'desktop-safari'], steps: [] }],
          devices: [{ platform: 'desktop-chrome', id: 'desktop-chrome', name: 'Chrome 153' }],
        },
        { seq: 2, ts: '2026-09-26T03:00:05.000Z', type: 'run.finished', runId: 'run-w', counts: { PASS: 1, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 }, reportPath: 'r.html', junitPath: null },
      ),
    );
    const [run] = await listRuns(runsDir);
    assert.equal(run?.invalidEventLines, 0);
    assert.equal(run?.finished, true);
    assert.deepEqual(run?.tests[0]?.platforms, ['desktop-chrome', 'desktop-safari']);
    assert.deepEqual(run?.devices, [{ platform: 'desktop-chrome', id: 'desktop-chrome', name: 'Chrome 153' }]);
  });

  test('plan view: a test without platforms runs on its web profile platforms and shows their results', async () => {
    const base = join(root, 'plan-web');
    const generated = join(base, 'generated');
    const runsDir = join(base, 'runs');
    const apps = join(base, 'apps');
    for (const dir of [join(generated, 'shop'), join(base, 'tests'), join(runsDir, 'run-c'), apps]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(apps, 'shop.yaml'), JSON.stringify({ id: 'shop', name: '상점', web: { url: 'http://localhost:4173/', platforms: ['desktop-safari', 'ios'] } }));
    writeFileSync(join(base, 'tests', 'search.e2e.yaml'), JSON.stringify({ id: 'search', name: '검색', app: 'shop', steps: [{ back: true }] }));
    writeFileSync(
      join(generated, 'shop', 'plan.json'),
      JSON.stringify({
        version: 1,
        app: 'shop',
        createdAt: '2026-09-26T00:00:00.000Z',
        llm: { provider: 'claude-cli', model: null },
        docs: [],
        requirements: [],
        tests: [{ file: 'tests/search.e2e.yaml', covers: [], status: 'draft', review: { addressesRequirement: null, unrelatedSteps: null, needsClarification: null, issues: [] } }],
        untestable: [],
      }),
    );
    const finished = { type: 'test.finished', runId: 'run-c', testId: 'search', reason: '', durationMs: 1 };
    writeFileSync(
      join(runsDir, 'run-c', 'events.jsonl'),
      jsonl({ ...finished, seq: 1, ts: '2026-09-26T04:00:00.000Z', verdict: 'PASS', platform: 'desktop-safari' }, { ...finished, seq: 2, ts: '2026-09-26T04:00:01.000Z', verdict: 'FAIL', platform: 'android' }),
    );
    const view = await readPlanView({ root: base, generatedDir: generated, runsDir, appsDir: apps, app: 'shop' });
    assert.ok(view !== null && !('error' in view), JSON.stringify(view));
    assert.deepEqual(view.tests[0]?.platforms, ['ios', 'desktop-safari']);
    assert.deepEqual(view.tests[0]?.results, [{ platform: 'desktop-safari', verdict: 'PASS', runId: 'run-c', ts: '2026-09-26T04:00:00.000Z' }]);
  });

  test('plan view step labels never carry typed text, nested steps included', async () => {
    const base = join(root, 'plan-typed');
    const generated = join(base, 'generated');
    for (const dir of [join(generated, 'bank'), join(base, 'tests')]) mkdirSync(dir, { recursive: true });
    const spec = {
      id: 'login',
      name: '로그인',
      app: 'bank',
      platforms: ['android'],
      steps: [
        { type: 'top-secret-1', into: '아이디' },
        { repeat: { times: 2, steps: [{ type: 'private-value', into: '비밀번호' }] } },
        { which: { 로그인: [{ type: 'branch-secret', into: '비밀번호' }], 홈: [{ back: true }] } },
        { type: '${PIN}', into: 'PIN', submit: true },
        { scroll: { direction: 'down', until: '약관' } },
      ],
    };
    writeFileSync(join(base, 'tests', 'login.e2e.yaml'), JSON.stringify(spec));
    writeFileSync(
      join(generated, 'bank', 'plan.json'),
      JSON.stringify({
        version: 1,
        app: 'bank',
        createdAt: '2026-09-26T00:00:00.000Z',
        llm: { provider: 'claude-cli', model: null },
        docs: [],
        requirements: [],
        tests: [{ file: 'tests/login.e2e.yaml', covers: [], status: 'draft', review: { addressesRequirement: null, unrelatedSteps: null, needsClarification: null, issues: [] } }],
        untestable: [],
      }),
    );
    const view = await readPlanView({ root: base, generatedDir: generated, runsDir: join(base, 'runs'), appsDir: join(base, 'apps'), app: 'bank' });
    assert.ok(view !== null && !('error' in view), JSON.stringify(view));
    const shown = JSON.stringify(view);
    for (const typed of ['top-secret-1', 'private-value', 'branch-secret']) assert.ok(!shown.includes(typed), `${typed} in ${shown}`);
    assert.deepEqual(view.tests[0]?.steps, ['입력(12자) → 아이디', '반복: 2회', '분기: 로그인 | 홈', '입력(변수) → PIN', '스크롤: down → 약관']);
  });
});
