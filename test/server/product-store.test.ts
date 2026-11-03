import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'yaml';
import { AgentExecutionError } from '../../src/core/agent.ts';
import type { RevisionCandidate, ScenarioOrigin } from '../../src/core/regression.ts';
import { ProductSourceManifest, SCENARIO_NOTES_DOCUMENT_ID, validateProductSourceManifest, type ScenarioSource } from '../../src/core/product.ts';
import { sha256 } from '../../src/core/fsx.ts';
import { ingestSourceLedger } from '../../src/plan/ingest.ts';
import { ProductStore, ProductStoreError } from '../../src/server/product-store.ts';
import { TestSpec } from '../../src/spec/schema.ts';
import { createRevisionStore } from '../../src/runner/revisions.ts';
import { createRegressionService } from '../../src/runner/regression.ts';
import { zipStore } from '../plan/helpers.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'qautra-product-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { root, apps: join(root, 'apps'), uploads: join(root, 'uploads'), generated: join(root, 'generated') };
  mkdirSync(paths.apps); mkdirSync(paths.uploads);
  writeFileSync(join(paths.apps, 'demo.yaml'), JSON.stringify({ id: 'demo', name: '테스트 앱', android: { package: 'com.qa.demo' } }));
  return { root, paths, store: new ProductStore(paths, { ingestSource: ingestSourceLedger }) };
}

const reviewer = { reviewer: { principalId: 'local-user', channel: 'local-ui' as const } };
const definition = TestSpec.parse({ id: 'TC-007', name: '주문 상태 확인', app: 'demo', platforms: ['android'], reset: 'none',
  steps: [{ tap: { id: 'orders' }, expectNoChange: true }, { assertText: '접수됨' }, { assertText: '배송 대기' }] });
function mapped(documentID: string): ScenarioSource {
  return { documentIDs: [documentID], notes: '', reviewed: false, mappings: [
    { documentID, segmentID: 'line:1', disposition: 'mapped', stepPaths: ['steps[0]'], checkPaths: [], reason: '', role: 'step', logicalCaseID: 'order-state', originalCaseID: 'TC-007' },
    { documentID, segmentID: 'line:2', disposition: 'mapped', stepPaths: [], checkPaths: ['steps[1]'], reason: '', role: 'expected' },
    { documentID, segmentID: 'line:3', disposition: 'mapped', stepPaths: [], checkPaths: ['steps[2]'], reason: '', role: 'expected' },
  ] };
}

test('ordinary QA definition and each original expectation round-trip without generated assertions', async t => {
  const { store } = fixture(t);
  let state = await store.update('documents', { revision: 0, name: '원 TC', text: '주문 목록 열기\n접수됨\n배송 대기' });
  const doc = state.documents[0]!;
  const source = mapped(doc.id);
  source.reviewed = true;
  state = await store.update('scenarios', { revision: state.revision, definition, source }, reviewer);
  const scenario = state.scenarios[0]!;
  assert.deepEqual(scenario.definition, definition);
  assert.deepEqual(scenario.source, source);
  assert.equal(scenario.executable, true);
  assert.equal(scenario.review?.digest, scenario.digest);
  assert.deepEqual((await store.read()).scenarios[0], scenario);
  const artifact = TestSpec.parse(parse(readFileSync(scenario.path, 'utf8')));
  assert.deepEqual(artifact.steps, definition.steps);
  assert.equal(artifact.source?.status, 'draft');
  const manifest = ProductSourceManifest.parse(JSON.parse(readFileSync(scenario.manifestPath!, 'utf8')));
  assert.deepEqual(validateProductSourceManifest(manifest, [{ path: doc.path, sha256: sha256(readFileSync(doc.path)) }], artifact), []);
  assert.equal(manifest.source.mappings[0]!.originalCaseID, 'TC-007');
});

test('missing scope, duplicate mappings, reused checks, unsupported scope and empty checks never qualify', async t => {
  const { store } = fixture(t);
  const state = await store.update('documents', { revision: 0, name: '원문', text: '주문 목록 열기\n접수됨\n배송 대기' });
  const base = mapped(state.documents[0]!.id);
  const cases: [ScenarioSource, string][] = [];
  const omitted = structuredClone(base); omitted.mappings.pop(); cases.push([omitted, 'source_scope_unmapped']);
  const duplicate = structuredClone(base); duplicate.mappings.push(duplicate.mappings[1]!); cases.push([duplicate, 'source_mapping_duplicate']);
  const reused = structuredClone(base); reused.mappings[2]!.checkPaths = ['steps[1]']; cases.push([reused, 'source_expectation_check_reused']);
  const unsupported = structuredClone(base); unsupported.mappings[2]!.disposition = 'unsupported'; cases.push([unsupported, 'source_unsupported']);
  let revision = state.revision;
  for (const [source, code] of cases) {
    source.reviewed = true;
    const saved = await store.update('scenarios', { revision, definition, source }, reviewer);
    revision = saved.revision;
    assert.equal(saved.scenarios.at(-1)!.executable, false);
    assert.ok(saved.scenarios.at(-1)!.problems.some(problem => problem.code === code), code);
  }
  const saved = await store.update('scenarios', { revision, definition: { ...definition, steps: [{ capture: 'evidence' }] }, source: { ...base, reviewed: true } }, reviewer);
  assert.ok(saved.scenarios.at(-1)!.problems.some(problem => problem.code === 'required_checks_empty'));
});

test('review is trusted-context-only and a definition edit does not inherit an earlier review', async t => {
  const { store } = fixture(t);
  let state = await store.update('documents', { revision: 0, name: 'TC', text: '주문 목록 열기\n접수됨\n배송 대기' });
  const source = mapped(state.documents[0]!.id); source.reviewed = true;
  await assert.rejects(store.update('scenarios', { revision: state.revision, definition, source }), error => error instanceof ProductStoreError && error.status === 403);
  state = await store.update('scenarios', { revision: state.revision, definition, source }, reviewer);
  const previous = state.scenarios[0]!;
  const oldManifest = readFileSync(previous.manifestPath!, 'utf8');
  const changed = { ...definition, steps: [definition.steps[0]!, { assertText: '거절됨' }, definition.steps[2]!] };
  state = await store.update('scenarios', { revision: state.revision, id: previous.id, definition: changed, source: { ...source, reviewed: false } });
  assert.equal(state.scenarios[0]!.review, null);
  assert.equal(state.scenarios[0]!.executable, false);
  assert.notEqual(state.scenarios[0]!.digest, previous.digest);
  assert.equal(readFileSync(previous.manifestPath!, 'utf8'), oldManifest);
  const old = ProductSourceManifest.parse(JSON.parse(oldManifest));
  assert.ok(validateProductSourceManifest(old, old.documents, TestSpec.parse(changed)).some(problem => problem.code === 'source_definition_changed'));
});

test('published source trace survives a same-ID draft edit and removal of mutable originals', async t => {
  const { store, root, paths } = fixture(t);
  let state = await store.update('documents', { revision: 0, name: '원 주문 TC', text: '주문 목록 열기\n접수됨\n배송 대기' });
  const document = state.documents[0]!;
  const source = { ...mapped(document.id), reviewed: true };
  state = await store.update('scenarios', { revision: state.revision, definition, source }, reviewer);
  const previous = state.scenarios[0]!;
  const manifest = ProductSourceManifest.parse(JSON.parse(readFileSync(previous.manifestPath!, 'utf8')));
  const revisions = createRevisionStore({ root, appsDir: paths.apps, generatedDir: paths.generated });
  const candidate = await revisions.preview([previous.path]);
  assert.deepEqual(candidate.problems, []);
  const published = await revisions.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), { principalId: 'local-user', channel: 'local-ui' });
  const publicationPath = join(root, '.qa', 'product', 'revisions', `${published.revisionId}.json`);
  const publicationBytes = readFileSync(publicationPath);
  state = await store.update('scenarios', { revision: state.revision, id: previous.id,
    definition: { ...definition, name: '새 미검토 초안', steps: [definition.steps[0]!, { assertText: '취소됨' }, definition.steps[2]!] },
    source: { ...source, reviewed: false } });
  const changed = state.scenarios[0]!;
  assert.equal(changed.id, previous.id);
  assert.notEqual(changed.path, previous.path);
  assert.equal(changed.executable, false);
  assert.equal(changed.review, null);
  writeFileSync(document.path, '나중에 변경된 원문');
  rmSync(previous.path);
  rmSync(previous.manifestPath!);
  const origin = await revisions.origin(published.revisionId, definition.id!);
  assert.equal(origin.availability, 'verified');
  if (origin.availability !== 'verified') assert.fail('Original captured source is required');
  assert.deepEqual(origin.manifest, manifest);
  assert.equal(origin.manifest.scenarioID, changed.id);
  assert.equal(origin.manifest.definition.name, definition.name);
  assert.equal(origin.manifest.documents[0]!.segments[1]!.text, '접수됨');
  assert.deepEqual(await revisions.get(published.revisionId), published);
  assert.deepEqual(readFileSync(publicationPath), publicationBytes);
  await assert.rejects(revisions.origin(published.revisionId, 'other-TC'), error => error instanceof AgentExecutionError && error.code === 'source_test_not_found');
  writeFileSync(join(root, '.qa', 'product', 'blobs', origin.manifestSha256), '{}');
  await assert.rejects(revisions.origin(published.revisionId, definition.id!), error => error instanceof AgentExecutionError && error.code === 'revision_corrupt');
});

test('raw original-source reads require local review authority, not an agent request field', async t => {
  const { root, paths } = fixture(t);
  const service = createRegressionService({ root, appsDir: paths.apps, generatedDir: paths.generated, supportsTarget: () => true,
    execute: async () => { throw new Error('An original-source read must not execute QA'); } });
  try {
    writeFileSync(join(root, 'ordinary.e2e.yaml'), JSON.stringify(definition));
    const candidate = await service.call({ method: 'scenario.preview', paths: ['ordinary.e2e.yaml'] }) as RevisionCandidate;
    const published = await service.call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest,
      reviewedChecks: candidate.definition.checks.map(check => check.id) }, { operatorReview: { principalId: 'local-user', channel: 'local-ui' } }) as { revisionId: string };
    const request = { method: 'scenario.origin' as const, revisionId: published.revisionId, testId: definition.id! };
    await assert.rejects(service.call(request), error => error instanceof AgentExecutionError && error.code === 'operator_review_required');
    const forged = { ...request, operatorReview: { principalId: 'pretend-local-user', channel: 'local-ui' } };
    await assert.rejects(service.call(forged), error => error instanceof AgentExecutionError && error.code === 'invalid_request');
    const origin = await service.call(request, { operatorReview: { principalId: 'local-user', channel: 'local-ui' } }) as ScenarioOrigin;
    assert.equal(origin.availability, 'not-captured');
    assert.equal(origin.manifest, null);
    assert.deepEqual(await service.call({ method: 'regression.list' }), []);
  } finally { await service.shutdown(); }
});

test('frozen source bytes are preserved and changed source bytes cannot qualify', async t => {
  const { store, paths } = fixture(t);
  const upload = join(paths.uploads, 'tc.txt');
  writeFileSync(upload, '주문 목록 열기\n접수됨\n배송 대기');
  let state = await store.update('documents', { revision: 0, name: '업로드 원문', path: upload });
  const doc = state.documents[0]!;
  writeFileSync(upload, '업로드 이후 변경');
  assert.equal(readFileSync(doc.path, 'utf8'), '주문 목록 열기\n접수됨\n배송 대기');
  state = await store.update('scenarios', { revision: state.revision, definition, source: { ...mapped(doc.id), reviewed: true } }, reviewer);
  const manifest = JSON.parse(readFileSync(state.scenarios[0]!.manifestPath!, 'utf8'));
  assert.ok(validateProductSourceManifest(manifest, [{ path: doc.path, sha256: sha256('다른 bytes') }]).some(problem => problem.code === 'source_bytes_unverified'));
  writeFileSync(doc.path, '변경된 보관 원문');
  await assert.rejects(store.update('scenarios', { revision: state.revision, definition, source: mapped(doc.id) }), error => error instanceof ProductStoreError && error.status === 409);
});

test('CAS conflict and out-of-bound upload do not register a document or scenario', async t => {
  const { store, root, paths } = fixture(t);
  const outside = join(root, 'outside.txt'); writeFileSync(outside, '외부 원문');
  const link = join(paths.uploads, 'link.txt'); symlinkSync(outside, link);
  await assert.rejects(store.update('documents', { revision: 0, name: '외부', path: link }), error => error instanceof ProductStoreError && error.status === 400);
  await store.update('documents', { revision: 0, name: '실제 원문', text: '기대값' });
  await assert.rejects(store.update('documents', { revision: 0, name: '오래된 저장', text: '기대값' }), error => error instanceof ProductStoreError && error.status === 409);
  assert.equal((await store.read()).documents.length, 1);
});

test('notes-only manual source has exact bytes, stable locators and explicit mapping requirements', async t => {
  const { store } = fixture(t);
  const source = mapped(SCENARIO_NOTES_DOCUMENT_ID);
  source.notes = '주문 목록 열기\n접수됨\n배송 대기'; source.reviewed = true;
  const state = await store.update('scenarios', { revision: 0, definition, source }, reviewer);
  const manifest = ProductSourceManifest.parse(JSON.parse(readFileSync(state.scenarios[0]!.manifestPath!, 'utf8')));
  assert.equal(state.scenarios[0]!.executable, true);
  assert.equal(manifest.documents[0]!.sha256, sha256(source.notes));
  assert.equal(readFileSync(manifest.documents[0]!.path, 'utf8'), source.notes);
  assert.deepEqual(manifest.documents[0]!.segments.map(segment => segment.locator), ['line:1', 'line:2', 'line:3']);
});

test('legacy catalog and approved artifacts remain byte-identical and read-only after v2 writes', async t => {
  const { store, root } = fixture(t);
  const directory = join(root, '.qa', 'product'); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'original.e2e.yaml');
  const artifact = 'name: legacy\nsource: {plan: old.json, status: approved}\n'; writeFileSync(path, artifact);
  const defaults = (await store.read()).settings;
  const row = { id: randomUUID(), name: '과거 TC', expected: '기존 단일 expected', requirementID: 'old#TC1', app: 'demo', platforms: ['android'], createdAt: '2026-01-01T00:00:00.000Z', path };
  const catalog = JSON.stringify({ schema: 'qautra/workspace/v1', revision: 3, scenarios: [row], documents: [], environments: [], settings: { ...defaults, totalLimit: 5 } });
  writeFileSync(join(directory, 'catalog.json'), catalog);
  let state = await store.read();
  assert.equal(state.scenarios[0]!.executable, false);
  assert.deepEqual(state.scenarios[0]!.legacy, row);
  assert.equal(state.scenarios[0]!.definition, null);
  assert.equal(state.settings.totalLimit, 1);
  await assert.rejects(store.update('scenarios', { revision: 3, id: row.id, definition, source: mapped(randomUUID()) }), error => error instanceof ProductStoreError && error.status === 409);
  state = await store.update('documents', { revision: 3, name: '새 원문', text: '새 기대값' });
  assert.equal(state.schema, 'qautra/workspace/v2');
  assert.equal(readFileSync(join(directory, 'catalog.json'), 'utf8'), catalog);
  assert.equal(readFileSync(path, 'utf8'), artifact);
  assert.deepEqual((await store.read()).scenarios[0]!.legacy, row);
});

test('settings default to one flow and reject unsupported ceilings while retention remains a preference', async t => {
  const { store } = fixture(t);
  let state = await store.read();
  assert.deepEqual([state.settings.webLimit, state.settings.androidLimit, state.settings.iosLimit, state.settings.totalLimit], [1, 1, 1, 1]);
  await assert.rejects(store.update('settings', { revision: 0, settings: { ...state.settings, totalLimit: 2 } }), error => error instanceof ProductStoreError && error.status === 400);
  state = await store.update('settings', { revision: 0, settings: { ...state.settings, retentionDays: 30 } });
  assert.equal(state.support.retention, 'preference-only-no-automatic-deletion');
});

test('historical Result remains source-only reference, never a new business result', async t => {
  const { store } = fixture(t);
  const state = await store.update('documents', { revision: 0, name: '원 TC와 과거 결과', text: '주문 목록 열기\n접수됨\n배송 대기\n과거 Result: FAIL' });
  const source = mapped(state.documents[0]!.id);
  source.reviewed = true;
  source.mappings.push({ documentID: state.documents[0]!.id, segmentID: 'line:4', disposition: 'reference',
    role: 'history', reason: '이전 수동 QA의 결과이며 새 실행 결과가 아님', stepPaths: [], checkPaths: [] });
  const saved = await store.update('scenarios', { revision: state.revision, definition, source }, reviewer);
  assert.equal(saved.scenarios[0]!.executable, true);
  assert.deepEqual(saved.scenarios[0]!.definition?.steps, definition.steps);
  assert.equal(saved.documents[0]!.segments[3]!.text, '과거 Result: FAIL');
  const weakened = structuredClone(source);
  weakened.mappings[2] = { ...weakened.mappings[2]!, disposition: 'reference', reason: '기대값을 참고로 처리' };
  const rejected = await store.update('scenarios', { revision: saved.revision, definition, source: weakened }, reviewer);
  assert.equal(rejected.scenarios.at(-1)!.executable, false);
  assert.ok(rejected.scenarios.at(-1)!.problems.some(problem => problem.code === 'source_reference_unqualified'));
});

test('an unavailable parser preserves uploaded bytes and unresolved locations instead of inventing content', async t => {
  const { paths } = fixture(t);
  const store = new ProductStore(paths);
  const upload = join(paths.uploads, 'unreadable.pdf');
  const bytes = Buffer.from('%PDF original source without a connected parser');
  writeFileSync(upload, bytes);
  const state = await store.update('documents', { revision: 0, name: '임의 문서', path: upload });
  assert.deepEqual(readFileSync(state.documents[0]!.path), bytes);
  assert.equal(state.documents[0]!.sha256, sha256(bytes));
  assert.equal(state.documents[0]!.segments[0]!.locator, 'file');
  assert.equal(state.documents[0]!.segments[0]!.text, '');
  assert.ok(state.documents[0]!.issues.some(problem => problem.code === 'source_parser_unavailable'));
});

test('FIFO intake rejects before an owned rescue writer and releases the catalog lock', async t => {
  const { store, paths } = fixture(t);
  const fifo = join(paths.uploads, 'waiting.txt');
  execFileSync('mkfifo', [fifo]);
  let rescue: number | undefined;
  // The rescue uses the platform clock because fake timers cannot release a kernel-blocked FIFO open.
  const timer = setTimeout(() => { rescue = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK); }, 1000);
  try {
    await assert.rejects(store.update('documents', { revision: 0, name: 'FIFO', path: fifo }),
      error => error instanceof ProductStoreError && error.status === 400);
    assert.equal(rescue, undefined, 'A nonregular upload must reject without waiting for a writer');
    const state = await store.update('documents', { revision: 0, name: '다음 입력', text: '읽을 수 있는 원문' });
    assert.equal(state.revision, 1);
    assert.equal(state.documents.length, 1);
    assert.equal(state.documents[0]!.segments[0]!.text, '읽을 수 있는 원문');
  } finally { clearTimeout(timer); if (rescue !== undefined) closeSync(rescue); }
});

for (const mode of ['same-length mutation', 'same-length replacement', 'parent replacement', 'transient boundary swap']) {
  test(`intake refuses real ${mode} in an isolated process`, t => {
    const { root, paths } = fixture(t);
    const parent = mode === 'parent replacement' ? join(paths.uploads, 'nested') : paths.uploads;
    if (parent !== paths.uploads) mkdirSync(parent);
    const target = join(parent, 'race.txt');
    const outside = join(root, 'external');
    mkdirSync(outside);
    writeFileSync(target, 'old');
    writeFileSync(join(outside, 'race.txt'), 'new');
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { ProductStore, ProductStoreError } from ${JSON.stringify(new URL('../../src/server/product-store.ts', import.meta.url).href)};
      const paths = ${JSON.stringify(paths)};
      const target = fs.realpathSync(${JSON.stringify(target)});
      const parent = ${JSON.stringify(parent)};
      const mode = ${JSON.stringify(mode)};
      const originalOpen = fsp.open;
      let changed = false;
      fsp.open = async (path, ...args) => {
        if (path !== target || changed) return originalOpen(path, ...args);
        if (mode === 'transient boundary swap') {
          changed = true;
          fs.renameSync(paths.uploads, paths.uploads + '.previous');
          fs.symlinkSync(${JSON.stringify(outside)}, paths.uploads);
          try { return await originalOpen(path, ...args); }
          finally { fs.unlinkSync(paths.uploads); fs.renameSync(paths.uploads + '.previous', paths.uploads); }
        }
        const handle = await originalOpen(path, ...args);
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!changed) {
            changed = true;
            if (mode === 'same-length mutation') {
              const before = fs.statSync(target);
              fs.writeFileSync(target, 'new');
              fs.utimesSync(target, before.atime, before.mtime);
            } else if (mode === 'same-length replacement') {
              fs.writeFileSync(target + '.replacement', 'new');
              fs.renameSync(target + '.replacement', target);
            } else {
              fs.renameSync(parent, parent + '.previous');
              fs.mkdirSync(parent);
              fs.writeFileSync(target, 'new');
            }
          }
          return result;
        };
        return handle;
      };
      syncBuiltinESMExports();
      const store = new ProductStore(paths);
      await assert.rejects(store.update('documents', { revision: 0, name: 'Raced source', path: target }),
        error => error instanceof ProductStoreError && error.status === 400);
      assert.equal(changed, true);
      assert.equal((await store.read()).revision, 0);
      const saved = await store.update('documents', { revision: 0, name: 'Next source', text: 'readable' });
      assert.equal(saved.documents.length, 1);
      assert.equal(saved.documents[0].segments[0].text, 'readable');
    `;
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: root, timeout: 10_000 });
  });
}

test('an allowed huge paste preserves one complete unresolved original rather than a partial ledger or orphan', async t => {
  const { store, root } = fixture(t);
  const text = 'x\n'.repeat(100_000) + 'last';
  const state = await store.update('documents', { revision: 0, name: '100001 lines', text });
  assert.equal(state.revision, 1);
  assert.equal(state.documents.length, 1);
  assert.deepEqual(state.scenarios, []);
  const document = state.documents[0]!;
  assert.deepEqual(readFileSync(document.path), Buffer.from(text, 'utf8'));
  assert.equal(document.sha256, sha256(Buffer.from(text, 'utf8')));
  assert.deepEqual(document.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
  assert.ok(document.issues.some(issue => issue.code.includes('limit')));
  assert.deepEqual((await store.read()).documents, state.documents);
  assert.deepEqual(readdirSync(join(root, '.qa', 'product', 'sources')), [document.path.split('/').at(-1)]);
  assert.equal(existsSync(join(root, '.qa', 'product', 'scenarios')), false);
  assert.equal(existsSync(join(root, '.qa', 'runs')), false);
});

async function nearlyFullCatalog(t: TestContext) {
  const f = fixture(t);
  const path = join(f.paths.uploads, 'large.txt');
  writeFileSync(path, '가'.repeat(1_000_000));
  const state = await f.store.update('documents', { revision: 0, name: '보존 원문', path });
  const document = state.documents[0]!;
  state.documents = Array.from({ length: 5 }, (_, index) => index === 0 ? document : { ...document, id: randomUUID() });
  const catalog = join(f.root, '.qa', 'product', 'catalog-v2.json');
  writeFileSync(catalog, `${JSON.stringify(state, null, 2)}\n`);
  assert.ok(readFileSync(catalog).length < 16 * 1024 * 1024);
  return { ...f, state, catalog, path, document };
}

test('aggregate catalog capacity rejects a new document before writing its source artifact', async t => {
  const f = await nearlyFullCatalog(t);
  const before = readFileSync(f.catalog);
  const sourceBytes = readFileSync(f.document.path);
  const sources = readdirSync(join(f.root, '.qa', 'product', 'sources'));
  await assert.rejects(f.store.update('documents', { revision: f.state.revision, name: '한도 초과 원문', path: f.path }),
    error => error instanceof ProductStoreError && error.status === 413);
  assert.deepEqual(readFileSync(f.catalog), before);
  assert.deepEqual(readFileSync(f.document.path), sourceBytes);
  assert.deepEqual(readdirSync(join(f.root, '.qa', 'product', 'sources')), sources);
  assert.equal((await f.store.read()).documents.length, 5);
});

test('catalog capacity rejects scenario notes and manifests without replacing previous records', async t => {
  const f = await nearlyFullCatalog(t);
  const before = readFileSync(f.catalog);
  const sources = readdirSync(join(f.root, '.qa', 'product', 'sources'));
  await assert.rejects(f.store.update('scenarios', { revision: f.state.revision, definition,
    source: { documentIDs: [], notes: '나'.repeat(600_000), mappings: [], reviewed: false } }),
  error => error instanceof ProductStoreError && error.status === 413);
  assert.deepEqual(readFileSync(f.catalog), before);
  assert.deepEqual(readdirSync(join(f.root, '.qa', 'product', 'sources')), sources);
  assert.equal(existsSync(join(f.root, '.qa', 'product', 'scenarios')), false);
  assert.deepEqual((await f.store.read()).scenarios, []);
});

for (const file of ['catalog-v2.json', 'catalog.json']) {
  test(`${file} exceeding 16 MiB is preserved and cannot be reset by a mutation`, async t => {
    const { store, root } = fixture(t);
    const state = await store.read();
    const directory = join(root, '.qa', 'product');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, file);
    const value = file === 'catalog.json' ? { schema: 'qautra/workspace/v1', revision: 0, scenarios: [], documents: [], environments: [], settings: state.settings } : state;
    const bytes = Buffer.concat([Buffer.from(JSON.stringify(value)), Buffer.alloc(16 * 1024 * 1024, 32)]);
    writeFileSync(path, bytes);
    await assert.rejects(store.read(), error => error instanceof ProductStoreError && error.status === 500 && error.message.includes('16 MiB'));
    await assert.rejects(store.update('documents', { revision: 0, name: '새 입력', text: '보존' }),
      error => error instanceof ProductStoreError && error.status === 500);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(existsSync(join(directory, 'sources')), false);
    if (file === 'catalog.json') assert.equal(existsSync(join(directory, 'catalog-v2.json')), false);
  });
}

test('structurally exhausted XLSX intake preserves exact uploaded bytes as one unresolved document', async t => {
  const { store, paths, root } = fixture(t);
  const bytes = zipStore({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Readable prefix</t></is></c></row><row r="100001"/></sheetData></worksheet>' });
  const path = join(paths.uploads, 'oversized-structure.xlsx');
  writeFileSync(path, bytes);
  const state = await store.update('documents', { revision: 0, name: '구조 한도 원문', path });
  assert.equal(state.documents.length, 1);
  const document = state.documents[0]!;
  assert.deepEqual(readFileSync(document.path), bytes);
  assert.equal(document.sha256, sha256(bytes));
  assert.deepEqual(document.segments, [{ id: 'file', locator: 'file', text: '', kind: 'unparsed' }]);
  assert.equal(document.issues[0]!.code, 'source_xlsx_limit');
  assert.deepEqual((await store.read()).documents, state.documents);
  assert.deepEqual(state.scenarios, []);
  assert.equal(existsSync(join(root, '.qa', 'runs')), false);
});
