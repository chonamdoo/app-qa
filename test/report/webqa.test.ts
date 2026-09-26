import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sha256 } from '../../src/core/fsx.ts';
import type { Manifest } from '../../src/report/manifest.ts';
import type { RunSummary } from '../../src/report/types.ts';
import type { WebQaPlan, WebQaResult } from '../../src/report/webqa.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { commitSafe, webCalibration } from '../helpers/jev-stub.ts';
import { runYaml } from '../helpers/run.ts';

const web = (steps: string) => `name: 웹\napp: web-demo\nstart: attach\nsteps:\n${steps}`;

describe('web-qa check-run export', () => {
  it('writes the required set and one attempt per website result, with sanitized evidence hashed as written', async () => {
    const driver = new FakeDriver(fixtureSnapshot('desktop-chrome', 'web-demo', 'index'));
    const { result } = await runYaml(
      {
        'tests/ok.e2e.yaml': web('  - assertText: 상품 3개\n'),
        'tests/noop.e2e.yaml': web('  - tap: 도움말\n'),
        'tests/away.e2e.yaml': web('  - open: https://evil.example/\n'),
        'tests/bad.e2e.yaml': 'name: [broken\n',
      },
      driver,
      { platform: 'desktop-chrome', jev: commitSafe(webCalibration()).setup, junit: true },
    );
    assert.deepEqual(result.webQa, ['web-qa/plan.json', 'web-qa/result.json']);
    const plan = JSON.parse(readFileSync(join(result.runDir, 'web-qa/plan.json'), 'utf8')) as WebQaPlan;
    const out = JSON.parse(readFileSync(join(result.runDir, 'web-qa/result.json'), 'utf8')) as WebQaResult;

    assert.equal(plan.version, 1);
    assert.equal(plan.runId, result.runId);
    assert.match(plan.buildId, /^config-[0-9a-f]{16}$/);
    assert.equal(out.buildId, plan.buildId);
    assert.equal(out.runnerExitCode, 1, 'the runner exit (failures present), kept separately from the gate');
    const combos = plan.required.map((r) => `${r.scenarioId} ${r.targetId}`).sort();
    assert.deepEqual(combos, ['away desktop-chrome', 'bad desktop-chrome', 'noop desktop-chrome', 'ok desktop-chrome']);
    const status = Object.fromEntries(out.attempts.map((a) => [a.scenarioId, a.status]));
    // INCONCLUSIVE has no check-run status: exported FAIL while the summary keeps it.
    assert.deepEqual(status, { ok: 'PASS', noop: 'FAIL', away: 'BLOCKED', bad: 'NOT_RUN' });
    const summary = JSON.parse(readFileSync(join(result.runDir, 'summary.json'), 'utf8')) as RunSummary;
    assert.equal(summary.tests.find((t) => t.id === 'noop')!.verdict, 'INCONCLUSIVE');
    assert.deepEqual(summary.qaCounts, { PASS: 1, FAIL: 0, INCONCLUSIVE: 1, BLOCKED: 1, NOT_RUN: 1, SKIPPED: 0 });

    for (const a of out.attempts) {
      assert.equal(a.attempt, 1);
      if (a.status === 'NOT_RUN') assert.deepEqual(a.evidence, []);
      else assert.ok(a.evidence.length > 0, a.scenarioId);
      for (const e of a.evidence) {
        assert.ok(e.path.startsWith(`${a.scenarioId}/desktop-chrome/`), e.path);
        assert.equal(sha256(readFileSync(join(result.runDir, e.path))), e.sha256, e.path);
      }
    }
    const manifest = JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')) as Manifest;
    assert.ok(manifest.entries.some((e) => e.relativePath === 'web-qa/result.json' && e.kind === 'report'));

    const html = readFileSync(result.reportPath, 'utf8');
    assert.match(html, /<th>Chrome \(macOS\)<\/th>/);
    assert.match(html, /<span class="qa qa-BLOCKED">BLOCKED<\/span>/);
    assert.match(readFileSync(result.junitPath!, 'utf8'), /<property name="qaStatus" value="NOT_RUN"\/><property name="target" value="Chrome \(macOS\)"\/>/);
  });

  it('writes nothing for a run without websites', async () => {
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' }));
    const { result } = await runYaml({ 'tests/a.e2e.yaml': 'name: 앱\napp: tteonam\nstart: attach\nsteps:\n  - wait: 10\n' }, driver);
    assert.deepEqual(result.webQa, []);
    assert.equal(existsSync(join(result.runDir, 'web-qa')), false);
    assert.equal(result.tests[0]!.qaStatus, 'PASS');
  });
});
