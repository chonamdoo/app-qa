import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  test('a schema-invalid completion makes the journal unusable while retaining validated run metadata', async () => {
    const runsDir = join(root, 'runs-list');
    mkdirSync(join(runsDir, 'run-a'), { recursive: true });
    writeFileSync(
      join(runsDir, 'run-a', 'events.jsonl'),
      jsonl(
        { seq: 1, ts: '2026-09-26T01:00:00.000Z', type: 'run.started', runId: 'run-a', runDir: 'x', tests: [{ id: 't1', name: '로그인', platforms: ['android'], steps: ['탭'] }], devices: [] },
        { seq: 2, ts: '2026-09-26T01:00:01.000Z', type: 'log', level: 'info', source: 'x', message: 'waiting for "run.finished"' },
        { seq: 3, ts: '2026-09-26T01:00:02.000Z', type: 'run.finished', runId: 'run-a', counts: { PASS: 1, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 }, reportPath: 'r.html' },
        { seq: 4, ts: '2026-09-26T01:00:03.000Z', type: 'run.finished', runId: 'run-a' },
      ),
    );
    const [run] = await listRuns(runsDir);
    assert.equal(run?.finished, false);
    assert.equal(run?.counts, null);
    assert.equal(run?.startedAt, '2026-09-26T01:00:00.000Z');
    assert.deepEqual(run?.tests, [{ id: 't1', name: '로그인', platforms: ['android'] }]);
    assert.equal(run?.invalidEventLines, 1);
    assert.equal(run?.eventJournal.state, 'corrupt');
    assert.equal(run?.eventJournal.code, 'ERR_EVENT_JOURNAL_SCHEMA');
    assert.equal(run?.reportPath, null);
  });

  test('torn, invalid and blank journal records cannot turn a completed prefix into a finished run', async () => {
    const start = { seq: 1, ts: '2026-09-26T01:00:00.000Z', type: 'run.started', tests: [], devices: [] };
    const finish = { seq: 2, ts: '2026-09-26T01:00:01.000Z', type: 'run.finished', counts: { PASS: 1, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 }, reportPath: 'report.html' };
    const prefix = jsonl(start, finish);
    const cases = [
      { bytes: Buffer.from(jsonl(start) + JSON.stringify(finish)), state: 'incomplete', code: 'ERR_FSX_TORN_JSONL' },
      { bytes: Buffer.from(prefix + '{"seq":3'), state: 'incomplete', code: 'ERR_FSX_TORN_JSONL' },
      { bytes: Buffer.from(prefix + '{broken}\n'), state: 'corrupt', code: 'ERR_FSX_INVALID_JSONL' },
      { bytes: Buffer.from(prefix + '\n'), state: 'corrupt', code: 'ERR_FSX_INVALID_JSONL' },
      { bytes: Buffer.concat([Buffer.from(prefix), Buffer.from([34, 0xff, 34, 10])]), state: 'corrupt', code: 'ERR_FSX_INVALID_JSONL' },
    ];
    for (const [index, entry] of cases.entries()) {
      const runsDir = join(root, `runs-broken-${index}`);
      const directory = join(runsDir, 'run-a');
      mkdirSync(directory, { recursive: true });
      const journal = join(directory, 'events.jsonl');
      writeFileSync(journal, entry.bytes);
      writeFileSync(join(directory, 'report.html'), '<p>historical report</p>');
      const [run] = await listRuns(runsDir);
      assert.equal(run?.eventJournal.state, entry.state);
      assert.equal(run?.eventJournal.code, entry.code);
      assert.ok(run?.eventJournal.error);
      assert.equal(run?.invalidEventLines, 1);
      assert.equal(run?.finished, false);
      assert.equal(run?.counts, null);
      assert.equal(run?.reportPath, null);
      assert.deepEqual(run?.tests, []);
      assert.deepEqual(readFileSync(journal), entry.bytes);
    }
  });

  test('missing and unsafe event journals remain separate read-only rows', async () => {
    const runsDir = join(root, 'runs-unreadable');
    for (const id of ['missing', 'linked', 'dangling']) mkdirSync(join(runsDir, id), { recursive: true });
    const external = join(root, 'external-events.jsonl');
    const bytes = jsonl({ seq: 1, ts: '2026-09-26T01:00:00.000Z', type: 'run.finished', counts: { PASS: 1, FAIL: 0, INCONCLUSIVE: 0, ERROR: 0, SKIPPED: 0 }, reportPath: 'external.html' });
    writeFileSync(external, bytes);
    const linked = join(runsDir, 'linked', 'events.jsonl');
    const dangling = join(runsDir, 'dangling', 'events.jsonl');
    symlinkSync(external, linked);
    symlinkSync(join(root, 'absent-events.jsonl'), dangling);
    const runs = await listRuns(runsDir);
    const missing = runs.find(run => run.runId === 'missing');
    assert.equal(missing?.hasEvents, false);
    assert.deepEqual(missing?.eventJournal, { state: 'missing', code: null, error: null });
    for (const id of ['linked', 'dangling']) {
      const run = runs.find(run => run.runId === id);
      assert.equal(run?.hasEvents, true);
      assert.equal(run?.eventJournal.state, 'unreadable');
      assert.equal(run?.finished, false);
      assert.equal(run?.counts, null);
    }
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
    assert.equal(readFileSync(external, 'utf8'), bytes);
  });

  test('plan results cannot use PASS records from schema-invalid or torn event journals', async () => {
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
    assert.deepEqual(view.tests[0]?.results, []);
    assert.equal(view.invalidEventLines, 2);
    assert.equal(view.eventJournalErrors[0]?.runId, 'run-b');
    assert.equal(view.eventJournalErrors[0]?.journal.code, 'ERR_EVENT_JOURNAL_SCHEMA');
    const journal = join(runsDir, 'run-b', 'events.jsonl');
    const partial = jsonl({ ...finished, seq: 1, ts: '2026-09-26T02:00:00.000Z', verdict: 'PASS' }) + '{"seq":2';
    writeFileSync(journal, partial);
    const tornView = await readPlanView({ root, generatedDir: generated, runsDir, appsDir: join(root, 'apps'), app: 'demo' });
    assert.ok(tornView !== null && !('error' in tornView), JSON.stringify(tornView));
    assert.deepEqual(tornView.tests[0]?.results, []);
    assert.equal(tornView.eventJournalErrors[0]?.journal.state, 'incomplete');
    assert.equal(readFileSync(journal, 'utf8'), partial);
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
    assert.deepEqual(run?.eventJournal, { state: 'valid', code: null, error: null });
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
    assert.deepEqual(view.eventJournalErrors, []);
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
