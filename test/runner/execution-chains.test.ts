import assert from 'node:assert/strict';
import { join } from 'node:path';
import { it } from 'node:test';
import { AgentExecutionError } from '../../src/core/agent.ts';
import type { FrozenSessionAuthority } from '../../src/runner/engine.ts';
import type { ExecutionChain } from '../../src/core/execution-chain.ts';
import { runTests } from '../../src/runner/index.ts';
import { createRevisionStore, frozenLoadedTest } from '../../src/runner/revisions.ts';
import { EvidenceSanitizer } from '../../src/runner/sanitize.ts';
import { FakeDriver, fixtureSnapshot } from '../helpers/fake-driver.ts';
import { fakeDeps, tempRoot } from '../helpers/run.ts';

const helpText = '검색창에 상품 이름을 입력하고 검색을 누르세요.';
const chain: ExecutionChain = { id: 'help-flow', members: ['first', 'following'] };
function fixture(first: Record<string, unknown> = {}, following: Record<string, unknown> = {}) {
  const root = tempRoot({
    'apps/chain.yaml': JSON.stringify({ id: 'chain', name: 'Stateful browser', web: { url: 'http://localhost:4173/', platforms: ['desktop-chrome', 'desktop-safari'] } }),
    'tests/first.e2e.yaml': JSON.stringify({ id: 'first', name: 'Open help', app: 'chain', platforms: ['desktop-chrome'], reset: 'none', steps: [{ tap: { id: 'help-open' } }, { assertText: helpText }], ...first }),
    'tests/following.e2e.yaml': JSON.stringify({ id: 'following', name: 'Verify retained help', app: 'chain', platforms: ['desktop-chrome'], start: 'attach', reset: 'none', steps: [{ assertText: helpText }], ...following }),
  });
  const store = createRevisionStore({ root, appsDir: join(root, 'apps'), generatedDir: join(root, '.qa', 'generated') });
  return { root, store, paths: ['tests/first.e2e.yaml', 'tests/following.e2e.yaml'] };
}

async function execute(first: Record<string, unknown> = {}, following: Record<string, unknown> = {}, scoped: Partial<FrozenSessionAuthority> = {}) {
  const f = fixture(first, following);
  const candidate = await f.store.preview(f.paths, [chain]);
  assert.deepEqual(candidate.problems, []);
  const revision = await f.store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'chain-test-operator', channel: 'local-ui' });
  const initial = fixtureSnapshot('desktop-chrome', 'web-demo', 'index');
  const driver = new FakeDriver(initial);
  driver.onAction = method => { if (method === 'launch') driver.screen = initial; };
  driver.onTap = () => fixtureSnapshot('desktop-chrome', 'web-demo', 'index-help');
  const receipts: { testId: string; path: string; verdict: string }[] = [];
  const result = await runTests({
    paths: [], platform: 'desktop-chrome', deviceIds: { 'desktop-chrome': driver.deviceId },
    frozen: {
      ownerId: 'chain-test-owner', tests: revision.definition.tests.map(frozenLoadedTest), chain, clean: new EvidenceSanitizer([]),
      authority: testId => ({
        bindings: {}, check() {}, target: () => ({ status: 'approved' }), label: () => ({ status: 'approved' }), elementIdentity: () => undefined,
        beforeDispatch: async () => {}, dispatching() {}, finished() {},
        assertion(path, result) { receipts.push({ testId, path, verdict: result.verdict }); },
        ...scoped,
      }),
      created() {}, beforeOpen: async () => {}, opened: async () => {}, evaluated() {}, beforeClose: async () => {}, closed() {},
    },
  }, fakeDeps(f.root, driver));
  return { ...f, result, driver, receipts, revision };
}

it('retains the actual browser state between logical TCs without relaunching or refreshing', async () => {
  const { result, driver, receipts } = await execute();
  assert.deepEqual(result.tests.map(test => [test.id, test.verdict]), [['first', 'PASS'], ['following', 'PASS']]);
  assert.deepEqual(receipts.map(receipt => [receipt.testId, receipt.verdict]), [['first', 'PASS'], ['following', 'PASS']]);
  assert.equal(driver.called('open').length, 1);
  assert.equal(driver.called('launch').length, 1);
  assert.equal(driver.called('close').length, 1);
  assert.equal(driver.called('tap').length, 1);
});

it('blocks a follower mutation after an observed predecessor failure instead of preparing a new session', async () => {
  const { result, driver, receipts } = await execute({ steps: [{ assertText: 'missing predecessor state' }] }, { steps: [{ tap: { id: 'help-open' } }, { assertText: helpText }] });
  assert.equal(result.tests[0]!.verdict, 'FAIL');
  assert.equal(result.tests[1]!.qaStatus, 'BLOCKED');
  assert.equal(result.tests[1]!.code, 'chain_predecessor_failed');
  assert.deepEqual(receipts.map(receipt => [receipt.testId, receipt.verdict]), [['first', 'FAIL']]);
  assert.equal(driver.called('tap').length, 0);
  assert.equal(driver.called('open').length, 1);
});

it('does not pass predecessor teardown failure into a state-dependent follower', async () => {
  const { result, driver } = await execute({ steps: [{ assertText: 'QA 데모 상점' }], teardown: [{ assertText: 'missing teardown state' }] }, { steps: [{ tap: { id: 'help-open' } }, { assertText: helpText }] });
  assert.equal(result.tests[0]!.verdict, 'PASS');
  assert.ok(result.tests[0]!.steps.some(step => step.phase === 'teardown' && step.verdict === 'FAIL'));
  assert.equal(result.tests[1]!.code, 'chain_predecessor_failed');
  assert.equal(driver.called('tap').length, 0);
});

it('releases the dispatch preparation of an approval that ends without a dispatch', async () => {
  const calls: string[] = [];
  const { driver } = await execute({}, {}, {
    prepare: async () => { calls.push('prepare'); },
    release: () => { calls.push('release'); },
    target: () => ({ status: 'blocked_by_policy', reason: 'test refusal' }),
  });
  assert.equal(driver.called('tap').length, 0);
  assert.ok(calls.length >= 2 && calls.length % 2 === 0, calls.join());
  for (let index = 0; index < calls.length; index += 2) assert.deepEqual(calls.slice(index, index + 2), ['prepare', 'release']);
});

it('rejects an omitted predecessor without loading its source or silently adding its actions', async () => {
  const { store } = fixture();
  const candidate = await store.preview(['tests/following.e2e.yaml'], [chain]);
  assert.ok(candidate.problems.some(problem => problem.code === 'chain_members_missing'));
  assert.deepEqual(candidate.definition.tests.map(test => test.id), ['following']);
  await assert.rejects(store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'chain-test-operator', channel: 'local-ui' }), (error: unknown) => error instanceof AgentExecutionError && error.code === 'publication_blocked');
});

const rejected: [string, Record<string, unknown>, ExecutionChain[], string][] = [
  ['implicit follower relaunch', { start: 'launch' }, [chain], 'chain_implicit_restart_refused'],
  ['different actual target set', { platforms: ['desktop-safari'] }, [chain], 'chain_resource_scope_mismatch'],
  ['overlapping membership', {}, [chain, { id: 'second-chain', members: ['first', 'following'] }], 'overlapping_execution_chains'],
  ['duplicate chain identity', {}, [chain, chain], 'duplicate_chain_identity'],
];
for (const [name, following, chains, code] of rejected) it(`rejects ${name} before publication`, async () => {
  const { store, paths } = fixture({}, following);
  const candidate = await store.preview(paths, chains);
  assert.ok(candidate.problems.some(problem => problem.code === code));
  await assert.rejects(store.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'chain-test-operator', channel: 'local-ui' }), (error: unknown) => error instanceof AgentExecutionError && error.code === 'publication_blocked');
});
