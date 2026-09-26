import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Snapshot } from '../../src/core/types.ts';
import { runTests } from '../../src/runner/index.ts';
import { FakeDriver, fixtureSnapshot, type FakeCall } from '../helpers/fake-driver.ts';
import { commitSafe, jevStub, noul, testCalibration } from '../helpers/jev-stub.ts';
import { fakeDeps, runYaml, tempRoot } from '../helpers/run.ts';

const APP = 'kr.tteonam.app';

function spec(steps: string, app = 'tteonam'): string {
  return `name: 준비 테스트\napp: ${app}\nplatforms: [android]\nstart: attach\nsteps:\n${steps}`;
}

describe('policy on the final fresh observation', () => {
  const tickets = (patch: [string, string][]) => fixtureSnapshot('android', 'example-tickets', 'launch', { foreground: 'example.tickets', patch });
  const confirm: [string, string] = ['text="Add"', 'text="확인"'];
  const dialog: [string, string] = ['Estimate only. Nothing is purchased or reserved. Your quantity is not saved after this screen session ends.', '정말 삭제하시겠습니까? 되돌릴 수 없습니다.'];

  it('does not tap a safe 확인 that became the confirm of a destructive dialog on the fresh observation', async () => {
    // Control: the same 확인 on an unchanged screen is tapped (safe label, commit check says no commit).
    const plain = new FakeDriver(tickets([confirm]));
    await runYaml({ 'tests/c.e2e.yaml': spec('  - tap: 확인\n    expectNoChange: true\n', 'example') }, plain, { jev: commitSafe().setup });
    assert.equal(plain.called('tap').length, 1);

    // Step start shows a plain 확인; the freshness re-observation (3rd snapshot) shows the destructive dialog.
    const driver = new FakeDriver(tickets([confirm]));
    const destructive = tickets([confirm, dialog]);
    driver.onSnapshot = (d) => {
      if (d.called('snapshot').length >= 3) d.screen = destructive;
    };
    const { result, events } = await runYaml({ 'tests/c.e2e.yaml': spec('  - tap: 확인\n', 'example') }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'blocked_by_policy', t.reason);
    assert.match(t.reason, /파괴적 확인 대화상자/);
    assert.equal(driver.called('tap').length, 0);
    assert.ok(events.some((e) => e.type === 'policy' && e.blocked));
  });
});

describe('press: enter and type.submit go through the policy', () => {
  const DESTRUCTIVE: [string, string] = ['text="내 항공편 찾기"', 'text="정말 삭제하시겠습니까?"'];
  const search = (patch: [string, string][] = []): Snapshot => fixtureSnapshot('android', 'tteonam', 'search-empty-keyboard', { foreground: APP, keyboardShown: true, patch });
  const into = '    into: { intent: 편명·도시·항공사, state: { focused: true } }\n';

  it('blocks press: enter on a destructive-context screen, even with a commit check that finds nothing', async () => {
    const driver = new FakeDriver(search([DESTRUCTIVE]));
    const { result } = await runYaml({ 'tests/e.e2e.yaml': spec('  - press: enter\n') }, driver, { jev: commitSafe().setup });
    assert.equal(result.tests[0]!.code, 'blocked_by_policy', result.tests[0]!.reason);
    assert.match(result.tests[0]!.reason, /제출\(Enter\)/);
    assert.equal(driver.called('press').length, 0);
  });

  it('type.submit types without Enter, then approves Enter on the screen after typing', async () => {
    // Safe screen: typed with submit false, the focused field is commit-checked afresh, then Enter is pressed.
    const safe = new FakeDriver(search());
    const jev = commitSafe();
    const ok = await runYaml({ 'tests/s.e2e.yaml': spec(`  - type: 인천\n    submit: true\n${into}`) }, safe, { jev: jev.setup });
    assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);
    assert.deepEqual(safe.called('typeText').map((c) => (c.args[2] as { submit?: boolean }).submit), [false]);
    assert.deepEqual(safe.called('press').map((c) => c.args[0]), ['enter']);
    assert.ok(jev.requests.some((r) => 'commits' in r.questions), 'Enter was commit-checked');

    // A destructive dialog that appears only after typing blocks Enter.
    const driver = new FakeDriver(search());
    driver.onAction = (method, d) => {
      if (method === 'typeText') d.screen = search([DESTRUCTIVE]);
    };
    const { result } = await runYaml({ 'tests/s.e2e.yaml': spec(`  - type: 인천\n    submit: true\n${into}`) }, driver, { jev: commitSafe().setup });
    assert.equal(result.tests[0]!.code, 'blocked_by_policy', result.tests[0]!.reason);
    assert.match(result.tests[0]!.reason, /제출\(Enter\)/);
    assert.deepEqual(driver.called('typeText').map((c) => (c.args[2] as { submit?: boolean }).submit), [false]);
    assert.equal(driver.called('press').length, 0);
  });

  it('press: back is not a submission: no policy block and no commit check', async () => {
    const driver = new FakeDriver(search([DESTRUCTIVE]));
    const { result } = await runYaml({ 'tests/b.e2e.yaml': spec('  - press: back\n    expectNoChange: true\n') }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.deepEqual(driver.called('press').map((c) => c.args[0]), ['back']);
  });

  it('press: enter on a safe screen needs the commit check: pressed with it, refused without it', async () => {
    const checked = new FakeDriver(search());
    const jev = commitSafe();
    const ok = await runYaml({ 'tests/e.e2e.yaml': spec('  - press: enter\n    expectNoChange: true\n') }, checked, { jev: jev.setup });
    assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);
    assert.deepEqual(checked.called('press').map((c) => c.args[0]), ['enter']);
    assert.ok(jev.requests.some((r) => 'commits' in r.questions), 'the focused field was commit-checked');

    const unchecked = new FakeDriver(search());
    const refused = await runYaml({ 'tests/e.e2e.yaml': spec('  - press: enter\n    expectNoChange: true\n') }, unchecked);
    assert.equal(refused.result.tests[0]!.code, 'commit_check_unavailable');
    assert.equal(unchecked.called('press').length, 0);
  });

  it('a line break in typed text is a submission: blocked_by_policy before any driver call, typed only with allowRisky', async () => {
    const VAR = 'QA_PREPARE_MULTILINE';
    process.env[VAR] = 'first\nsecond';
    try {
      for (const text of ['"hello\\n"', '"hello\\rworld"', `"\${${VAR}}"`]) {
        const driver = new FakeDriver(search());
        const root = tempRoot({ 'tests/n.e2e.yaml': spec(`  - type: ${text}\n${into}`) });
        // Driver calls made while the type step (index 1, after the implicit start) runs.
        let from = -1;
        let during: FakeCall[] | null = null;
        const emit = (e: { type: string; index?: number }) => {
          if (e.type === 'step.started' && e.index === 1) from = driver.calls.length;
          if (e.type === 'step.finished' && e.index === 1) during = driver.calls.slice(from);
        };
        const result = await runTests({ paths: [join(root, 'tests/n.e2e.yaml')], platform: 'android', events: { emit } }, fakeDeps(root, driver, commitSafe().setup));
        const t = result.tests[0]!;
        assert.equal(t.verdict, 'ERROR', text);
        assert.equal(t.code, 'blocked_by_policy', t.reason);
        assert.match(t.reason, /줄바꿈은 제출\(Enter\)이 될 수 있음/);
        assert.deepEqual(during, [], `${text}: driver calls during the blocked step`);
      }
    } finally {
      delete process.env[VAR];
    }

    const driver = new FakeDriver(search());
    const { result } = await runYaml({ 'tests/n.e2e.yaml': spec(`  - type: "hello\\n"\n    allowRisky: true\n${into}`) }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.deepEqual(driver.called('typeText').map((c) => c.args[1]), ['hello\n']);
  });
});

describe('edit targets must be text fields', () => {
  it('type into / clear of a button is FAIL not_editable and nothing is dispatched', async () => {
    for (const step of ['  - type: "3"\n    into: Add\n', '  - clear: Add\n']) {
      const driver = new FakeDriver(fixtureSnapshot('android', 'example-tickets', 'launch', { foreground: 'example.tickets' }));
      const { result } = await runYaml({ 'tests/n.e2e.yaml': spec(step, 'example') }, driver, { jev: commitSafe().setup });
      const t = result.tests[0]!;
      assert.equal(t.verdict, 'FAIL', step);
      assert.equal(t.code, 'not_editable', t.reason);
      for (const method of ['tap', 'longPress', 'typeText', 'clearText', 'press']) assert.equal(driver.called(method).length, 0, `${step}: ${method}`);
    }
  });
});

describe('mandatory commit check', () => {
  const launch = () => fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP });

  it('a commit check error is ERROR commit_check_unavailable and nothing is tapped', async () => {
    const driver = new FakeDriver(launch());
    const broken = jevStub((id) => (id === 'commits' ? { type: 'noul', noul: 1.5 } : noul(0.02)));
    const { result, events } = await runYaml({ 'tests/t.e2e.yaml': spec('  - tap: 출국장\n') }, driver, { jev: broken.setup });
    const t = result.tests[0]!;
    assert.equal(t.verdict, 'ERROR');
    assert.equal(t.code, 'commit_check_unavailable', t.reason);
    assert.equal(driver.called('tap').length, 0);
    assert.ok(events.some((e) => e.type === 'policy' && e.blocked && !e.risky));
  });

  it('no calibration, or a commit gate that failed calibration, refuses a safe tap the same way', async () => {
    const failed = testCalibration();
    failed.commit.status = 'failed';
    const gated = jevStub(() => noul(0.02));
    for (const jev of [undefined, { ...gated.setup, calibration: failed }]) {
      const driver = new FakeDriver(launch());
      const { result } = await runYaml({ 'tests/t.e2e.yaml': spec('  - tap: 출국장\n') }, driver, { jev });
      assert.equal(result.tests[0]!.code, 'commit_check_unavailable', result.tests[0]!.reason);
      assert.equal(driver.called('tap').length, 0);
    }
    assert.equal(gated.requests.length, 0, 'an unusable commit gate is never asked');
  });

  it('type and clear into a text field need the commit check too: refused when it is unavailable, asked when it is usable', async () => {
    const search = () => fixtureSnapshot('android', 'tteonam', 'search-empty-keyboard', { foreground: APP, keyboardShown: true });
    const into = '    into: { intent: 편명·도시·항공사, state: { focused: true } }\n';
    const failed = testCalibration();
    failed.commit.status = 'failed';
    for (const step of [`  - type: 인천\n${into}`, '  - clear: { intent: 편명·도시·항공사, state: { focused: true } }\n']) {
      for (const jev of [undefined, { ...jevStub(() => noul(0.02)).setup, calibration: failed }]) {
        const driver = new FakeDriver(search());
        const { result } = await runYaml({ 'tests/e.e2e.yaml': spec(step) }, driver, { jev });
        const t = result.tests[0]!;
        assert.equal(t.verdict, 'ERROR', step);
        assert.equal(t.code, 'commit_check_unavailable', t.reason);
        for (const method of ['tap', 'typeText', 'clearText', 'press']) assert.equal(driver.called(method).length, 0, `${step}: ${method}`);
      }
      // A commit check that finds a commit refuses the edit; one that finds nothing lets it through.
      const committing = new FakeDriver(search());
      const refused = await runYaml({ 'tests/e.e2e.yaml': spec(step) }, committing, { jev: jevStub((id) => noul(id === 'commits' ? 0.98 : 0.02)).setup });
      assert.equal(refused.result.tests[0]!.code, 'blocked_by_policy', refused.result.tests[0]!.reason);
      assert.equal(committing.called('typeText').length + committing.called('clearText').length, 0, step);
      const checked = new FakeDriver(search());
      const jev = commitSafe();
      const ok = await runYaml({ 'tests/e.e2e.yaml': spec(step) }, checked, { jev: jev.setup });
      assert.equal(ok.result.tests[0]!.verdict, 'PASS', ok.result.tests[0]!.reason);
      assert.equal(checked.called('typeText').length + checked.called('clearText').length, 1, step);
      assert.ok(jev.requests.some((r) => 'commits' in r.questions), `${step}: the field was commit-checked`);
    }
  });

  it('allowRisky (a human approval) acts on a safe target without the commit check', async () => {
    const driver = new FakeDriver(launch());
    const { result } = await runYaml({ 'tests/t.e2e.yaml': spec('  - tap: 출국장\n    allowRisky: true\n    expectNoChange: true\n') }, driver);
    assert.equal(result.tests[0]!.verdict, 'PASS', result.tests[0]!.reason);
    assert.equal(driver.called('tap').length, 1);
  });
});

describe('post-scroll stabilisation', () => {
  it('a target that keeps moving after a scroll is FAIL stale_target and is never tapped', async () => {
    const base = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP });
    const driver = new FakeDriver(base);
    let scrolled = false;
    driver.onAction = (method) => {
      if (method === 'swipe') scrolled = true;
    };
    // After the scroll the 설정 button alternates between two positions, so no two consecutive observations agree.
    driver.onSnapshot = (d) => {
      if (!scrolled) return;
      const dy = d.called('snapshot').length % 2 === 0 ? 0 : 2;
      d.screen = { ...base, nodes: base.nodes.map((n) => (n.desc === '설정' ? { ...n, rect: { ...n.rect, y: n.rect.y + dy } } : n)) };
    };
    const steps = '  - scroll: { direction: down }\n    expectNoChange: true\n  - tap: 설정\n';
    const { result } = await runYaml({ 'tests/m.e2e.yaml': spec(steps) }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.steps[1]!.verdict, 'PASS', t.steps[1]!.reason);
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'stale_target', t.reason);
    assert.match(t.reason, /안정되지 않음/);
    assert.equal(driver.called('tap').length, 0);
  });

  it('press: back stabilises like back: a target that keeps moving afterwards is FAIL stale_target and is never tapped', async () => {
    const base = fixtureSnapshot('android', 'tteonam', 'launch', { foreground: APP });
    const driver = new FakeDriver(base);
    let pressed = false;
    driver.onAction = (method) => {
      if (method === 'press') pressed = true;
    };
    driver.onSnapshot = (d) => {
      if (!pressed) return;
      const dy = d.called('snapshot').length % 2 === 0 ? 0 : 2;
      d.screen = { ...base, nodes: base.nodes.map((n) => (n.desc === '설정' ? { ...n, rect: { ...n.rect, y: n.rect.y + dy } } : n)) };
    };
    const steps = '  - press: back\n    expectNoChange: true\n  - tap: 설정\n';
    const { result } = await runYaml({ 'tests/m.e2e.yaml': spec(steps) }, driver, { jev: commitSafe().setup });
    const t = result.tests[0]!;
    assert.equal(t.steps[1]!.verdict, 'PASS', t.steps[1]!.reason);
    assert.deepEqual(driver.called('press').map((c) => c.args[0]), ['back']);
    assert.equal(t.verdict, 'FAIL');
    assert.equal(t.code, 'stale_target', t.reason);
    assert.match(t.reason, /안정되지 않음/);
    assert.equal(driver.called('tap').length, 0);
  });
});
