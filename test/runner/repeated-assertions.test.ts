import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Verdict } from '../../src/core/types.ts';
import { writeSecure } from '../../src/core/fsx.ts';
import { productDigest } from '../../src/core/product.ts';
import type { PublishedRevision, RevisionPayload } from '../../src/core/regression.ts';
import { runTests } from '../../src/runner/index.ts';
import { createRevisionStore, frozenLoadedTest } from '../../src/runner/revisions.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { fakeDeps, tempRoot } from '../helpers/run.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';

test('nested fixed repetitions through a flow execute every required assertion with a distinct occurrence identity', async () => {
  const root = tempRoot({
    'apps/repeat-fixture.yaml': JSON.stringify({ id: 'repeat-fixture', name: 'Repeated assertion fixture', web: { url: 'http://localhost:4173/', platforms: ['desktop-chrome'] } }),
    'tests/repeat.e2e.yaml': JSON.stringify({ name: 'Nested fixed assertions', app: 'repeat-fixture', start: 'attach', steps: [{ repeat: { times: 2, steps: [{ use: '../flows/check.flow.yaml' }] } }] }),
    'flows/check.flow.yaml': JSON.stringify({ name: 'Repeated visible text', steps: [{ repeat: { times: 3, steps: [{ assertText: 'QA 데모 상점' }] } }] }),
  });
  const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, '.qa', 'generated') });
  const candidate = await store.preview(['tests/repeat.e2e.yaml']);
  assert.deepEqual(candidate.problems, []);
  const revision = await store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'fixture-reviewer', channel: 'local-ui' });
  const driver = new FakeDriver(fixtureSnapshot('desktop-chrome', 'web-demo', 'index'));
  const receipts: { path: string; verdict: Verdict }[] = [];
  let verdict: Verdict | null = null;
  await runTests({
    paths: [], platform: 'desktop-chrome', deviceIds: { 'desktop-chrome': driver.deviceId },
    frozen: {
      ownerId: 'repeated-assertions-fixture', tests: [frozenLoadedTest(revision.definition.tests[0]!)],
      chain: null,
      clean: new EvidenceSanitizer([]),
      authority: () => ({
        bindings: {}, check() {}, target: () => ({ status: 'approved' }), label: () => ({ status: 'approved' }), elementIdentity: () => undefined,
        beforeDispatch: async () => {}, dispatching() {}, finished() {},
        assertion(path, result) { receipts.push({ path, verdict: result.verdict }); },
      }),
      created() {}, beforeOpen: async () => {}, opened: async () => {}, beforeClose: async () => {}, closed() {},
      evaluated(result) { verdict = result.verdict; },
    },
  }, fakeDeps(root, driver));
  assert.equal(verdict, 'PASS');
  assert.equal(receipts.length, 6);
  assert.ok(receipts.every(receipt => receipt.verdict === 'PASS'));
  const required = new Set(revision.definition.checks.map(check => check.path));
  const completed = new Set(receipts.map(receipt => receipt.path));
  assert.equal(required.size, 6);
  assert.equal(completed.size, 6);
  assert.deepEqual(completed, required);
});

test('a compact nested repeat cannot publish an unbounded required execution scope', async () => {
  let steps: unknown[] = [{ assertText: 'QA 데모 상점' }];
  for (let depth = 0; depth < 4; depth++) steps = [{ repeat: { times: 10, steps } }];
  const root = tempRoot({
    'tests/expanded.e2e.yaml': JSON.stringify({ name: 'Expanded scope limit', app: 'web-demo', platforms: ['desktop-chrome'], start: 'attach', steps }),
  });
  const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, '.qa', 'generated') });
  const candidate = await store.preview(['tests/expanded.e2e.yaml']);
  assert.ok(candidate.problems.some(problem => problem.code === 'required_scope_limit'));
  assert.ok(candidate.definition.checks.length <= 5000);
  await assert.rejects(store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'fixture-reviewer', channel: 'local-ui' }), { code: 'publication_blocked' });
});

test('reading an earlier revision preserves its original single-declaration denominator', async () => {
  const root = tempRoot({
    'tests/history.e2e.yaml': JSON.stringify({ name: 'Historical repeat fixture', app: 'web-demo', platforms: ['desktop-chrome'], start: 'attach', steps: [{ repeat: { times: 2, steps: [{ assertText: 'QA 데모 상점' }] } }] }),
  });
  const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, '.qa', 'generated') });
  const candidate = await store.preview(['tests/history.e2e.yaml']);
  assert.deepEqual(candidate.problems, []);
  const path = 'steps[0].repeat.steps[0]';
  const check = { ...candidate.definition.checks[0]!, id: `${candidate.definition.tests[0]!.id}:${path}`, path };
  if (candidate.definition.schema !== 'qautra/scenario-definition/v4') assert.fail('Expected a current candidate');
  const { chains: _chains, ...original } = candidate.definition;
  const definition: RevisionPayload = { ...original, schema: 'qautra/scenario-definition/v2', checks: [check] };
  const revisionId = productDigest(definition);
  const historical: PublishedRevision = {
    schema: 'qautra/scenario-revision/v2', revisionId, publishedAt: new Date().toISOString(), definition,
    review: { candidateId: candidate.candidateId, digest: revisionId, checks: [check.id], authority: { principalId: 'historical-fixture-reviewer', channel: 'local-ui', approvedAt: new Date().toISOString() } },
  };
  writeSecure(join(root, '.qa', 'product', 'revisions', `${revisionId}.json`), JSON.stringify(historical));
  const loaded = await store.get(revisionId);
  assert.equal(loaded.revisionId, revisionId);
  assert.equal(loaded.definition.checks.length, 1);
  assert.equal(loaded.definition.checks[0]!.path, path);
  assert.equal(candidate.definition.checks.length, 2);
});
