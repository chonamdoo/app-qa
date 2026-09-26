import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, test } from 'node:test';
import { PATHS } from '../../src/core/config.ts';
import type { QaEventBody } from '../../src/core/events.ts';
import { createLlm, extractJson, generatePlan, generateTests, ingestDocuments, loadAppContext, segmentRequirements } from '../../src/plan/index.ts';
import { loadAppProfile, loadTestFile } from '../../src/spec/load.ts';
import { PlanFile } from '../../src/spec/schema.ts';
import { fakeLlm, stubJev, TEST_CALIBRATION, tempDir } from './helpers.ts';

const SCENARIO = '# 출국장\n\n출국장 탭에서 대기시간이 분 단위로 보인다.\n\n출국장 탭에 "출국 게이트"라는 말이 보이지 않는다.\n';
const REQ_A = 'inline#출국장';
const REQ_B = 'inline#출국장.2';

const goodTest = { id: 'departures-wait', name: '출국장 탭 대기시간 표시', covers: [REQ_A], steps: [{ tap: '출국장' }, { assertText: { regex: '^\\d+분$' } }] };
const termsTest = { id: 'departures-terms', name: '출국장 탭 금지 용어', covers: [REQ_B], steps: [{ tap: '출국장' }, { assertNoText: '출국 게이트' }] };
const riskyTest = { id: 'delete-flight', name: '내 항공편 지우기', covers: [REQ_B], steps: [{ tap: '내 항공편 지우기' }] };

async function scenario() {
  const context = loadAppContext('tteonam', { apps: PATHS.apps, inventory: tempDir(), fixtures: PATHS.fixtures, envExample: join(tempDir(), 'none') });
  const requirements = segmentRequirements(await ingestDocuments([], { text: SCENARIO }));
  return { context, requirements };
}

describe('LLM adapters (fake CLI)', () => {
  test('claude-cli: prompt on stdin, fenced JSON inside `result` is parsed', async () => {
    const reply = `다음은 결과입니다.\n\`\`\`json\n${JSON.stringify({ tests: [goodTest, termsTest], untestable: [] })}\n\`\`\``;
    const fake = fakeLlm('claude', [reply]);
    const { context, requirements } = await scenario();
    const llm = createLlm({ provider: 'claude-cli', env: fake.env });
    const out = await generateTests({ llm, context, requirements });
    assert.deepEqual(
      out.tests.map((t) => t.spec.id),
      ['departures-wait', 'departures-terms'],
    );
    assert.deepEqual(out.untestable, []);
    const [call] = fake.calls();
    assert.deepEqual(call!.args, ['-p', '--model', 'claude-opus-5-5', '--output-format', 'json', '--tools', '', '--no-session-persistence']);
    assert.match(call!.stdin, /\[inline#출국장\.2\]/);
    assert.match(call!.stdin, /## android\/tab-departures/, 'fixture inventory is in the prompt');
    assert.match(call!.stdin, /"내 항공편 지우기"/);
  });

  test('invalid JSON → one revision with the error → still invalid → requirements untestable', async () => {
    const fake = fakeLlm('claude', ['이건 JSON이 아닙니다', '여전히 아님']);
    const { context, requirements } = await scenario();
    const out = await generateTests({ llm: createLlm({ provider: 'claude-cli', env: fake.env }), context, requirements });
    const calls = fake.calls();
    assert.equal(calls.length, 2, 'exactly one revision round');
    assert.match(calls[1]!.stdin, /# YOUR PREVIOUS OUTPUT\n이건 JSON이 아닙니다/);
    assert.match(calls[1]!.stdin, /# VALIDATION ERRORS[^\n]*\n- 모델 출력에서 JSON 객체를 찾지 못했습니다/);
    assert.deepEqual(out.tests, []);
    assert.deepEqual(
      out.untestable.map((u) => u.requirement),
      [REQ_A, REQ_B],
    );
    assert.match(out.untestable[0]!.reason, /^생성 실패: 모델 출력에서 JSON 객체를 찾지 못했습니다/);
  });

  test('a test still invalid after the revision is dropped with its reason; valid ones are kept', async () => {
    const reply = JSON.stringify({ tests: [goodTest, riskyTest], untestable: [] });
    const fake = fakeLlm('claude', [reply, reply]);
    const { context, requirements } = await scenario();
    const out = await generateTests({ llm: createLlm({ provider: 'claude-cli', env: fake.env }), context, requirements });
    assert.equal(fake.calls().length, 2);
    assert.match(fake.calls()[1]!.stdin, /tests\[1\] \(delete-flight\): steps\[0\]: 위험 동작 대상 "내 항공편 지우기"/);
    assert.deepEqual(
      out.tests.map((t) => t.spec.id),
      ['departures-wait'],
    );
    assert.deepEqual(
      out.dropped.map((d) => d.label),
      ['delete-flight'],
    );
    assert.deepEqual(
      out.untestable.map((u) => u.requirement),
      [REQ_B],
    );
    assert.match(out.untestable[0]!.reason, /^검증 실패로 테스트 폐기 \(delete-flight\): steps\[0\]: 위험 동작 대상/);
  });

  test('a revision that fixes the errors is used; an unparseable revision keeps the first valid tests', async () => {
    const first = JSON.stringify({ tests: [goodTest, riskyTest], untestable: [] });
    const fixed = JSON.stringify({ tests: [goodTest], untestable: [{ requirement: REQ_B, reason: 'needs_approval: 삭제 동작' }] });
    const { context, requirements } = await scenario();
    const ok = await generateTests({ llm: createLlm({ provider: 'claude-cli', env: fakeLlm('claude', [first, fixed]).env }), context, requirements });
    assert.deepEqual(ok.dropped, []);
    assert.deepEqual(ok.untestable, [{ requirement: REQ_B, reason: 'needs_approval: 삭제 동작' }]);
    const garbled = await generateTests({ llm: createLlm({ provider: 'claude-cli', env: fakeLlm('claude', [first, '???']).env }), context, requirements });
    assert.deepEqual(
      garbled.tests.map((t) => t.spec.id),
      ['departures-wait'],
    );
  });

  test('codex-cli: rejected JSON Schema falls back to prompt-only; reply read from -o', async () => {
    const fake = fakeLlm('codex', [JSON.stringify({ tests: [goodTest, termsTest], untestable: [] })], { rejectSchema: true });
    const { context, requirements } = await scenario();
    const llm = createLlm({ provider: 'codex-cli', env: fake.env });
    const out = await generateTests({ llm, context, requirements });
    assert.equal(out.tests.length, 2);
    const calls = fake.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.args.includes('--output-schema'));
    assert.ok(!calls[1]!.args.includes('--output-schema'));
    assert.deepEqual(calls[1]!.args.slice(0, 7), ['exec', '-m', 'gpt-6-sol', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral']);
    assert.equal(calls[1]!.args.at(-1), '-');
    assert.match(calls[1]!.stdin, /\[inline#출국장\]/);
    assert.equal(llm.notes.length, 1);
  });

  test('CLI errors, missing binaries and the time cap are errors (nothing generated)', async () => {
    const { context, requirements } = await scenario();
    const failing = createLlm({ provider: 'claude-cli', env: fakeLlm('claude', ['x'], { claudeError: true }).env });
    await assert.rejects(generateTests({ llm: failing, context, requirements }), /claude CLI 오류 \(error_during_execution\)/);
    const missing = createLlm({ provider: 'claude-cli', env: { ...process.env, QA_CLAUDE_BIN: join(tempDir(), 'no-such-claude') } });
    await assert.rejects(generateTests({ llm: missing, context, requirements }), /LLM CLI를 찾을 수 없습니다/);
    // Real clock on purpose: the cap is an AbortSignal.timeout around a child process (no fake timers across processes).
    const slow = createLlm({ provider: 'claude-cli', env: fakeLlm('claude', ['{}'], { sleepMs: 5000 }).env, timeoutMs: 300 });
    await assert.rejects(generateTests({ llm: slow, context, requirements }), /제한을 넘었습니다/);
    // The CLI is spawned synchronously inside generateTests, so aborting right after the call kills a running child.
    const controller = new AbortController();
    const cancelled = generateTests({ llm: createLlm({ provider: 'claude-cli', env: fakeLlm('claude', ['{}'], { sleepMs: 5000 }).env }), context, requirements, signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, /취소되었습니다/);
  });

  test('the CLI gets a scoped environment: its own auth/config variables, never TYPESAFE_API_KEY or app secrets', async () => {
    for (const mode of ['claude', 'codex'] as const) {
      const fake = fakeLlm(mode, [], { printEnv: true });
      const env = { ...fake.env, TYPESAFE_API_KEY: 'test-key-not-real', APP_PASSWORD: 'pw', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', CLAUDE_CONFIG_DIR: '/tmp/c', LC_ALL: 'C' };
      const llm = createLlm({ provider: mode === 'claude' ? 'claude-cli' : 'codex-cli', env });
      const names: string[] = JSON.parse(await llm.complete('prompt', { schema: {} }));
      for (const name of ['PATH', 'HOME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CONFIG_DIR', 'LC_ALL', mode === 'claude' ? 'QA_CLAUDE_BIN' : 'QA_CODEX_BIN']) {
        assert.ok(names.includes(name), `${mode}: ${name} passed`);
      }
      assert.ok(!names.includes('TYPESAFE_API_KEY') && !names.includes('APP_PASSWORD'), `${mode}: ${names.join(',')}`);
    }
  });

  test('output over the 8 MiB cap kills the CLI and fails', async () => {
    const llm = createLlm({ provider: 'claude-cli', env: fakeLlm('claude', ['{}'], { floodBytes: 9 * 1024 * 1024 }).env });
    await assert.rejects(llm.complete('prompt', { schema: {} }), /stdout 출력이 8 MiB 제한을 넘어 중단했습니다/);
    const small = createLlm({ provider: 'claude-cli', env: fakeLlm('claude', ['{}'], { floodBytes: 1024 * 1024 }).env });
    await assert.rejects(small.complete('prompt', { schema: {} }), /claude CLI 출력이 JSON이 아닙니다/, 'under the cap the output is parsed as usual');
  });

  test('extractJson accepts bare JSON, fenced blocks and surrounding prose', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('앞말\n```\n{"a":2}\n```\n뒷말'), { a: 2 });
    assert.deepEqual(extractJson('결과: {"a":{"b":3}} 끝'), { a: { b: 3 } });
    assert.throws(() => extractJson('{"a":'), /JSON 객체를 찾지 못했습니다/);
  });
});

describe('generatePlan', () => {
  type RunOptions = { root: string; text: string; docs?: string[]; replies: string[]; approve?: boolean; jev?: Parameters<typeof generatePlan>[0]['jev']; signal?: AbortSignal; onEvent?: (e: QaEventBody) => void };
  async function run(opts: RunOptions) {
    const fake = fakeLlm('claude', opts.replies);
    const events: QaEventBody[] = [];
    const result = await generatePlan({
      app: 'tteonam',
      docs: opts.docs ?? [],
      text: opts.text,
      llm: 'claude-cli',
      approve: opts.approve,
      events: {
        emit: (e) => {
          events.push(e);
          opts.onEvent?.(e);
        },
      },
      env: fake.env,
      root: opts.root,
      contextDirs: { inventory: tempDir(), envExample: join(tempDir(), 'none') },
      jev: opts.jev ?? { client: null, calibration: null, reason: 'jev_unavailable: test' },
      signal: opts.signal,
    });
    return { result, events };
  }

  /** Every file and directory under `dir` (relative path → bytes; directories → null). */
  function snapshot(dir: string): Map<string, Buffer | null> {
    const out = new Map<string, Buffer | null>();
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      const abs = join(entry.parentPath, entry.name);
      out.set(relative(dir, abs), entry.isDirectory() ? null : readFileSync(abs));
    }
    return out;
  }

  const parkingTest = { id: 'parking-free', name: '주차 빈자리', covers: ['parking#주차'], steps: [{ tap: '주차' }, { assertText: '빈자리' }] };
  /** First generation: inline (2 tests) + parking.md (1 test). Returns the plan directory and the parking doc. */
  async function firstGeneration(root: string) {
    const doc = join(tempDir(), 'parking.md');
    writeFileSync(doc, '# 주차\n\n주차 탭에 빈자리가 보인다.\n');
    await run({ root, text: SCENARIO, docs: [doc], replies: [JSON.stringify({ tests: [goodTest, termsTest, parkingTest], untestable: [] })] });
    return { planDir: join(root, 'tests', 'generated', 'tteonam'), doc };
  }
  const secondReply = JSON.stringify({
    tests: [{ ...goodTest, name: '출국장 대기시간 (2세대)' }, { ...parkingTest, name: '주차 빈자리 (2세대)' }],
    untestable: [{ requirement: REQ_B, reason: '화면 인벤토리에 없음: 2세대' }],
  });

  test('writes validated YAML + plan.json; Jev gate + --approve promotes; events cover every phase', async () => {
    const root = tempDir();
    const { client, requests } = stubJev({ addresses: 0.95, unrelated: 0.05, clarification: 0.1 });
    const reply = JSON.stringify({ tests: [goodTest], untestable: [{ requirement: REQ_B, reason: '화면 인벤토리에 없음: 테스트' }] });
    const { result, events } = await run({ root, text: SCENARIO, replies: [reply], approve: true, jev: { client, calibration: TEST_CALIBRATION } });

    const file = join(root, 'tests', 'generated', 'tteonam', 'inline', 'departures-wait.e2e.yaml');
    assert.deepEqual(result.testFiles, [file]);
    assert.equal(result.planPath, join(root, 'tests', 'generated', 'tteonam', 'plan.json'));
    const loaded = loadTestFile(file, (app) => loadAppProfile(app));
    assert.deepEqual(loaded.spec.covers, [REQ_A]);
    assert.deepEqual(loaded.spec.source, { plan: 'tests/generated/tteonam/plan.json', status: 'approved' });
    assert.equal(loaded.spec.app, 'tteonam');

    const plan = PlanFile.parse(JSON.parse(readFileSync(result.planPath, 'utf8')));
    assert.deepEqual(plan.docs, [{ path: 'inline.md', sha256: plan.docs[0]!.sha256, kind: 'md' }]);
    assert.deepEqual(
      plan.requirements.map((r) => r.id),
      [REQ_A, REQ_B],
    );
    assert.deepEqual(plan.tests, [
      {
        file: 'tests/generated/tteonam/inline/departures-wait.e2e.yaml',
        covers: [REQ_A],
        status: 'approved',
        review: { addressesRequirement: 0.95, unrelatedSteps: 0.05, needsClarification: 0.1, issues: [] },
      },
    ]);
    assert.deepEqual(plan.untestable, [{ requirement: REQ_B, reason: '화면 인벤토리에 없음: 테스트' }]);
    assert.deepEqual(plan.llm, { provider: 'claude-cli', model: 'claude-opus-5-5' });
    assert.equal(requests.length, 1);

    const phases = events.flatMap((e) => (e.type === 'plan.progress' ? [e.phase] : []));
    assert.deepEqual([...new Set(phases)], ['ingest', 'segment', 'generate', 'validate', 'review', 'write']);
    assert.equal(events[0]!.type, 'plan.started');
    const finished = events.at(-1)!;
    assert.ok(finished.type === 'plan.finished' && finished.ok && finished.tests === 1 && finished.untestable === 1);
  });

  test('without --approve, and whenever Jev is unavailable, tests stay draft with the reason', async () => {
    const reply = JSON.stringify({ tests: [goodTest, termsTest], untestable: [] });
    const { client } = stubJev({ addresses: 0.95, unrelated: 0.05, clarification: 0.1 });
    const draft = await run({ root: tempDir(), text: SCENARIO, replies: [reply], jev: { client, calibration: TEST_CALIBRATION } });
    assert.deepEqual(
      draft.result.plan.tests.map((t) => [t.status, t.review.issues]),
      [
        ['draft', []],
        ['draft', []],
      ],
    );
    const low = await run({ root: tempDir(), text: SCENARIO, replies: [reply], approve: true, jev: { ...stubJev({ addresses: 0.5, unrelated: 0.05, clarification: 0.1 }), calibration: TEST_CALIBRATION } });
    assert.ok(low.result.plan.tests.every((t) => t.status === 'draft' && /addresses_requirement 0\.50/.test(t.review.issues[0]!)));
    const uncalibrated = await run({ root: tempDir(), text: SCENARIO, replies: [reply], approve: true, jev: { client, calibration: null } });
    assert.ok(uncalibrated.result.plan.tests.every((t) => t.status === 'draft' && t.review.issues[0] === 'uncalibrated'));
    const unavailable = await run({ root: tempDir(), text: SCENARIO, replies: [reply], approve: true });
    assert.ok(unavailable.result.plan.tests.every((t) => t.status === 'draft' && t.review.issues[0] === 'jev_unavailable: test' && t.review.addressesRequirement === null));
  });

  test('re-planning one document replaces only its entries; only its stale files are removed', async () => {
    const root = tempDir();
    const { planDir } = await firstGeneration(root);
    const termsFile = join(planDir, 'inline', 'departures-terms.e2e.yaml');
    const parkingFile = join(planDir, 'parking', 'parking-free.e2e.yaml');
    assert.ok(existsSync(termsFile));
    const parkingBytes = readFileSync(parkingFile);
    // Files the plan does not reference are never touched, even in a re-planned document's directory.
    writeFileSync(join(planDir, 'inline', 'manual.e2e.yaml'), 'name: 손으로 쓴 테스트\n');
    writeFileSync(join(planDir, 'inline', 'notes.txt'), '메모\n');

    const second = await run({ root, text: '# 출국장\n\n출국장 탭에 대기시간이 보인다.\n', replies: [JSON.stringify({ tests: [goodTest], untestable: [] })] });
    const plan = second.result.plan;
    assert.equal(plan.docs.length, 2);
    assert.match(plan.docs[0]!.path, /parking\.md$/);
    assert.equal(plan.docs[1]!.path, 'inline.md');
    assert.deepEqual(
      plan.requirements.map((r) => r.id),
      ['parking#주차', REQ_A],
    );
    assert.deepEqual(
      plan.tests.map((t) => t.file),
      ['tests/generated/tteonam/parking/parking-free.e2e.yaml', 'tests/generated/tteonam/inline/departures-wait.e2e.yaml'],
    );
    assert.deepEqual(
      [...snapshot(planDir).keys()].sort(),
      ['inline', 'inline/departures-wait.e2e.yaml', 'inline/manual.e2e.yaml', 'inline/notes.txt', 'parking', 'parking/parking-free.e2e.yaml', 'plan.json'].map((p) => p.split('/').join(sep)),
      'the stale departures-terms file is gone; no staging directory is left behind',
    );
    assert.deepEqual(readFileSync(parkingFile), parkingBytes, 'the other document’s test is untouched');
    assert.deepEqual(JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')), plan);
  });

  test('cancelling after the new generation is staged leaves the previous tests and plan.json byte-identical', async () => {
    const root = tempDir();
    const { planDir, doc } = await firstGeneration(root);
    const before = snapshot(planDir);
    const controller = new AbortController();
    const onEvent = (e: QaEventBody) => {
      if (e.type === 'plan.progress' && e.phase === 'write' && e.message.startsWith('새 계획 준비 완료')) controller.abort();
    };
    await assert.rejects(run({ root, text: SCENARIO, docs: [doc], replies: [secondReply], signal: controller.signal, onEvent }), /계획 생성이 취소되었습니다/);
    assert.deepEqual(snapshot(planDir), before);
  });

  test('a failure in the middle of the swap restores every file already swapped in', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, async () => {
    const root = tempDir();
    const { planDir, doc } = await firstGeneration(root);
    const before = snapshot(planDir);
    // Files swap in path order: inline/* first, then parking/* fails because its directory is read-only.
    chmodSync(join(planDir, 'parking'), 0o500);
    try {
      await assert.rejects(run({ root, text: SCENARIO, docs: [doc], replies: [secondReply] }), /테스트 파일 교체에 실패해 이전 계획으로 되돌렸습니다: .*(EACCES|EPERM)/);
    } finally {
      chmodSync(join(planDir, 'parking'), 0o700);
    }
    assert.deepEqual(snapshot(planDir), before);

    // The same regeneration succeeds once the directory is writable again.
    const ok = await run({ root, text: SCENARIO, docs: [doc], replies: [secondReply] });
    assert.match(readFileSync(join(planDir, 'parking', 'parking-free.e2e.yaml'), 'utf8'), /주차 빈자리 \(2세대\)/);
    assert.ok(!existsSync(join(planDir, 'inline', 'departures-terms.e2e.yaml')));
    assert.deepEqual(ok.result.plan.untestable, [{ requirement: REQ_B, reason: '화면 인벤토리에 없음: 2세대' }]);
  });

  test('failures emit plan.finished ok:false and write nothing', async () => {
    const root = tempDir();
    const fake = fakeLlm('claude', ['x'], { claudeError: true });
    const events: QaEventBody[] = [];
    await assert.rejects(
      generatePlan({ app: 'tteonam', docs: [], text: SCENARIO, env: fake.env, root, llm: 'claude-cli', events: { emit: (e) => events.push(e) }, contextDirs: { inventory: tempDir() }, jev: { client: null, calibration: null } }),
      /claude CLI 오류/,
    );
    const last = events.at(-1)!;
    assert.ok(last.type === 'plan.finished' && !last.ok);
    assert.ok(!existsSync(join(root, 'tests')));
    await assert.rejects(generatePlan({ app: 'tteonam', docs: [], llm: 'claude-cli', env: fake.env, root, contextDirs: { apps: tempDir() } }), /앱 프로필이 없습니다/);
  });
});
