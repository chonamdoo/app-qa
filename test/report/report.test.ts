import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sha256 } from '../../src/core/fsx.ts';
import { regenerateReport } from '../../src/report/index.ts';
import type { PlanFile } from '../../src/spec/schema.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { commitSafe } from '../helpers/jev-stub.ts';
import { runYaml } from '../helpers/run.ts';

const DOC_V1 = '# 떠남\n\n## 출국장\n혼잡 단계는 대기 시간과 맞아야 한다.\n';

function plan(): PlanFile {
  const req = (n: string, text: string) => ({ id: `context#${n}`, doc: 'docs/context.md', section: ['떠남', n], lines: [3, 4] as [number, number], text, digest: sha256(text) });
  return {
    version: 1,
    app: 'tteonam',
    createdAt: '2026-09-26T09:00:00.000Z',
    llm: { provider: 'claude-cli', model: null },
    docs: [{ path: 'docs/context.md', sha256: sha256(DOC_V1), kind: 'md' }],
    requirements: [req('출국장', '출국장 탭에서 대기 시간이 보인다'), req('주차', '주차 탭이 열린다'), req('결제', '주차 요금을 결제한다')],
    tests: [
      { file: 'tests/generated/tteonam/context/departures.e2e.yaml', covers: ['context#출국장'], status: 'draft', review: { addressesRequirement: 0.9, unrelatedSteps: 0.1, needsClarification: 0.1, issues: [] } },
      { file: 'tests/generated/tteonam/context/parking.e2e.yaml', covers: ['context#주차'], status: 'approved', review: { addressesRequirement: 0.9, unrelatedSteps: 0.1, needsClarification: 0.1, issues: [] } },
    ],
    untestable: [{ requirement: 'context#결제', reason: 'needs_approval: 결제는 위험 동작' }],
  };
}

function generated(id: string, covers: string, status: string, steps: string): string {
  return `id: ${id}\nname: ${id} 테스트\napp: tteonam\nplatforms: [android]\nstart: attach\ncovers: [${covers}]\nsource: { plan: tests/generated/tteonam/plan.json, status: ${status} }\nsteps:\n${steps}`;
}

describe('report', () => {
  it('renders the requirement traceability matrix with draft badges, untestable reasons and changed documents', async () => {
    const tests = {
      'tests/generated/tteonam/context/departures.e2e.yaml': generated('departures', '"context#출국장"', 'draft', '  - assertText: 빨리 빠지는 순서\n'),
      'tests/generated/tteonam/context/parking.e2e.yaml': generated('parking', '"context#주차"', 'approved', '  - assertText: 없는문구\n    timeout: 100\n'),
    };
    const files = {
      'tests/generated/tteonam/plan.json': JSON.stringify(plan()),
      'docs/context.md': `${DOC_V1}\n## 추가\n문서가 바뀌었다.\n`,
    };
    const driver = new FakeDriver(fixtureSnapshot('android', 'tteonam', 'tab-departures', { foreground: 'kr.tteonam.app' }));
    const { result, root } = await runYaml(tests, driver, { files, junit: true });

    const html = readFileSync(result.reportPath, 'utf8');
    assert.match(html, /<html lang="ko">/);
    assert.match(html, /요구사항 추적 매트릭스 — tteonam/);
    for (const id of ['context#출국장', 'context#주차', 'context#결제']) assert.ok(html.includes(id), id);
    assert.match(html, /초안\(draft\)/);
    assert.match(html, /문서 변경됨/);
    assert.match(html, /테스트 불가 요구사항[\s\S]*needs_approval: 결제는 위험 동작/);
    assert.match(html, /href="#departures-android"><span class="v v-PASS">통과<\/span>/);
    assert.match(html, /href="#parking-android"><span class="v v-FAIL">실패<\/span>/);
    // Thumbnails link into the run dir relatively.
    assert.match(html, /<img loading="lazy" src="departures\/android\/step-01\/before\.png"/);

    const junit = readFileSync(result.junitPath!, 'utf8');
    assert.match(junit, /<testsuite name="app-qa android" tests="2" failures="1" errors="0" skipped="0"/);

    // The document is restored: regeneration from summary.json drops the change marker.
    writeFileSync(join(root, 'docs/context.md'), DOC_V1);
    const again = regenerateReport(result.runId, { runsDir: join(root, '.qa', 'runs'), root });
    const html2 = readFileSync(again.reportPath, 'utf8');
    assert.doesNotMatch(html2, /문서 변경됨/);
    assert.ok(again.junitPath);
  });

  it('counts INCONCLUSIVE as a JUnit failure and omits the matrix without covers', async () => {
    const yaml = 'name: noop\napp: tteonam\nstart: attach\nsteps:\n  - tap: 설정\n';
    const { result } = await runYaml({ 'tests/noop.e2e.yaml': yaml }, new FakeDriver(fixtureSnapshot('android', 'tteonam', 'launch', { foreground: 'kr.tteonam.app' })), { junit: true, jev: commitSafe().setup });
    assert.match(readFileSync(result.junitPath!, 'utf8'), /<failure type="INCONCLUSIVE:no_effect"/);
    assert.doesNotMatch(readFileSync(result.reportPath, 'utf8'), /요구사항 추적 매트릭스/);
  });
});
