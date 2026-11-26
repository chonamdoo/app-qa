import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AUTHORING_MODEL, AuthoringJob, type AuthoringProposal, type ProductAuthoringAdapter } from '../../src/core/product-authoring.ts';
import { sha256, writeJsonAtomic } from '../../src/core/fsx.ts';
import { ProductAuthoringService } from '../../src/server/product-authoring.ts';
import { ProductStore, ProductStoreError } from '../../src/server/product-store.ts';

const context = { operatorReview: { principalId: 'local-user', channel: 'local-ui' as const } };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'qautra-authoring-test-'));
  const paths = { root, apps: join(root, 'apps'), uploads: join(root, 'uploads'), generated: join(root, 'generated') };
  mkdirSync(paths.apps); mkdirSync(paths.uploads);
  writeFileSync(join(paths.apps, 'demo.yaml'), JSON.stringify({ id: 'demo', name: 'demo', android: { package: 'com.qa.demo' } }));
  const store = new ProductStore(paths);
  const response = Promise.withResolvers<string>();
  const called = Promise.withResolvers<void>();
  let sends = 0, sent = '', aborted = false;
  const adapter: ProductAuthoringAdapter = {
    async capabilities() { return { provider: 'claude-cli', model: AUTHORING_MODEL, available: true, version: '2.1.316', reason: 'synthetic adapter' }; },
    async interpret(payload, signal, beforeSend) {
      await beforeSend();
      sends++; sent = payload; signal.addEventListener('abort', () => { aborted = true; response.reject(new Error('private provider secret')); }, { once: true });
      called.resolve(); return response.promise;
    },
  };
  const service = new ProductAuthoringService({ ...paths, store, adapter });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const dispatch = async (body: unknown) => AuthoringJob.parse(await service.dispatch(body, context));
  const prepare = async () => {
    const state = await store.update('documents', { revision: 0, name: '원 TC + 가이드', text: 'TC-007: 접수됨\n배송 대기\nResult: {}\n기획 확인 필요 · 국가 조건 충돌' });
    return dispatch({ action: 'prepare', requestID: randomUUID(), selection: { revision: state.revision, app: 'demo', platforms: ['android'], documentIDs: [state.documents[0]!.id] } });
  };
  const start = (job: AuthoringJob, overrides = {}) => dispatch({ action: 'start', requestID: job.requestID, generation: job.generation,
    payloadDigest: job.payloadDigest, provider: 'claude-cli', model: AUTHORING_MODEL, consent: true, ...overrides });
  const settle = async (job: AuthoringJob) => {
    await service.drain();
    return dispatch({ action: 'status', requestID: job.requestID });
  };
  const proposal = (job: AuthoringJob): AuthoringProposal => ({ name: '주문 상태', steps: [{ assertText: 'TC-007: 접수됨' }, { assertText: '배송 대기' }],
    expectations: [{ documentID: job.payload.documents[0]!.document.id, segmentID: 'line:1', quote: 'TC-007: 접수됨', checkIndex: 0 },
      { documentID: job.payload.documents[0]!.document.id, segmentID: 'line:2', quote: '배송 대기', checkIndex: 1 }],
    issues: [{ code: 'scope_conflict', locator: 'line:4', message: '국가 조건 충돌 · 기획 확인 필요' }] });
  return { root, paths, store, service, dispatch, prepare, start, settle, proposal, response, called,
    sends: () => sends, sent: () => sent, aborted: () => aborted };
}

test('exact current payload consent is required and cannot be replayed for another generation or principal', async t => {
  const f = fixture(t); const job = await f.prepare();
  assert.equal(f.sends(), 0); assert.equal(job.consent, null);
  assert.equal(sha256(job.transmittedPayload), job.payloadDigest);
  assert.deepEqual(JSON.parse(job.transmittedPayload), job.payload);
  await assert.rejects(f.service.dispatch({ action: 'status', requestID: job.requestID }), (error: unknown) => error instanceof ProductStoreError && error.status === 403);
  await assert.rejects(f.start(job, { consent: false }), (error: unknown) => error instanceof ProductStoreError && error.status === 400);
  await assert.rejects(f.start(job, { generation: randomUUID() }), (error: unknown) => error instanceof ProductStoreError && error.status === 409);
  await assert.rejects(f.start(job, { payloadDigest: '0'.repeat(64) }), (error: unknown) => error instanceof ProductStoreError && error.status === 409);
  await assert.rejects(f.service.dispatch({ action: 'status', requestID: job.requestID }, { operatorReview: { channel: 'local-ui', principalId: 'other-user' } }), (error: unknown) => error instanceof ProductStoreError && error.status === 403);
  await f.dispatch({ action: 'revoke', requestID: job.requestID });
  assert.equal((await f.start(job)).status, 'cancelled'); assert.equal(f.sends(), 0);
});

test('duplicate request IDs never retransmit, changed content conflicts, and restart remains explicitly uncertain', async t => {
  const f = fixture(t); const job = await f.prepare();
  const repeated = await f.dispatch({ action: 'prepare', requestID: job.requestID, selection: job.payload.selection });
  assert.equal(repeated.generation, job.generation);
  await assert.rejects(f.dispatch({ action: 'prepare', requestID: job.requestID, selection: { ...job.payload.selection, app: 'other' } }), (error: unknown) => error instanceof ProductStoreError && error.status === 409);
  await f.start(job); await f.called.promise;
  await f.start(job); assert.equal(f.sends(), 1); assert.equal(f.sent(), job.transmittedPayload);
  const restarted = new ProductAuthoringService({ ...f.paths, store: f.store });
  const recovered = AuthoringJob.parse(await restarted.dispatch({ action: 'status', requestID: job.requestID }, context));
  assert.equal(recovered.status, 'uncertain');
  assert.equal((await f.start(job)).status, 'uncertain'); assert.equal(f.sends(), 1);
  f.response.resolve(JSON.stringify(f.proposal(job)));
  assert.equal((await f.settle(job)).status, 'uncertain');
});

test('source bytes or workspace revision drift blocks sends and draft application', async t => {
  const f = fixture(t); const job = await f.prepare(); const doc = job.payload.documents[0]!.document;
  const bytes = readFileSync(doc.path); writeFileSync(doc.path, 'changed');
  await assert.rejects(f.start(job), (error: unknown) => error instanceof ProductStoreError && error.status === 409);
  assert.equal(f.sends(), 0); writeFileSync(doc.path, bytes);
  await f.start(job); await f.called.promise; f.response.resolve(JSON.stringify(f.proposal(job)));
  await f.settle(job);
  const state = await f.store.read(); await f.store.update('documents', { revision: state.revision, name: '추가 가이드', text: '새 조건' });
  await assert.rejects(f.dispatch({ action: 'apply', requestID: job.requestID, generation: job.generation, payloadDigest: job.payloadDigest }), (error: unknown) => error instanceof ProductStoreError && error.status === 409);
  assert.equal((await f.store.read()).scenarios.length, 0);
});

test('independent expectations and issues become a usable unreviewed draft without AI authority', async t => {
  const f = fixture(t); const job = await f.prepare(); await f.start(job); await f.called.promise;
  const proposed = f.proposal(job); f.response.resolve(JSON.stringify(proposed));
  const ready = await f.settle(job); assert.equal(ready.status, 'proposed');
  const applied = await f.dispatch({ action: 'apply', requestID: job.requestID, generation: job.generation, payloadDigest: job.payloadDigest });
  assert.equal(applied.status, 'applied');
  const state = await f.store.read(); const draft = state.scenarios[0]!;
  assert.equal(draft.id, applied.scenarioID); assert.deepEqual(draft.definition!.steps, proposed.steps);
  assert.equal(draft.review, null); assert.equal(draft.source!.reviewed, false); assert.equal(draft.executable, false);
  assert.equal(draft.source!.mappings.length, 4); assert.ok(draft.source!.mappings.every(mapping => mapping.disposition === 'unsupported'));
  assert.ok(draft.source!.notes.includes('TC-007: 접수됨')); assert.ok(draft.source!.notes.includes('배송 대기'));
  assert.ok(draft.source!.notes.includes('scope_conflict')); assert.ok(draft.problems.some(problem => problem.code === 'source_review_required'));
  assert.equal(draft.source!.resolutions, undefined); assert.equal(draft.definition!.source, undefined);
  assert.equal((await f.dispatch({ action: 'apply', requestID: job.requestID, generation: job.generation, payloadDigest: job.payloadDigest })).scenarioID, draft.id);
  assert.equal((await f.store.read()).scenarios.length, 1);
  const recreated = new ProductAuthoringService({ ...f.paths, store: f.store });
  assert.equal(AuthoringJob.parse(await recreated.dispatch({ action: 'status', requestID: job.requestID }, context)).status, 'applied');
  writeJsonAtomic(join(f.root, '.qa', 'product', 'authoring', `${job.requestID}.json`), { ...applied, status: 'applying', scenarioID: null });
  const reconciled = AuthoringJob.parse(await recreated.dispatch({ action: 'apply', requestID: job.requestID,
    generation: job.generation, payloadDigest: job.payloadDigest }, context));
  assert.equal(reconciled.status, 'applied'); assert.equal(reconciled.scenarioID, draft.id);
  assert.equal((await f.store.read()).scenarios.length, 1); assert.equal(f.sends(), 1);
});

for (const invalid of ['authority', 'prefix', 'merged', 'unknown-field', 'partial'] as const) {
  test(`whole invalid proposal is rejected without partial import: ${invalid}`, async t => {
    const f = fixture(t); const job = await f.prepare(); const proposal: Record<string, unknown> = f.proposal(job);
    if (invalid === 'authority') proposal.steps = [{ tap: { id: 'delete' }, allowRisky: true }];
    if (invalid === 'prefix') proposal.steps = [{ assertText: '접수됨' }, { assertText: '배송 대기' }];
    if (invalid === 'merged') proposal.expectations = f.proposal(job).expectations.map(row => ({ ...row, checkIndex: 0 }));
    if (invalid === 'unknown-field') proposal.reviewed = true;
    await f.start(job); await f.called.promise;
    f.response.resolve(invalid === 'partial' ? JSON.stringify(proposal).slice(0, -2) : JSON.stringify(proposal));
    assert.equal((await f.settle(job)).status, 'failed');
    assert.equal((await f.store.read()).scenarios.length, 0); assert.equal(f.sends(), 1);
  });
}

test('cancellation aborts owned work, preserves disclosure warning, and never exposes raw errors', async t => {
  const f = fixture(t); const job = await f.prepare(); await f.start(job); await f.called.promise;
  const cancelled = await f.dispatch({ action: 'cancel', requestID: job.requestID });
  assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.consent!.revokedAt); assert.ok(f.aborted());
  assert.ok(cancelled.problem!.includes('회수할 수 없습니다')); assert.ok(!JSON.stringify(cancelled).includes('private provider secret'));
  assert.equal((await f.start(job)).status, 'cancelled'); assert.equal(f.sends(), 1);
});

test('disabled authoring connection blocks sends while manual catalog work remains available', async t => {
  const f = fixture(t); const job = await f.prepare();
  const state = await f.store.read();
  await f.store.update('settings', { revision: state.revision, settings: { ...state.settings, claudeEnabled: false } });
  await assert.rejects(f.start(job), (error: unknown) => error instanceof ProductStoreError && error.status === 403);
  assert.equal(f.sends(), 0);
  const disconnected = new ProductAuthoringService({ ...f.paths, store: f.store });
  const capability = await disconnected.dispatch({ action: 'capabilities' }, context) as { available: boolean };
  assert.equal(capability.available, false);
  const current = await f.store.read();
  const saved = await f.store.update('scenarios', { revision: current.revision,
    definition: { name: '수동 원문 검토', app: 'demo', platforms: ['android'], steps: [{ assertText: '배송 대기' }] },
    source: { documentIDs: job.payload.selection.documentIDs, notes: '', mappings: [], reviewed: false } });
  assert.equal(saved.scenarios.length, 1);
});

test('payload byte bounds reject the whole selection before any send', async t => {
  const f = fixture(t);
  const state = await f.store.update('documents', { revision: 0, name: '큰 원문', text: 'a'.repeat(600_000) });
  await assert.rejects(f.dispatch({ action: 'prepare', requestID: randomUUID(), selection: {
    revision: state.revision, app: 'demo', platforms: ['android'], documentIDs: [state.documents[0]!.id],
  } }), (error: unknown) => error instanceof ProductStoreError && error.status === 413);
  assert.equal(f.sends(), 0);
});
