import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ProductSourceManifest, type ScenarioSource } from '../../src/core/product.ts';
import { ingestSourceLedger } from '../../src/plan/ingest.ts';
import { createRevisionStore } from '../../src/runner/revisions.ts';
import { ProductStore, ProductStoreError } from '../../src/server/product-store.ts';
import { TestSpec } from '../../src/spec/schema.ts';
import { docxBytes, pdfBytes } from '../plan/helpers.ts';

const reviewer = { reviewer: { principalId: 'local-qa-reviewer', channel: 'local-ui' as const } };
const lines = ['Open order list', 'Accepted', 'Waiting to ship'];
const definition = TestSpec.parse({ id: 'order-transcript', name: 'Order status', app: 'demo', platforms: ['android'], reset: 'none',
  steps: [{ tap: { id: 'orders' }, expectNoChange: true }, { assertText: lines[1] }, { assertText: lines[2] }] });
async function fixture(t: TestContext, kind: 'pdf' | 'docx' = 'docx') {
  const root = mkdtempSync(join(tmpdir(), 'qautra-source-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = { root, apps: join(root, 'apps'), uploads: join(root, 'uploads'), generated: join(root, 'generated') };
  mkdirSync(paths.apps); mkdirSync(paths.uploads);
  writeFileSync(join(paths.apps, 'demo.yaml'), JSON.stringify({ id: 'demo', name: 'Review fixture', android: { package: 'com.qa.demo' } }));
  const bytes = kind === 'pdf' ? pdfBytes(lines) : docxBytes(lines.map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join(''));
  const file = join(paths.uploads, `original.${kind}`); writeFileSync(file, bytes);
  const store = new ProductStore(paths, { ingestSource: ingestSourceLedger });
  let state = await store.update('documents', { revision: 0, name: 'Original specification', path: file });
  const original = state.documents[0]!;
  assert.ok(original.issues.some(issue => issue.code === 'source_structure_unverified'));
  state = await store.update('documents', { revision: state.revision, name: 'Human full transcript', text: lines.join('\n') });
  const transcript = state.documents[1]!;
  const source: ScenarioSource = { documentIDs: [original.id, transcript.id], notes: '', reviewed: true,
    mappings: [
      ...original.segments.map(segment => ({ documentID: original.id, segmentID: segment.id, disposition: 'reference' as const, role: 'transcribed' as const,
        reason: 'All original pages, text and structure compared with the full transcript.', stepPaths: [], checkPaths: [] })),
      ...transcript.segments.map((segment, index) => ({ documentID: transcript.id, segmentID: segment.id, disposition: 'mapped' as const,
        role: index === 0 ? 'step' as const : 'expected' as const, reason: 'Exact original requirement reviewed.',
        stepPaths: index === 0 ? ['steps[0]'] : [], checkPaths: index === 0 ? [] : [`steps[${index}]`] })),
    ],
    resolutions: [{ kind: 'manual-full-transcript/v1', documentID: original.id, sourceSha256: original.sha256, sourceLedgerDigest: original.ledgerDigest,
      transcriptDocumentID: transcript.id, transcriptSha256: transcript.sha256, transcriptLedgerDigest: transcript.ledgerDigest,
      coverage: 'Complete one-page original, all three paragraphs and the original structure marker.' }],
  };
  return { root, paths, store, state, original, transcript, source, bytes };
}

for (const kind of ['pdf', 'docx'] as const) test(`preserves ${kind} warnings and publishes only the full human-bound transcript`, async t => {
  const f = await fixture(t, kind);
  const { resolutions: _resolutions, ...withoutResolution } = f.source;
  let state = await f.store.update('scenarios', { revision: f.state.revision, definition, source: withoutResolution }, reviewer);
  assert.equal(state.scenarios[0]!.executable, false);
  assert.ok(state.scenarios[0]!.problems.some(issue => issue.code === 'source_structure_unverified'));
  state = await f.store.update('scenarios', { revision: state.revision, id: state.scenarios[0]!.id, definition, source: f.source }, reviewer);
  const scenario = state.scenarios[0]!;
  assert.equal(scenario.executable, true, JSON.stringify(scenario.problems));
  assert.deepEqual(readFileSync(f.original.path), f.bytes);
  const manifest = ProductSourceManifest.parse(JSON.parse(readFileSync(scenario.manifestPath!, 'utf8')));
  assert.ok(manifest.documents.find(doc => doc.id === f.original.id)!.issues.some(issue => issue.code === 'source_structure_unverified'));
  assert.ok(manifest.documents.find(doc => doc.id === f.original.id)!.segments.some(segment => segment.kind === 'unparsed'));
  assert.deepEqual(manifest.source.resolutions, f.source.resolutions);
  const revisions = createRevisionStore({ root: f.root, appsDir: f.paths.apps, generatedDir: f.paths.generated });
  const candidate = await revisions.preview([scenario.path]);
  assert.deepEqual(candidate.problems, []);
  const published = await revisions.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), reviewer.reviewer);
  writeFileSync(f.transcript.path, 'Changed later; not the reviewed transcript');
  const origin = await revisions.origin(published.revisionId, definition.id!);
  assert.equal(origin.availability, 'verified');
  if (origin.availability !== 'verified') assert.fail('Original captured source required');
  assert.deepEqual(origin.manifest.source.resolutions, f.source.resolutions);
  assert.deepEqual(origin.manifest.documents.find(doc => doc.id === f.transcript.id)!.segments.map(segment => segment.text), lines);
});

const invalid = [
  ['original hash', 'source_resolution_original_changed'], ['original ledger', 'source_resolution_original_changed'],
  ['transcript hash', 'source_resolution_transcript_changed'], ['transcript ledger', 'source_resolution_transcript_changed'],
  ['unreviewed', 'source_resolution_review_required'], ['missing transcript', 'source_resolution_document_missing'],
  ['self transcript', 'source_resolution_transcript_unreadable'], ['duplicate resolution', 'source_resolution_duplicate'],
  ['unmapped original', 'source_scope_unmapped'], ['unmapped transcript expectation', 'source_scope_unmapped'],
  ['reused expectation', 'source_expectation_check_reused'], ['generic original reference', 'source_original_transcription_required'],
] as const;
for (const [variant, code] of invalid) test(`rejects manual source review with ${variant}`, async t => {
  const f = await fixture(t);
  const source = structuredClone(f.source);
  const resolution = source.resolutions![0]!;
  if (variant === 'original hash') resolution.sourceSha256 = '0'.repeat(64);
  if (variant === 'original ledger') resolution.sourceLedgerDigest = '0'.repeat(64);
  if (variant === 'transcript hash') resolution.transcriptSha256 = '0'.repeat(64);
  if (variant === 'transcript ledger') resolution.transcriptLedgerDigest = '0'.repeat(64);
  if (variant === 'unreviewed') source.reviewed = false;
  if (variant === 'missing transcript') source.documentIDs = [f.original.id];
  if (variant === 'self transcript') resolution.transcriptDocumentID = f.original.id;
  if (variant === 'duplicate resolution') source.resolutions!.push(structuredClone(resolution));
  if (variant === 'unmapped original') source.mappings = source.mappings.filter(mapping => mapping.segmentID !== f.original.segments[0]!.id || mapping.documentID !== f.original.id);
  if (variant === 'unmapped transcript expectation') source.mappings = source.mappings.filter(mapping => mapping.documentID !== f.transcript.id || mapping.segmentID !== 'line:3');
  if (variant === 'reused expectation') source.mappings.find(mapping => mapping.documentID === f.transcript.id && mapping.segmentID === 'line:3')!.checkPaths = ['steps[1]'];
  if (variant === 'generic original reference') source.mappings.find(mapping => mapping.documentID === f.original.id)!.role = 'reference';
  const state = await f.store.update('scenarios', { revision: f.state.revision, definition, source }, reviewer);
  const scenario = state.scenarios[0]!;
  assert.equal(scenario.executable, false);
  assert.ok(scenario.problems.some(issue => issue.code === code), JSON.stringify(scenario.problems));
  const revisions = createRevisionStore({ root: f.root, appsDir: f.paths.apps, generatedDir: f.paths.generated });
  const candidate = await revisions.preview([scenario.path]);
  await assert.rejects(revisions.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), reviewer.reviewer));
});

test('manual source interpretation cannot mint local reviewer authority', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.update('scenarios', { revision: f.state.revision, definition, source: f.source }), error => error instanceof ProductStoreError && error.status === 403);
  const source = structuredClone(f.source); source.resolutions![0]!.coverage = ' ';
  await assert.rejects(f.store.update('scenarios', { revision: f.state.revision, definition, source }, reviewer), error => error instanceof ProductStoreError && error.status === 400);
});

for (const [label, bytes, originalIssue] of [
  ['incomplete JSON', '["Open order list","Accepted","Waiting to ship"', 'source_json_invalid'],
  ['duplicate JSON fields', '{"expected":"Accepted","expected":"Waiting to ship"}', 'source_json_duplicate_key'],
  ['analysis-limit truncated JSON', ' '.repeat(8_000_000) + '[{"expected":"Accepted"', 'source_json_limit'],
  ['invalid UTF-8 JSON', Buffer.from([0xff, 0x7b]), 'source_parser_unavailable'],
] as const) test(`manual full transcript cannot legitimize ${label}`, async t => {
  const f = await fixture(t);
  const path = join(f.paths.uploads, 'incomplete.json');
  writeFileSync(path, bytes);
  let state = await f.store.update('documents', { revision: f.state.revision, name: 'Incomplete original', path });
  const original = state.documents.at(-1)!;
  assert.ok(original.issues.some(issue => issue.code === originalIssue));
  const source = structuredClone(f.source);
  source.documentIDs = [original.id, f.transcript.id];
  source.mappings = [
    ...original.segments.map(segment => ({ documentID: original.id, segmentID: segment.id, disposition: 'reference' as const, role: 'transcribed' as const,
      reason: 'Human claims a complete transcript', stepPaths: [], checkPaths: [] })),
    ...source.mappings.filter(mapping => mapping.documentID === f.transcript.id),
  ];
  Object.assign(source.resolutions![0]!, { documentID: original.id, sourceSha256: original.sha256, sourceLedgerDigest: original.ledgerDigest });
  state = await f.store.update('scenarios', { revision: state.revision, definition, source }, reviewer);
  const scenario = state.scenarios[0]!;
  assert.equal(scenario.executable, false);
  assert.ok(scenario.problems.some(issue => issue.code === 'source_resolution_original_incomplete'));
  assert.ok(scenario.problems.some(issue => issue.code === originalIssue));
  const revisions = createRevisionStore({ root: f.root, appsDir: f.paths.apps, generatedDir: f.paths.generated });
  const candidate = await revisions.preview([scenario.path]);
  await assert.rejects(revisions.publish(candidate.candidateId, candidate.digest, candidate.definition.checks.map(check => check.id), reviewer.reviewer));
});
