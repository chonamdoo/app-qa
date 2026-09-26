import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildScreenModel } from '../../src/observe/index.ts';
import type { Manifest } from '../../src/report/manifest.ts';
import { FakeDriver, fixtureSnapshot, hits } from '../helpers/fake-driver.ts';
import { choice, commitSafe, jevStub, keyNamed, noul } from '../helpers/jev-stub.ts';
import { readJsonl, runYaml } from '../helpers/run.ts';

const APP = 'kr.tteonam.app';
const screen = (name: string, patch?: [string, string][]) => fixtureSnapshot('android', 'tteonam', name, { foreground: APP, patch });

/** Test file with `start: attach` (the fake app is already on screen) running `steps` (YAML list body). */
function spec(steps: string, extra = ''): string {
  return `name: 러너 테스트\napp: tteonam\nplatforms: [android]\nstart: attach\n${extra}steps:\n${steps}`;
}

describe('tap resolution and settle', () => {
  it('taps the 출국장 tab by fast path at its tapPoint and passes when the screen changes', async () => {
    const launch = screen('launch');
    const driver = new FakeDriver(launch);
    driver.onTap = (p) => (hits(launch, '출국장', p) ? screen('tab-departures') : null);
    const { result, root, events } = await runYaml({ 'tests/tab.e2e.yaml': spec('  - tap: 출국장\n') }, driver, { jev: commitSafe().setup });

    const expected = buildScreenModel(launch, {}).candidates.find((c) => c.name === '출국장' && c.role === 'tab')!;
    assert.deepEqual(driver.called('tap').map((c) => c.args[0]), [expected.tapPoint]);
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    const tap = t.steps.find((s) => s.kind === 'tap')!;
    assert.equal(tap.decisions[0]!.source, 'fast_path');
    assert.deepEqual(tap.settle && { changed: tap.settle.changed, settled: tap.settle.settled }, { changed: true, settled: true });

    // events.jsonl mirrors the stream with run-relative screenshot paths; manifest lists the evidence.
    const lines = readJsonl(join(result.runDir, 'events.jsonl'));
    assert.equal(lines.length, events.length);
    const observe = lines.find((e) => e.type === 'observe' && typeof e.screenshot === 'string')!;
    assert.ok(existsSync(join(result.runDir, observe.screenshot as string)));
    assert.ok(!(observe.screenshot as string).startsWith('/'));
    const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.equal(manifest.$schema, 'app-qa/manifest/v1');
    const kinds = new Set(manifest.entries.map((e) => e.kind));
    for (const k of ['screenshot', 'source', 'elements', 'verdict', 'events', 'report', 'log'] as const) assert.ok(kinds.has(k), `manifest kind ${k}`);
    for (const e of manifest.entries) assert.ok(e.sizeBytes > 0 && existsSync(join(result.runDir, e.relativePath)), e.relativePath);
    assert.ok(existsSync(join(root, '.qa', 'runs', result.runId, 'summary.json')));

    // Journal: intent (fsynced before dispatch) then outcome.
    const journal = readJsonl(join(result.runDir, 'journal.jsonl'));
    assert.deepEqual(
      journal.map((j) => [j.phase, j.kind]),
      [
        ['intent', 'tap'],
        ['outcome', 'tap'],
      ],
    );
  });

  it('reports no_effect as INCONCLUSIVE when nothing changes, and PASS with expectNoChange', async () => {
    const driver = new FakeDriver(screen('launch'));
    const plain = await runYaml({ 'tests/noop.e2e.yaml': spec('  - tap: 설정\n') }, driver, { jev: commitSafe().setup });
    const t = plain.result.tests[0]!;
    assert.equal(t.verdict, 'INCONCLUSIVE');
    assert.equal(t.code, 'no_effect');
    assert.equal(driver.called('tap').length, 1, 'never re-taps on no change');

    const allowed = await runYaml({ 'tests/noop.e2e.yaml': spec('  - tap: 설정\n    expectNoChange: true\n') }, new FakeDriver(screen('launch')), { jev: commitSafe().setup });
    assert.equal(allowed.result.tests[0]!.verdict, 'PASS', allowed.result.tests[0]!.reason);
  });

  it('ends the test with ERROR on an uncertain tap, journals the intent and never taps again', async () => {
    const driver = new FakeDriver(screen('launch'));
    driver.tapStatus = 'uncertain';
    const { result } = await runYaml({ 'tests/uncertain.e2e.yaml': spec('  - tap: 출국장\n  - tap: 주차\n') }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'uncertain_action');
    assert.equal(driver.called('tap').length, 1);
    const journal = readJsonl(join(result.runDir, 'journal.jsonl'));
    assert.equal(journal[0]!.phase, 'intent');
    assert.equal(journal[0]!.kind, 'tap');
    assert.equal(journal[1]!.status, 'uncertain');
  });
});

describe('risk policy', () => {
  it('blocks 내 항공편 지우기 without allowRisky and never taps', async () => {
    const driver = new FakeDriver(screen('my-flight-sheet'));
    const { result, events } = await runYaml({ 'tests/risk.e2e.yaml': spec('  - tap: 내 항공편 지우기\n') }, driver);
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'blocked_by_policy');
    assert.equal(driver.called('tap').length, 0);
    assert.ok(events.some((e) => e.type === 'policy' && e.blocked && e.reasons.some((r) => r.includes('지우기'))));
  });

  it('allows the same tap with allowRisky', async () => {
    const sheet = screen('my-flight-sheet');
    const driver = new FakeDriver(sheet);
    driver.onTap = (p) => (hits(sheet, '내 항공편 지우기', p) ? screen('launch') : null);
    const { result } = await runYaml({ 'tests/risk.e2e.yaml': spec('  - tap: 내 항공편 지우기\n    allowRisky: true\n') }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.equal(driver.called('tap').length, 1);
  });

  it('blocks English "Remove" on example-tickets', async () => {
    const driver = new FakeDriver(fixtureSnapshot('android', 'example-tickets', 'launch', { foreground: 'example.tickets' }));
    const yaml = 'name: remove\napp: example\nstart: attach\nsteps:\n  - tap: Remove\n';
    const { result } = await runYaml({ 'tests/remove.e2e.yaml': yaml }, driver);
    assert.equal(result.tests[0]!.code, 'blocked_by_policy');
    assert.equal(driver.called('tap').length, 0);
  });

  it('treats OK as risky inside a destructive confirmation dialog', async () => {
    const patch: [string, string][] = [
      ['Estimate only. Nothing is purchased or reserved. Your quantity is not saved after this screen session ends.', 'Are you sure? This cannot be undone.'],
      ['text="Add"', 'text="OK"'],
    ];
    const driver = new FakeDriver(fixtureSnapshot('android', 'example-tickets', 'launch', { foreground: 'example.tickets', patch }));
    const yaml = 'name: confirm\napp: example\nstart: attach\nsteps:\n  - tap: OK\n';
    const { result } = await runYaml({ 'tests/confirm.e2e.yaml': yaml }, driver);
    assert.equal(result.tests[0]!.code, 'blocked_by_policy', result.tests[0]!.reason);
    assert.match(result.tests[0]!.reason, /확인 대화상자/);
    assert.equal(driver.called('tap').length, 0);
  });
});

describe('occlusion', () => {
  it('cannot resolve a timeline button hidden behind the sheet (Jev says none) → FAIL not_found with diagnostics', async () => {
    const driver = new FakeDriver(screen('my-flight-sheet'));
    const jev = jevStub((_id, q) => choice(q, 'none', 0.9));
    const { result } = await runYaml({ 'tests/occluded.e2e.yaml': spec('  - tap: 탑승 시작\n    timeout: 1000\n') }, driver, { jev: jev.setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'not_found');
    assert.match(t.reason, /가려진 일치 1개/);
    assert.equal(jev.requests.length, 1, 'Jev re-asked only when the screen changes');
    assert.equal(driver.called('tap').length, 0);
  });

  it('a deterministic selector on the occluded button is not found either', async () => {
    const driver = new FakeDriver(screen('my-flight-sheet'));
    const steps = '  - tap: { desc: "00:45, 40분 전, 탑승 시작, 지금. 게이트 12" }\n    timeout: 500\n';
    const { result } = await runYaml({ 'tests/occluded.e2e.yaml': spec(steps) }, driver);
    assert.equal(result.tests[0]!.code, 'not_found');
    assert.match(result.tests[0]!.reason, /가려진 일치 1개/);
  });
});

describe('deterministic assertions', () => {
  const congestion = `  - checkEach:
      pattern: "대기 (?<wait>\\\\d+)분, (?<level>원활|보통|혼잡|매우 혼잡)"
      rule: { or: [ { "<": [ { var: wait }, 20 ] }, { "!=": [ { var: level }, 원활 ] } ] }
      min: 3
`;

  it('checkEach passes the congestion rule on the departures fixture', async () => {
    const { result } = await runYaml({ 'tests/check.e2e.yaml': spec(congestion) }, new FakeDriver(screen('tab-departures')));
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
  });

  it('checkEach fails a tampered line and names it', async () => {
    const tampered = screen('tab-departures', [['대기 15분, 원활', '대기 27분, 원활']]);
    const { result } = await runYaml({ 'tests/check.e2e.yaml': spec(congestion) }, new FakeDriver(tampered));
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'check_failed');
    assert.match(t.reason, /대기 27분, 원활/);
    assert.doesNotMatch(t.reason, /대기 8분/);
  });

  it('checkEach rules that check nothing are ERROR, never a truthy PASS', async () => {
    const check = (rule: string) => `  - checkEach:\n      pattern: "대기 (?<wait>\\\\d+)분"\n      rule: ${rule}\n`;
    const cases: Record<string, string> = {
      'empty object inside and': '{ and: [ {}, { "<": [ { var: wait }, 100 ] } ] }',
      'multi-operator object': '{ "!": [ { "<": [ 1, 2 ], ">": [ 1, 2 ] } ] }',
      'unknown operator': '{ between: [ { var: wait }, 0, 100 ] }',
      'non-boolean result': '{ var: wait }',
      // Missing operands compare `undefined`: json-logic-js calls `{"==":[]}` true.
      'comparison without operands': '{ "==": [] }',
      'comparison with one operand': '{ "<": [ { var: wait } ] }',
      'empty or': '{ or: [] }',
      'negation without operand': '{ "!": [] }',
      'in with one operand': '{ in: [ { var: wait } ] }',
      'empty comparison behind a true branch': '{ or: [ { "<": [ { var: wait }, 100 ] }, { "===": [] } ] }',
      // `%` of one operand is NaN on every line, and `NaN != 0` is true.
      'modulo without its divisor': '{ "!=": [ { "%": [ { var: wait } ] }, 0 ] }',
      'constant comparison reading no group': '{ "==": [ 1, 1 ] }',
      'var naming no group of the pattern': '{ "<": [ { var: minutes }, 100 ] }',
      'empty var name': '{ "<": [ { var: "" }, 100 ] }',
      'var with a default': '{ "<": [ { var: [ wait, 0 ] }, 100 ] }',
      // Inside `none` the data is the item (a number): `wait` of it is null, `null > 0` is false, so no item "fails".
      'group read inside a collection’s logic': '{ none: [ { merge: [ { var: wait } ] }, { ">": [ { var: wait }, 0 ] } ] }',
    };
    for (const [name, rule] of Object.entries(cases)) {
      const { result } = await runYaml({ 'tests/check.e2e.yaml': spec(check(rule)) }, new FakeDriver(screen('tab-departures')));
      const t = result.tests[0]!;
      assert.equal(t.verdict, 'ERROR', `${name}: ${t.reason}`);
      assert.equal(t.code, 'invalid_rule', `${name}: ${t.reason}`);
    }
    const empty = await runYaml({ 'tests/check.e2e.yaml': spec(check('{}')) }, new FakeDriver(screen('tab-departures')));
    assert.equal(empty.result.tests[0]!.verdict, 'ERROR', 'a top-level {} is rejected when the test loads');
    // `<` with three operands is a between check, not a malformed comparison.
    const between = await runYaml({ 'tests/check.e2e.yaml': spec(check('{ "<": [ -1, { var: wait }, 100 ] }')) }, new FakeDriver(screen('tab-departures')));
    assert.equal(between.result.tests[0]!.verdict, 'PASS', between.result.tests[0]!.reason);
  });

  it('assertNoText passes when absent for 500 ms and fails when present', async () => {
    const pass = await runYaml({ 'tests/n.e2e.yaml': spec('  - assertNoText: 오류가 발생했습니다\n') }, new FakeDriver(screen('launch')));
    assert.equal(pass.result.tests[0]!.verdict, 'PASS');
    const fail = await runYaml({ 'tests/n.e2e.yaml': spec('  - assertNoText: 출발했어요\n    timeout: 300\n') }, new FakeDriver(screen('launch')));
    assert.equal(fail.result.tests[0]!.code, 'text_present');
  });

  it('never passes an absence check on a truncated observation; presence checks still count what was seen', async () => {
    // depthCapped: the web extract hit its node cap / the iOS source hit its depth cap — the rest of the screen is unknown.
    const cut = { ...screen('launch'), depthCapped: true };
    const absences = {
      assertNoText: '  - assertNoText: 오류가 발생했습니다\n',
      seeNot: '  - seeNot: 로그인 버튼\n',
      expectNoText: '  - wait: 10\n    expect: { noText: 오류가 발생했습니다 }\n',
      whileNoText: '  - repeat: { while: { noText: 오류가 발생했습니다 }, steps: [ { wait: 10 } ] }\n',
    };
    for (const [name, steps] of Object.entries(absences)) {
      const jev = jevStub((_id, q) => choice(q, 'none', 0.9));
      const t = (await runYaml({ 'tests/t.e2e.yaml': spec(steps) }, new FakeDriver(cut), { jev: jev.setup })).result.tests[0]!;
      assert.equal(t.verdict, 'INCONCLUSIVE', `${name}: ${t.reason}`);
      assert.equal(t.code, 'observation_truncated', `${name}: ${t.reason}`);
      assert.match(t.reason, /잘려 관찰됨/, name);
    }
    const present = await runYaml({ 'tests/t.e2e.yaml': spec('  - assertText: 출국장\n  - see: 설정\n  - assertNoText: 출발했어요\n    timeout: 300\n') }, new FakeDriver(cut));
    assert.deepEqual(present.result.tests[0]!.steps.map((s) => [s.kind, s.verdict, s.code]), [
      ['start', 'PASS', null],
      ['assertText', 'PASS', null],
      ['see', 'PASS', null],
      ['assertNoText', 'FAIL', 'text_present'],
    ]);
  });

  it('checkEach on a truncated observation: an observed violation FAILs, anything else is INCONCLUSIVE, never PASS', async () => {
    const cut = (patch?: [string, string][]) => ({ ...screen('tab-departures', patch), depthCapped: true });
    const run = async (steps: string, snap = cut()) => (await runYaml({ 'tests/check.e2e.yaml': spec(steps) }, new FakeDriver(snap))).result.tests[0]!;
    // Every observed line satisfies the rule, but a violating line may lie past the cut.
    const passing = await run(congestion);
    assert.equal(passing.verdict, 'INCONCLUSIVE', passing.reason);
    assert.equal(passing.code, 'observation_truncated');
    // Fewer lines than `min`: the rest may lie past the cut.
    const few = await run(congestion.replace('min: 3', 'min: 50'));
    assert.equal(few.verdict, 'INCONCLUSIVE', few.reason);
    assert.equal(few.code, 'observation_truncated');
    // An observed violation is a real FAIL whatever the cut hides.
    const violating = await run(congestion.replace('min: 3', 'min: 50'), cut([['대기 15분, 원활', '대기 27분, 원활']]));
    assert.equal(violating.verdict, 'FAIL', violating.reason);
    assert.equal(violating.code, 'check_failed');
  });

  it('checkEach never evaluates a line whose group the rule reads was not observed', async () => {
    // The optional group does not match "대기, 원활": its wait was not observed (not 0, not null).
    const check = (min: number) => `  - checkEach:\n      pattern: "대기(?: (?<wait>\\\\d+)분)?"\n      rule: { "<": [ { var: wait }, 100 ] }\n      min: ${min}\n`;
    const blind = screen('tab-departures', [['대기 15분, 원활', '대기, 원활']]);
    const t = (await runYaml({ 'tests/check.e2e.yaml': spec(check(1)) }, new FakeDriver(blind))).result.tests[0]!;
    assert.equal(t.verdict, 'INCONCLUSIVE', t.reason);
    assert.equal(t.code, 'check_unobserved');
    assert.match(t.reason, /"출국장 3, 대기, 원활" \(wait 값 없음\)/);
    // A line that violates the rule still FAILs next to the unobserved one.
    const both = screen('tab-departures', [
      ['대기 15분, 원활', '대기, 원활'],
      ['대기 8분', '대기 150분'],
    ]);
    const f = (await runYaml({ 'tests/check.e2e.yaml': spec(check(1)) }, new FakeDriver(both))).result.tests[0]!;
    assert.equal(f.verdict, 'FAIL', f.reason);
    assert.equal(f.code, 'check_failed');
  });

  it('remember stores a value that later steps expand with ${var}', async () => {
    const steps = `  - remember: { name: gate, from: { regex: "^J(?<value>\\\\d+)-" } }
  - assertText: "J\${gate}-J35"
  - remember: { name: tab, from: 출국장 }
  - see: "\${tab}"
`;
    const { result } = await runYaml({ 'tests/r.e2e.yaml': spec(steps) }, new FakeDriver(screen('launch')));
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.match(t.steps[1]!.reason, /gate = "27"/);
  });

  it('an unset ${VAR} is an ERROR, not an empty string', async () => {
    const { result } = await runYaml({ 'tests/v.e2e.yaml': spec('  - assertText: "${QA_TEST_SURELY_UNSET_VAR}"\n') }, new FakeDriver(screen('launch')));
    assert.equal(result.tests[0]!.code, 'unset_variable');
  });
});

describe('Jev-backed steps', () => {
  it('seeNot passes after two consecutive not_found observations ≥500 ms apart', async () => {
    const jev = jevStub((_id, q) => choice(q, 'none', 0.9));
    const { result } = await runYaml({ 'tests/s.e2e.yaml': spec('  - seeNot: 로그인 버튼\n') }, new FakeDriver(screen('launch')), { jev: jev.setup });
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.equal(jev.requests.length, 1);
  });

  it('seeNot fails while the element is visible (fast path)', async () => {
    const jev = jevStub((_id, q) => choice(q, 'none', 0.9));
    const { result } = await runYaml({ 'tests/s.e2e.yaml': spec('  - seeNot: 설정\n    timeout: 300\n') }, new FakeDriver(screen('launch')), { jev: jev.setup });
    assert.equal(result.tests[0]!.code, 'still_visible');
  });

  it('uncalibrated Jev steps ERROR while deterministic steps still pass', async () => {
    const steps = '  - assertText: 빨리 빠지는 순서\n  - claim: 출국장별 대기 시간이 보인다\n';
    const { result } = await runYaml({ 'tests/u.e2e.yaml': spec(steps) }, new FakeDriver(screen('tab-departures')));
    const t = result.tests[0]!;
    assert.deepEqual(
      t.steps.map((s) => [s.kind, s.verdict]),
      [
        ['start', 'PASS'],
        ['assertText', 'PASS'],
        ['claim', 'ERROR'],
      ],
    );
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'uncalibrated');
  });

  it('a calibrated claim passes through the gate with its receipt saved', async () => {
    const jev = jevStub(() => noul(0.93));
    const { result } = await runYaml({ 'tests/c.e2e.yaml': spec('  - claim: 출국장별 대기 시간이 보인다\n') }, new FakeDriver(screen('tab-departures')), { jev: jev.setup });
    const step = result.tests[0]!.steps[1]!;
    assert.equal(step.verdict, 'PASS', step.reason);
    assert.ok(existsSync(join(result.runDir, step.evidenceDir, 'jev.json')));
  });

  it('Jev grounding picks a target and a Jev-chosen risky element is refused', async () => {
    const launch = screen('launch');
    const driver = new FakeDriver(launch);
    driver.onTap = (p) => (hits(launch, '주차', p) ? screen('tab-parking') : null);
    const jev = jevStub((id, q) => (id === 'target' ? choice(q, keyNamed(q, '주차'), 0.9) : noul(0.05)));
    const ok = await runYaml({ 'tests/g.e2e.yaml': spec('  - tap: 주차 탭 버튼\n') }, driver, { jev: jev.setup });
    assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);
    assert.equal(ok.result.tests[0]!.steps[1]!.decisions[0]!.source, 'jev');

    const sheet = new FakeDriver(screen('my-flight-sheet'));
    const risky = jevStub((id, q) => (id === 'target' ? choice(q, keyNamed(q, '내 항공편 지우기'), 0.9) : noul(0.05)));
    const blocked = await runYaml({ 'tests/g.e2e.yaml': spec('  - tap: 빨간 버튼\n    allowRisky: true\n') }, sheet, { jev: risky.setup });
    assert.equal(blocked.result.tests[0]!.code, 'blocked_by_policy');
    assert.equal(sheet.called('tap').length, 0);
  });
});

describe('flow control', () => {
  it('use runs a subflow with `with` parameters', async () => {
    const launch = screen('launch');
    const driver = new FakeDriver(launch);
    driver.onTap = (p) => (hits(launch, '출국장', p) ? screen('tab-departures') : null);
    const flow = 'name: 탭 열기\nsteps:\n  - tap: "${tab}"\n  - see: { desc: "${tab}" }\n';
    const { result } = await runYaml({ 'tests/u.e2e.yaml': spec('  - use: flows/open.flow.yaml\n    with: { tab: 출국장 }\n') }, driver, {
      files: { 'tests/flows/open.flow.yaml': flow },
      jev: commitSafe().setup,
    });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.equal(driver.called('tap').length, 1);
    assert.deepEqual(
      t.steps.map((s) => s.label.split(' ')[0]),
      ['1', '2', '2.1', '2.2'],
    );
  });

  it('repeat runs `times` iterations and stops `while` at the 10-iteration bound', async () => {
    const times = await runYaml({ 'tests/r.e2e.yaml': spec('  - repeat: { times: 3, steps: [ { assertText: 출국장 } ] }\n') }, new FakeDriver(screen('launch')));
    assert.equal(times.result.tests[0]!.verdict, 'PASS');
    assert.equal(times.result.tests[0]!.steps.filter((s) => s.kind === 'assertText').length, 3);

    const bounded = await runYaml({ 'tests/r.e2e.yaml': spec('  - repeat: { while: { noText: 없는문구 }, steps: [ { wait: 10 } ] }\n') }, new FakeDriver(screen('launch')));
    const t = bounded.result.tests[0]!;
    assert.equal(t.verdict, 'INCONCLUSIVE');
    assert.equal(t.code, 'repeat_limit');
    assert.equal(t.steps.filter((s) => s.kind === 'wait').length, 10);
  });

  it('a failing teardown is a warning and keeps the verdict', async () => {
    const yaml = spec('  - assertText: 출국장\n', 'teardown:\n  - assertText: 없는문구\n    timeout: 200\n');
    const { result } = await runYaml({ 'tests/t.e2e.yaml': yaml }, new FakeDriver(screen('launch')));
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS');
    assert.ok(t.warnings.some((w) => w.includes('정리 단계 실패')));
    assert.equal(t.steps.at(-1)!.phase, 'teardown');
    assert.equal(t.steps.at(-1)!.verdict, 'FAIL');
  });

  it('exceeding the step budget is INCONCLUSIVE budget_exceeded', async () => {
    const yaml = spec('  - assertText: 출국장\n  - assertText: 주차\n  - assertText: 안내\n', 'budget: { steps: 3 }\n');
    const { result } = await runYaml({ 'tests/b.e2e.yaml': yaml }, new FakeDriver(screen('launch')));
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'INCONCLUSIVE');
    assert.equal(t.code, 'budget_exceeded');
  });

  it('optional failures are SKIPPED, platform-filtered steps are SKIPPED, and the run aggregates per test', async () => {
    const tests = {
      'tests/a.e2e.yaml': spec('  - assertText: 없는문구\n    optional: true\n    timeout: 100\n  - assertText: 출국장\n  - tap: 설정\n    platforms: [ios]\n'),
      'tests/b.e2e.yaml': spec('  - assertText: 없는문구\n    timeout: 100\n').replace('러너 테스트', 'B'),
      'tests/c.e2e.yaml': spec('  - tap: 설정\n').replace('러너 테스트', 'C'),
    };
    const { result } = await runYaml(tests, new FakeDriver(screen('launch')), { jev: commitSafe().setup });
    const by = Object.fromEntries(result.tests.map((t) => [t.id, t]));
    assert.equal(by.a!.verdict, 'PASS');
    assert.deepEqual(by.a!.steps.map((s) => s.verdict), ['PASS', 'SKIPPED', 'PASS', 'SKIPPED']);
    assert.equal(by.b!.verdict, 'FAIL');
    assert.equal(by.c!.verdict, 'INCONCLUSIVE');
    assert.deepEqual(result.counts, { PASS: 1, FAIL: 1, INCONCLUSIVE: 1, ERROR: 0, SKIPPED: 0 });
  });

  it('when interrupts dismiss a popup deterministically before the next step', async () => {
    const sheet = screen('my-flight-sheet');
    const driver = new FakeDriver(sheet);
    driver.onTap = (p) => (hits(sheet, '닫기', p) ? screen('launch') : null);
    const yaml = spec('  - see: 출발했어요\n', 'when:\n  - see: { desc: 닫기 }\n    do: [ { tap: 닫기 } ]\n');
    const { result } = await runYaml({ 'tests/w.e2e.yaml': yaml }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'PASS', t.reason);
    assert.ok(t.steps.some((s) => s.phase === 'interrupt' && s.kind === 'tap'));
  });
});
