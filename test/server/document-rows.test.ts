import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProductSourceManifest, scenarioSourceDigest, validateProductSourceManifest, type ProductDocument, type ScenarioSource } from '../../src/core/product.ts';
import { ingestSourceLedger } from '../../src/plan/ingest.ts';
import { createRevisionStore } from '../../src/runner/revisions.ts';
import { ProductStore, ProductStoreError } from '../../src/server/product-store.ts';
import { TestSpec } from '../../src/spec/schema.ts';

const reviewer = { reviewer: { principalId: 'source-row-reviewer', channel: 'local-ui' as const } };
const originalRows = [
  String.raw`{ "case":"DUP", "action":"Open order list", "checks":["Accepted","Waiting to ship"], "result":{}, "observed":"FAIL", "unknown":{"数値":9007199254740993,"emoji":"😀"} }`,
  String.raw`{"case":"DUP","action":"Open order list","checks":["Closed","Ready"],"result":{"PC":"PASS"},"unknown":null}`,
];
async function fixture(t: TestContext, raw = `[\n${originalRows.join(',\r\n')}\n]`) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-source-rows-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { root, apps: join(root, 'apps'), uploads: join(root, 'uploads'), generated: join(root, 'generated') };
  mkdirSync(paths.apps); mkdirSync(paths.uploads);
  writeFileSync(join(paths.apps, 'demo.yaml'), JSON.stringify({ id: 'demo', name: 'Row fixture', android: { package: 'com.qa.demo' } }));
  const path = join(paths.uploads, 'cases.json'); writeFileSync(path, raw);
  const store = new ProductStore(paths, { ingestSource: ingestSourceLedger });
  const state = await store.update('documents', { revision: 0, name: 'Arbitrary cases', path });
  return { root, paths, store, state, parent: state.documents[0]!, raw };
}
function sourceFor(document: ProductDocument, guide?: ProductDocument): ScenarioSource {
  const source: ScenarioSource = { documentIDs: [document.id], notes: '', reviewed: true, mappings: document.segments.map(segment => {
    const check = segment.id === 'json:"/checks/0"' ? 'steps[1]' : segment.id === 'json:"/checks/1"' ? 'steps[2]' : null;
    const action = segment.id === 'json:"/action"';
    return { documentID: document.id, segmentID: segment.id, disposition: check || action ? 'mapped' : 'reference',
      role: check ? 'expected' : action ? 'step' : segment.id.startsWith('json:"/result') || segment.id === 'json:"/observed"' ? 'history' : 'identity',
      stepPaths: action ? ['steps[0]'] : [], checkPaths: check ? [check] : [], reason: 'Original field and expectation reviewed without using historical verdicts.',
      originalCaseID: 'DUP', logicalCaseID: `case-${document.derivation!.row.index}` };
  }) };
  if (guide) {
    source.documentIDs.push(guide.id);
    source.mappings.push(...guide.segments.map((segment, index) => ({
      documentID: guide.id, segmentID: segment.id, disposition: index === 0 ? 'mapped' as const : 'reference' as const,
      role: index === 0 ? 'precondition' as const : 'history' as const, stepPaths: index === 0 ? ['steps[0]'] : [], checkPaths: [],
      reason: index === 0 ? 'Shared guide describes the same required setup.' : 'Historical PASS is not a new outcome.',
    })));
  }
  return source;
}

test('object rows retain exact Unicode bytes, duplicate display IDs, unknown fields and the shared original without creating scenarios', async t => {
  const f = await fixture(t);
  const original = readFileSync(f.parent.path);
  const state = await f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id });
  const rows = state.documents.filter(doc => doc.derivation?.documentID === f.parent.id);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
  assert.deepEqual(state.scenarios, []);
  assert.deepEqual(readFileSync(f.parent.path), original);
  for (const [index, row] of rows.entries()) {
    assert.equal(readFileSync(row.path, 'utf8'), originalRows[index]);
    assert.equal(row.derivation!.row.index, index);
    assert.equal(row.derivation!.rowCount, 2);
    assert.equal(row.derivation!.sha256, f.parent.sha256);
    assert.deepEqual(readFileSync(row.path), original.subarray(row.derivation!.row.startByte, row.derivation!.row.endByte));
    assert.equal(row.issues.length, 0);
  }
  assert.equal(rows[0]!.segments.find(segment => segment.id === 'json:"/unknown/数値"')!.text, '9007199254740993');
  assert.equal(rows[0]!.segments.find(segment => segment.id === 'json:"/result"')!.text, '{}');
  assert.equal(rows[1]!.segments.find(segment => segment.id === 'json:"/result/PC"')!.text, '"PASS"');
  await assert.rejects(f.store.update('document-rows', { revision: state.revision, documentID: f.parent.id }), error => error instanceof ProductStoreError && error.status === 409);
  assert.equal((await f.store.read()).documents.length, state.documents.length);
});

for (const [label, raw] of [
  ['truncated', '[{"case":"FO-159"'], ['duplicate key', '[{"checks":"A","checks":"B"}]'],
  ['mixed array', '[{"checks":["A"]},"common context"]'], ['not an array', '{"checks":["A","B"]}'],
] as const) test(`${label} source cannot be partially split`, async t => {
  const f = await fixture(t, raw);
  await assert.rejects(f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id }), error => error instanceof ProductStoreError && error.status === 400);
  const state = await f.store.read();
  assert.equal(state.revision, f.state.revision);
  assert.equal(state.documents.length, 1);
  assert.equal(readFileSync(f.parent.path, 'utf8'), raw);
});

test('415 object rows are all preserved instead of merging identical IDs or taking a prefix', async t => {
  const rows = Array.from({ length: 415 }, (_, index) => JSON.stringify({ arbitrary_id: 'same display ID', nested: { expected: [`한국어 ${index}`, `second ${index}`] }, result: {} }));
  const f = await fixture(t, `[${rows.join(',')}]`);
  const state = await f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id });
  const derived = state.documents.filter(doc => doc.derivation?.documentID === f.parent.id);
  assert.equal(derived.length, 415);
  for (const [index, document] of derived.entries()) {
    assert.equal(document.derivation!.row.index, index);
    assert.equal(document.derivation!.rowCount, 415);
    assert.equal(readFileSync(document.path, 'utf8'), rows[index]);
  }
  assert.deepEqual(state.scenarios, []);
});

test('published object-row source binds the original array byte range and survives removal of mutable originals', async t => {
  const f = await fixture(t);
  let state = await f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id });
  const document = state.documents.find(doc => doc.derivation?.row.index === 0)!;
  const secondDocument = state.documents.find(doc => doc.derivation?.row.index === 1)!;
  state = await f.store.update('documents', { revision: state.revision, name: 'Separate execution guide', text: 'Open order list\nOld observed PASS' });
  const guide = state.documents.at(-1)!;
  const definition = TestSpec.parse({ id: 'row-first', name: 'First object row', app: 'demo', platforms: ['android'], reset: 'none', steps: [
    { tap: { id: 'orders' }, expectNoChange: true }, { assertText: 'Accepted' }, { assertText: 'Waiting to ship' },
  ] });
  state = await f.store.update('scenarios', { revision: state.revision, definition, source: sourceFor(document, guide) }, reviewer);
  const scenario = state.scenarios[0]!;
  assert.equal(scenario.executable, true, JSON.stringify(scenario.problems));
  const second = TestSpec.parse({ ...definition, id: 'row-second', name: 'Second object row', steps: [
    { tap: { id: 'orders' }, expectNoChange: true }, { assertText: 'Closed' }, { assertText: 'Ready' },
  ] });
  state = await f.store.update('scenarios', { revision: state.revision, definition: second, source: sourceFor(secondDocument, guide) }, reviewer);
  const secondScenario = state.scenarios[1]!;
  assert.equal(secondScenario.executable, true, JSON.stringify(secondScenario.problems));
  const revisions = createRevisionStore({ root: f.root, appsDir: f.paths.apps, generatedDir: f.paths.generated });
  const candidate = await revisions.preview([scenario.path, secondScenario.path]);
  assert.deepEqual(candidate.problems, []);
  assert.equal(candidate.definition.sources.filter(source => source.sha256 === f.parent.sha256).length, 1);
  assert.equal(candidate.definition.sources.filter(source => source.sha256 === guide.sha256).length, 1);
  assert.equal(candidate.definition.tests.length, 2);
  assert.equal(candidate.definition.checks.length, 4);
  const published = await revisions.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), reviewer.reviewer);
  const captured = new Map(candidate.definition.sources.map(source => [source.sha256, readFileSync(source.path)]));
  const manifest = ProductSourceManifest.parse(JSON.parse(readFileSync(scenario.manifestPath!, 'utf8')));
  assert.deepEqual(validateProductSourceManifest(manifest, candidate.definition.sources, definition, { bytes: captured, json: new Map() }), []);
  assert.ok(validateProductSourceManifest(manifest, candidate.definition.sources, definition).some(issue => issue.code === 'source_parent_bytes_unverified'));
  for (const variant of ['range', 'index', 'count', 'parent hash', 'parent ledger'] as const) {
    const forged = structuredClone(manifest);
    const parent = forged.documents[0]!.derivation!;
    if (variant === 'range') parent.row.startByte++;
    if (variant === 'index') parent.row.index = 1;
    if (variant === 'count') parent.rowCount++;
    if (variant === 'parent hash') parent.sha256 = '0'.repeat(64);
    if (variant === 'parent ledger') parent.ledgerDigest = '0'.repeat(64);
    forged.digest = scenarioSourceDigest(forged.definition, forged.source, forged.documents);
    forged.review!.digest = forged.digest;
    const issues = validateProductSourceManifest(forged, candidate.definition.sources, definition, { bytes: captured, json: new Map() });
    assert.ok(issues.some(issue => issue.code === (variant === 'parent hash' ? 'source_parent_bytes_unverified' : 'source_derivation_invalid')), variant);
  }
  rmSync(f.parent.path); rmSync(document.path);
  const origin = await revisions.origin(published.revisionId, definition.id!);
  assert.equal(origin.availability, 'verified');
  if (origin.availability !== 'verified') assert.fail('Captured row source is required');
  assert.deepEqual(origin.manifest.documents[0]!.derivation, document.derivation);
  assert.equal(origin.manifest.documents.find(doc => doc.id === guide.id)!.segments[1]!.text, 'Old observed PASS');
  assert.equal(origin.manifest.source.mappings.find(mapping => mapping.documentID === guide.id && mapping.segmentID === 'line:2')!.role, 'history');
});

test('a changed original cannot be silently split or reused for a new review', async t => {
  const f = await fixture(t);
  writeFileSync(f.parent.path, '[{"replacement":true}]');
  await assert.rejects(f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id }), error => error instanceof ProductStoreError && error.status === 409);
  assert.equal((await f.store.read()).documents.length, 1);
});

test('catalog capacity rejects a complete row split without appending a prefix or writing derived sources', async t => {
  const raw = JSON.stringify([{ unknown: '가'.repeat(500_000) }, { unknown: '나'.repeat(500_000) }]);
  const f = await fixture(t, raw);
  f.state.documents = Array.from({ length: 5 }, (_, index) => index === 0 ? f.parent : { ...f.parent, id: randomUUID() });
  const catalog = join(f.root, '.qa', 'product', 'catalog-v2.json');
  writeFileSync(catalog, `${JSON.stringify(f.state, null, 2)}\n`);
  const before = readFileSync(catalog);
  const original = readFileSync(f.parent.path);
  const sources = readdirSync(join(f.root, '.qa', 'product', 'sources'));
  assert.ok(before.length < 16 * 1024 * 1024);
  await assert.rejects(f.store.update('document-rows', { revision: f.state.revision, documentID: f.parent.id }),
    error => error instanceof ProductStoreError && error.status === 413);
  assert.deepEqual(readFileSync(catalog), before);
  assert.deepEqual(readFileSync(f.parent.path), original);
  assert.deepEqual(readdirSync(join(f.root, '.qa', 'product', 'sources')), sources);
  const state = await f.store.read();
  assert.equal(state.revision, f.state.revision);
  assert.equal(state.documents.length, 5);
  assert.ok(state.documents.every(document => document.derivation === undefined));
  assert.deepEqual(state.scenarios, []);
});
