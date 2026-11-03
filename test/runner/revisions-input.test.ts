import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempRoot } from '../helpers/run.ts';

for (const dependency of [false, true]) {
  test(`preview rejects a FIFO ${dependency ? 'flow dependency' : 'test source'} without blocking the engine`, { skip: process.platform === 'win32' }, () => {
    const good = JSON.stringify({ id: 'good', name: 'Readable source', app: 'example', platforms: ['android'], steps: [{ assertText: 'ready' }] });
    const root = tempRoot({
      'tests/good.e2e.yaml': good,
      ...(dependency ? { 'tests/blocked.e2e.yaml': JSON.stringify({ id: 'blocked', name: 'Unreadable flow', app: 'example', platforms: ['android'], steps: [{ use: 'blocked.flow.yaml' }, { assertText: 'ready' }] }) } : {}),
    });
    execFileSync('mkfifo', [join(root, 'tests', dependency ? 'blocked.flow.yaml' : 'blocked.e2e.yaml')]);
    const program = `
      import { join } from 'node:path';
      import { createRevisionStore } from ${JSON.stringify(new URL('../../src/runner/revisions.ts', import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, 'tests/generated') });
      const candidate = await store.preview(['tests/good.e2e.yaml', 'tests/blocked.e2e.yaml']);
      let publishCode = null;
      try { await store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'local-fixture', channel: 'local-ui' }); }
      catch (error) { publishCode = error.code; }
      console.log(JSON.stringify({ problems: candidate.problems, candidateTests: candidate.definition.tests.map(test => test.id), publishCode }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, child.error?.message ?? 'Preview child failed');
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.ok(result.problems.some((problem: { code: string }) => problem.code === 'spec_invalid'));
    assert.deepEqual(result.candidateTests, ['good']);
    assert.equal(result.publishCode, 'publication_blocked');
  });
}
