import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, cpSync, createReadStream, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import type { AgentCallContext, AgentRequestInput } from '../../src/core/agent.ts';
import { commitDirectory, ensureDir, writeJsonAtomic } from '../../src/core/fsx.ts';
import { assertEvidenceDigestReadable, assertProductEvidenceRead, evidenceDigest, hashPrivateEvidence, NativeDownloadLease, NativeDownloadPending, openPrivateEvidence, ProductEvidenceError, type EvidenceConsent, type EvidenceOperationPreview, type EvidenceOperationResult, type NativeDownloadCleanupReceipt, type ProductReportRow, type RunEvidenceReader } from '../../src/core/product-evidence.ts';
import type { AttemptVideoReceipt } from '../../src/core/recording.ts';
import type { PublishedRevision, RegressionRun } from '../../src/core/regression.ts';
import { groupProductSymptoms, ProductEvidenceService, type ProductEvidencePolicy } from '../../src/server/product-evidence.ts';
import { NativeDownloadRegistry } from '../../src/server/native-downloads.ts';
import { renderPortableEvidenceHtml } from '../../src/report/html.ts';

const reviewer: AgentCallContext = { operatorReview: { principalId: 'local-test-user', channel: 'local-ui' } };
const at = '2026-11-01T00:00:00.000Z';
interface EvidenceFixture { service: ProductEvidenceService; requestID: string }
function fixture(t: TestContext) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-evidence-')));
  chmodSync(temporary, 0o700);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = ensureDir(join(temporary, 'project')), authorityRoot = ensureDir(join(temporary, 'authority'));
  const requestID = randomUUID(), attemptID = randomUUID(), runID = '20261101-000000-evidence', revisionID = 'a'.repeat(64);
  const target = { platform: 'desktop-chrome' as const, deviceId: 'owned-chrome-test' };
  const run: RegressionRun = {
    schema: 'qautra/regression-run/v1', requestId: requestID, fingerprint: 'b'.repeat(64), name: '원 주문 상태', createdAt: at, updatedAt: at, state: 'finished', revisionIds: [revisionID], targets: [target], authorizations: [], evidence: 'required-video', stopRequested: false, code: null, message: null,
    attempts: [{ attemptId: attemptID, revisionId: revisionID, testId: 'TC-007', target, authorization: { appId: 'demo', target, grantId: 'capture-local-only', subjectSha256: 'c'.repeat(64) }, state: 'finished', runId: runID, business: 'FAIL', evidence: 'ready', cleanup: 'confirmed', requiredChecks: ['TC-007:steps[0]'], completedChecks: ['TC-007:steps[0]'], code: 'assert_text_missing', message: '실제 접수됨 없음' }],
  };
  const revision: PublishedRevision = { schema: 'qautra/scenario-revision/v4', revisionId: revisionID, publishedAt: at, definition: { schema: 'qautra/scenario-definition/v4', tests: [], chains: [], sources: [], checks: [{ id: 'TC-007:steps[0]', testId: 'TC-007', path: 'steps[0]', kind: 'assertText', description: '접수됨', scope: 'observed-text', platforms: ['desktop-chrome'] }], runtime: { node: 'test', files: [], digest: 'd'.repeat(64) } }, review: { candidateId: randomUUID(), digest: revisionID, checks: ['TC-007:steps[0]'] } };
  const runRoot = ensureDir(join(root, '.qa', 'runs', runID));
  const videoPath = `video/${attemptID}/segment-0001.mp4`, screenPath = 'TC-007/desktop-chrome/step-01/before.png';
  const write = (path: string, bytes: string | Buffer): void => { ensureDir(dirname(join(runRoot, path))); writeFileSync(join(runRoot, path), bytes, { mode: 0o600 }); };
  write(screenPath, 'test-owned-screenshot-bytes');
  write(videoPath, 'test-owned-finalized-video-bytes');
  write('report.html', '<p>Original generated report</p>');
  write('journal.jsonl', '{"effect":"completed"}\n');
  write('scenario-revision.json', '{"immutable":true}');
  const result = { schema: 'qautra/attempt-result/v2', attemptId: attemptID, revisionId: revisionID, runId: runID, business: 'FAIL', cleanup: 'confirmed' };
  writeJsonAtomic(join(runRoot, 'attempt-result.json'), result);
  writeJsonAtomic(join(runRoot, 'summary.json'), { runId: runID, tests: [{ id: 'TC-007', platform: target.platform, deviceId: target.deviceId, verdict: 'FAIL', code: 'assert_text_missing', reason: '실제 접수됨 없음', steps: [{ seq: 1, index: 0, label: '접수 상태', kind: 'assertText', phase: 'main', verdict: 'FAIL', code: 'assert_text_missing', reason: '실제 접수됨 없음', durationMs: 20, decisions: [], health: [] }] }] });
  const manifest = { $schema: 'app-qa/manifest/v1', runId: runID, updatedAt: at, entries: [{ kind: 'screenshot', relativePath: screenPath, sizeBytes: Buffer.byteLength('test-owned-screenshot-bytes') }, { kind: 'report', relativePath: 'report.html', sizeBytes: Buffer.byteLength('<p>Original generated report</p>') }] };
  writeJsonAtomic(join(runRoot, 'manifest.json'), manifest);
  const video: AttemptVideoReceipt = { schema: 'qautra/attempt-video/v1', binding: { attemptId: attemptID, runId: runID, platform: target.platform, deviceId: target.deviceId, generation: 1 }, state: 'ready', cleanup: 'confirmed', segments: [{ file: videoPath, sha256: evidenceDigest('test-owned-finalized-video-bytes'), bytes: Buffer.byteLength('test-owned-finalized-video-bytes'), durationSeconds: 1, frames: 2, width: 10, height: 10, startedAt: at, endedAt: '2026-11-01T00:00:01.000Z', source: 'chrome-page', timing: { basis: 'encoder-observed', firstFrameReceivedAt: at, captureStartedAt: null, captureEndedAt: null } }], gaps: [], artifacts: [{ file: videoPath, readyAt: at, firstFrameAt: at, code: null, status: { capture: 'stopped', encoder: 'finalized', spool: 'released', file: 'durable', media: 'valid', diagnostics: [] } }], code: null };
  writeJsonAtomic(join(runRoot, `video/${attemptID}/manifest.json`), video);
  let clock = Date.parse(at), policy: ProductEvidencePolicy = { version: 'test/v1', localExport: true, rawLocalExport: true, delete: true };
  const requests: AgentRequestInput[] = [];
  const query = { async call(request: AgentRequestInput) {
    requests.push(request);
    if (request.method === 'regression.list') return { ok: true as const, result: structuredClone([run]), meta: { requestId: randomUUID(), at } };
    if (request.method === 'scenario.get' && request.revisionId === revisionID) return { ok: true as const, result: structuredClone(revision), meta: { requestId: randomUUID(), at } };
    if (request.method === 'scenario.origin') return { ok: true as const, result: { schema: 'qautra/scenario-origin/v1', revisionId: request.revisionId, testId: request.testId, availability: 'not-captured', manifestSha256: null, manifest: null }, meta: { requestId: randomUUID(), at } };
    throw new Error('Evidence service may only query captured definitions and run records');
  } };
  const makeService = () => new ProductEvidenceService({ root, authorityRoot, query, now: () => clock, policy: () => policy, renderPortableHtml: renderPortableEvidenceHtml });
  const service = makeService();
  return { root, authorityRoot, requestID, attemptID, runID, revisionID, run, revision, runRoot, screenPath, videoPath, manifest, video, write, service, makeService, query, requests, advance: (ms: number) => { clock += ms; }, changePolicy: (value: ProductEvidencePolicy) => { policy = value; } };
}
async function previewAll(f: EvidenceFixture, operation: 'export' | 'delete', artifactIDs?: string[]): Promise<EvidenceOperationPreview> {
  const library = await f.service.library();
  return await f.service.dispatch({ method: 'operation.preview', operation, selection: { requestIDs: [f.requestID], artifactIDs: artifactIDs ?? library.artifacts.filter(item => operation !== 'delete' || item.kind !== 'media-receipt').map(item => item.id) } }, reviewer) as EvidenceOperationPreview;
}
async function grant(f: EvidenceFixture, preview: EvidenceOperationPreview): Promise<EvidenceConsent> {
  return await f.service.dispatch({ method: 'consent.grant', previewID: preview.previewID, scopeDigest: preview.scopeDigest, acknowledgeRaw: true }, reviewer) as EvidenceConsent;
}
async function execute(f: EvidenceFixture, consent: EvidenceConsent): Promise<EvidenceOperationResult> {
  return await f.service.dispatch({ method: 'operation.execute', consentID: consent.consentID, scopeDigest: consent.scopeDigest }, reviewer) as EvidenceOperationResult;
}
async function nativeExport(f: EvidenceFixture) {
  const preview = await previewAll(f, 'export'), consent = await grant(f, preview), exported = await execute(f, consent);
  const lease = NativeDownloadLease.parse(await f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer));
  return { preview, consent, exported, lease };
}
function nativeReceipt(lease: NativeDownloadLease, changes: Record<string, unknown> = {}): void {
  writeJsonAtomic(join(lease.directory, 'cleanup.json'), { schema: 'qautra/native-export-cleanup/v1', id: lease.id, secret: lease.secret, identity: lease.identity, payloadRemoved: true, localStaging: 'none', closedAt: at, ...changes } satisfies NativeDownloadCleanupReceipt);
}
async function closeNative(f: EvidenceFixture, lease: NativeDownloadLease): Promise<void> {
  await f.service.dispatch({ method: 'native-download.retire', id: lease.id, secret: lease.secret }, reviewer);
  unlinkSync(lease.path); commitDirectory(lease.directory); nativeReceipt(lease);
  await f.service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, reviewer);
}
function tarEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
    entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function consumeRunFile(reader: RunEvidenceReader, received: Buffer[], beforeChunk: (index: number) => void | Promise<void> = () => {}): Promise<void> {
  if (!reader.bytes) { try { reader.assertUnchanged(); } finally { closeSync(reader.fd); } return; }
  let index = 0;
  const source = createReadStream('', { fd: reader.fd, autoClose: false, start: 0, end: reader.bytes - 1, highWaterMark: 4 });
  const authority = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      void Promise.resolve().then(() => beforeChunk(index++)).then(() => { reader.assertUnchanged(); callback(null, chunk); }).catch(error => callback(error as Error));
    },
  });
  try { await pipeline(source, authority, new Writable({ write(chunk: Buffer, _encoding, callback) { received.push(Buffer.from(chunk)); callback(); } })); }
  finally {
    const { promise, resolve } = Promise.withResolvers<void>();
    source.close(() => resolve());
    await promise;
  }
}

test('library filters real manifest ownership, kind, target, attempt and capture clock without latest plans', async t => {
  const f = fixture(t), library = await f.service.library();
  assert.equal(library.artifacts.length, 3);
  assert.equal(library.externalTransmission, 'denied');
  assert.equal(library.artifacts.find(item => item.kind === 'video')?.captureClock, 'encoder-observed');
  assert.equal((await f.service.library({ method: 'library', requestID: f.requestID, attemptID: f.attemptID, target: f.run.targets[0]!.deviceId, kind: 'video', capturedFrom: at, capturedTo: at })).artifacts.length, 1);
  assert.equal((await f.service.library({ method: 'library', kind: 'video', capturedFrom: '2026-11-01T00:00:01Z' })).artifacts.length, 0);
  const reports = await f.service.reports();
  assert.equal(reports.rows[0]!.expected[0]!.description, '접수됨');
  assert.equal(reports.rows[0]!.business, 'FAIL');
  assert.deepEqual(reports.rows[0]!.requiredChecks, ['TC-007:steps[0]']);
  const actual = z.object({ tests: z.array(z.object({ steps: z.array(z.object({ reason: z.string() })) })) }).parse(reports.rows[0]!.actual);
  assert.equal(actual.tests[0]!.steps[0]!.reason, '실제 접수됨 없음');
  assert.ok(f.requests.every(request => ['scenario.get', 'scenario.origin', 'regression.list'].includes(request.method)));
});

test('traversal, symlink components, hard links, unsafe modes and FIFOs never become exportable', async t => {
  const f = fixture(t);
  assert.throws(() => openPrivateEvidence(f.runRoot, '../summary.json'), ProductEvidenceError);
  f.manifest.entries.push({ kind: 'screenshot', relativePath: '../private.png', sizeBytes: 1 });
  writeJsonAtomic(join(f.runRoot, 'manifest.json'), f.manifest);
  const original = readFileSync(join(f.runRoot, f.screenPath));
  unlinkSync(join(f.runRoot, f.screenPath));
  symlinkSync(join(f.runRoot, f.videoPath), join(f.runRoot, f.screenPath));
  let library = await f.service.library();
  assert.equal(library.artifacts.find(item => item.relativePath === f.screenPath)?.state, 'blocked');
  assert.ok(library.limitations.length > 0);
  unlinkSync(join(f.runRoot, f.screenPath));
  linkSync(join(f.runRoot, f.videoPath), join(f.runRoot, f.screenPath));
  assert.throws(() => hashPrivateEvidence(f.runRoot, f.screenPath), ProductEvidenceError);
  unlinkSync(join(f.runRoot, f.screenPath)); f.write(f.screenPath, original);
  chmodSync(join(f.runRoot, f.screenPath), 0o644);
  assert.throws(() => hashPrivateEvidence(f.runRoot, f.screenPath), ProductEvidenceError);
  unlinkSync(join(f.runRoot, f.screenPath));
  execFileSync('/usr/bin/mkfifo', [join(f.runRoot, f.screenPath)]); chmodSync(join(f.runRoot, f.screenPath), 0o600);
  library = await f.service.library();
  assert.equal(library.artifacts.find(item => item.relativePath === f.screenPath)?.state, 'blocked');
  assert.throws(() => hashPrivateEvidence(f.runRoot, f.screenPath), ProductEvidenceError);
});

test('local capture grant and body claims cannot authorize consent; exact scope, privacy and fresh consent are required', async t => {
  const f = fixture(t), preview = await previewAll(f, 'export');
  await assert.rejects(f.service.dispatch({ method: 'consent.grant', previewID: preview.previewID, scopeDigest: preview.scopeDigest, acknowledgeRaw: true }), /로컬 사용자/);
  await assert.rejects(f.service.dispatch({ method: 'consent.grant', previewID: preview.previewID, scopeDigest: '0'.repeat(64), acknowledgeRaw: true }, reviewer), /만료|변경/);
  await assert.rejects(f.service.dispatch({ method: 'consent.grant', previewID: preview.previewID, scopeDigest: preview.scopeDigest, acknowledgeRaw: false }, reviewer), /개인정보/);
  await assert.rejects(f.service.dispatch({ method: 'consent.grant', previewID: preview.previewID, scopeDigest: preview.scopeDigest, acknowledgeRaw: true, operatorReview: reviewer.operatorReview }, reviewer));
  const consent = await grant(f, preview);
  await assert.rejects(f.service.dispatch({ method: 'operation.execute', consentID: consent.consentID, scopeDigest: '0'.repeat(64) }, reviewer), /범위/);
  const result = await execute(f, consent);
  assert.equal(result.operation, 'export');
  await assert.rejects(execute(f, consent), /사용|동의/);
  assert.ok(readdirSync(join(f.authorityRoot, 'audit')).length >= 3);
});

test('expired consent, revocation and current policy changes survive fresh service instances', async t => {
  const f = fixture(t), first = await grant(f, await previewAll(f, 'export'));
  f.advance(120001);
  await assert.rejects(execute(f, first), /만료/);
  const second = await grant(f, await previewAll(f, 'export'));
  await f.service.dispatch({ method: 'consent.revoke', consentID: second.consentID }, reviewer);
  await assert.rejects(f.makeService().dispatch({ method: 'operation.execute', consentID: second.consentID, scopeDigest: second.scopeDigest }, reviewer), /철회/);
  const third = await grant(f, await previewAll(f, 'export'));
  f.changePolicy({ version: 'test/v2', localExport: false, rawLocalExport: false, delete: true });
  await assert.rejects(execute(f, third), /정책|현재/);
});

test('selected finalized export contains portable HTML, exact results, allowed evidence and missing/blocked manifest only', async t => {
  const f = fixture(t);
  unlinkSync(join(f.runRoot, f.screenPath));
  f.write('private-source-not-in-manifest.txt', 'MUST NOT EXPORT PRIVATE SOURCE');
  const consent = await grant(f, await previewAll(f, 'export'));
  const result = await execute(f, consent);
  assert.ok(result.exportID);
  const download = f.service.openDownload(result.exportID!, reviewer);
  closeSync(download.fd);
  const entries = tarEntries(readFileSync(join(f.authorityRoot, 'exports', `${result.exportID}.tar`)));
  assert.ok(entries.has('index.html')); assert.ok(entries.has('results.json')); assert.ok(entries.has('manifest.json'));
  const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { entries: { kind: string; state: string; included: boolean; portablePath: string | null }[] };
  const video = manifest.entries.find(item => item.kind === 'video')!;
  assert.equal(video.included, true);
  assert.deepEqual(entries.get(video.portablePath!), Buffer.from('test-owned-finalized-video-bytes'));
  assert.equal(manifest.entries.find(item => item.kind === 'screenshot')!.state, 'missing');
  assert.equal(manifest.entries.find(item => item.kind === 'report')!.included, false);
  assert.ok(![...entries.values()].some(bytes => bytes.includes('MUST NOT EXPORT PRIVATE SOURCE')));
  const results = JSON.parse(entries.get('results.json')!.toString()) as { rows: ProductReportRow[] };
  assert.equal(results.rows[0]!.business, 'FAIL'); assert.equal(results.rows[0]!.expected[0]!.description, '접수됨');
  assert.equal(readFileSync(join(f.runRoot, 'attempt-result.json'), 'utf8').includes('FAIL'), true);
  await f.service.dispatch({ method: 'consent.revoke', consentID: consent.consentID }, reviewer);
  assert.throws(() => f.makeService().openDownload(result.exportID!, reviewer), error => error instanceof ProductEvidenceError && error.status === 410 && error.code === 'export_unavailable');
});

test('active, cleanup unknown, ambiguous ownership and recovery evidence refuse destructive deletion', async t => {
  for (const change of ['active', 'cleanup', 'ownership', 'spool'] as const) {
    const f = fixture(t);
    if (change === 'active') { f.run.state = 'running'; f.run.attempts[0]!.state = 'running'; }
    if (change === 'cleanup') { f.run.state = 'unknown'; f.run.attempts[0]!.state = 'unknown'; f.run.attempts[0]!.cleanup = 'unknown'; }
    if (change === 'ownership') f.write('attempt-result.json', JSON.stringify({ attemptId: randomUUID(), revisionId: f.revisionID, runId: f.runID, business: 'FAIL', cleanup: 'confirmed' }));
    if (change === 'spool') { f.video.artifacts![0]!.status.spool = 'unknown'; writeJsonAtomic(join(f.runRoot, `video/${f.attemptID}/manifest.json`), f.video); }
    const preview = await previewAll(f, 'delete');
    assert.ok(preview.blocked.length > 0, change);
    await assert.rejects(grant(f, preview));
    assert.ok(existsSync(join(f.runRoot, f.videoPath)));
    assert.equal(readdirSync(join(f.authorityRoot, 'tombstones')).length, 0);
  }
});

test('missing copy inventories and directory diagnostics cannot claim complete deletion', async t => {
  const f = fixture(t);
  const spool = ensureDir(join(f.runRoot, 'video', f.attemptID, '.chrome-frames-unconfirmed'));
  writeFileSync(join(spool, 'frame-0001.jpg'), 'private-copy', { mode: 0o600 });
  f.video.artifacts![0]!.status.diagnostics = [spool];
  writeJsonAtomic(join(f.runRoot, `video/${f.attemptID}/manifest.json`), f.video);
  const preview = await previewAll(f, 'delete');
  assert.ok(preview.blocked.some(message => message.includes('복사본')));
  await assert.rejects(grant(f, preview));
  assert.ok(existsSync(join(spool, 'frame-0001.jpg')));
});

test('delete exact managed copies preserves original FAIL, receipts, definitions and journals; restore cannot reexpose', async t => {
  const f = fixture(t);
  f.write(`${f.videoPath}.integrity.json`, '{"valid":true}');
  const originals = new Map(['attempt-result.json', 'summary.json', 'journal.jsonl', 'scenario-revision.json', `video/${f.attemptID}/manifest.json`].map(path => [path, readFileSync(join(f.runRoot, path))]));
  const videoBytes = readFileSync(join(f.runRoot, f.videoPath));
  const exportConsent = await grant(f, await previewAll(f, 'export'));
  const exported = await execute(f, exportConsent);
  const consent = await grant(f, await previewAll(f, 'delete'));
  const result = await execute(f, consent);
  assert.ok(result.outcomes.length >= 3);
  assert.ok(result.outcomes.every(outcome => outcome.state === 'deleted'));
  assert.ok(!existsSync(join(f.runRoot, f.videoPath))); assert.equal(readFileSync(join(f.runRoot, `${f.videoPath}.integrity.json`), 'utf8'), '{"valid":true}');
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(f.runRoot, path)), bytes);
  assert.equal(f.run.attempts[0]!.business, 'FAIL');
  assert.throws(() => f.service.openDownload(exported.exportID!, reviewer));
  f.write(f.videoPath, videoBytes);
  assert.throws(() => assertProductEvidenceRead(f.root, f.runID, f.videoPath, f.authorityRoot), error => error instanceof ProductEvidenceError && error.status === 410);
  assert.throws(() => assertEvidenceDigestReadable(evidenceDigest(videoBytes), f.authorityRoot), ProductEvidenceError);
  assert.doesNotThrow(() => assertProductEvidenceRead(f.root, f.runID, 'summary.json', f.authorityRoot));
  const restored = f.makeService();
  assert.ok((await restored.library()).artifacts.filter(item => item.kind !== 'media-receipt').every(item => item.state === 'deleted'));
  assert.equal((await restored.reports()).rows[0]!.business, 'FAIL');
  assert.equal((await restored.reports()).rows[0]!.evidence, 'deleted');
  const resultOnly = await execute(f, await grant(f, await previewAll(f, 'export', [])));
  const resultDownload = f.service.openDownload(resultOnly.exportID!, reviewer);
  closeSync(resultDownload.fd);
  const relocated = ensureDir(join(dirname(f.root), 'relocated'));
  const relocatedRun = ensureDir(join(relocated, '.qa', 'runs', f.runID));
  ensureDir(dirname(join(relocatedRun, f.videoPath))); writeFileSync(join(relocatedRun, f.videoPath), videoBytes, { mode: 0o600 });
  assert.throws(() => assertProductEvidenceRead(relocated, f.runID, f.videoPath, f.authorityRoot), ProductEvidenceError);
});

test('a new managed copy or changed artifact invalidates consent rather than deleting beyond reviewed scope', async t => {
  const f = fixture(t), consent = await grant(f, await previewAll(f, 'delete'));
  const diagnostic = `video/${f.attemptID}/diagnostic.png`;
  f.write(diagnostic, 'new-private-diagnostic');
  f.video.artifacts![0]!.status.diagnostics.push(diagnostic);
  writeJsonAtomic(join(f.runRoot, `video/${f.attemptID}/manifest.json`), f.video);
  await assert.rejects(execute(f, consent), /변경|복사본/);
  assert.ok(existsSync(join(f.runRoot, f.videoPath)));
  const newer = await grant(f, await previewAll(f, 'delete'));
  f.write(f.videoPath, 'changed-after-consent');
  await assert.rejects(execute(f, newer), /변경|삭제/);
  assert.ok(existsSync(join(f.runRoot, f.videoPath)));
});

test('symptoms never merge distinct revision, actual target, required-check identity, conditions or verdict axes', () => {
  const base: ProductReportRow = { requestID: randomUUID(), runName: 'original', attemptID: randomUUID(), runID: 'one', revisionID: 'a'.repeat(64), testID: 'TC-007', target: { platform: 'desktop-chrome', deviceId: 'one' }, createdAt: at, business: 'FAIL', execution: 'unknown', evidence: 'incomplete', cleanup: 'unknown', code: 'assert_text_missing', expected: [], requiredChecks: ['check-A'], completedChecks: ['check-A'], actual: { code: 'assert_text_missing', message: '접수됨 없음' }, conditions: { status: 'verified', materialSha256: 'b'.repeat(64) }, limitations: [] };
  const same = { ...base, attemptID: randomUUID(), requestID: randomUUID(), runID: 'two' };
  const groups = groupProductSymptoms([base, same]);
  assert.equal(groups.find(group => group.category === 'product-fail')!.attemptIDs.length, 2);
  assert.deepEqual(groups.map(group => group.category).sort(), ['cleanup', 'evidence', 'product-fail', 'unknown']);
  for (const different of [{ ...same, revisionID: 'c'.repeat(64) }, { ...same, target: { ...same.target, deviceId: 'two' } }, { ...same, requiredChecks: ['check-B'] }, { ...same, conditions: { status: 'verified', materialSha256: 'd'.repeat(64) } }, { ...same, actual: { code: 'assert_text_missing', message: '다른 실제 증상' } }]) {
    assert.equal(groupProductSymptoms([base, different]).filter(group => group.category === 'product-fail').length, 2);
  }
  assert.equal(base.business, 'FAIL');
});

test('finalized segments retain incomplete coverage and gaps in selected portable exports', async t => {
  const f = fixture(t);
  f.video.state = 'incomplete';
  f.video.gaps = [{ from: at, to: '2026-11-01T00:00:00.100Z', reason: 'source_gap', basis: 'source' }];
  f.run.attempts[0]!.evidence = 'incomplete';
  writeJsonAtomic(join(f.runRoot, `video/${f.attemptID}/manifest.json`), f.video);
  const library = await f.service.library();
  const video = library.artifacts.find(item => item.kind === 'video')!;
  assert.equal(video.state, 'incomplete'); assert.equal(video.exportable, true); assert.equal(video.gaps.length, 1);
  const exported = await execute(f, await grant(f, await previewAll(f, 'export', [video.id])));
  const entries = tarEntries(readFileSync(join(f.authorityRoot, 'exports', `${exported.exportID}.tar`)));
  const manifest = z.object({ entries: z.array(z.object({ state: z.string(), gaps: z.array(z.unknown()), included: z.boolean() })) }).parse(JSON.parse(entries.get('manifest.json')!.toString()));
  assert.equal(manifest.entries[0]!.state, 'incomplete'); assert.equal(manifest.entries[0]!.included, true); assert.equal(manifest.entries[0]!.gaps.length, 1);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
});

test('partial deletion is durable confirmation-needed, never success, and still blocks restored originals', async t => {
  if (process.getuid?.() === 0) { t.skip('root bypasses directory unlink permissions'); return; }
  const f = fixture(t);
  const consent = await grant(f, await previewAll(f, 'delete'));
  const directory = dirname(join(f.runRoot, f.screenPath));
  chmodSync(directory, 0o500);
  let result: EvidenceOperationResult;
  try { result = await execute(f, consent); }
  finally { chmodSync(directory, 0o700); }
  assert.ok(result.outcomes.some(item => item.state === 'deletion-confirmation-needed'));
  assert.ok(result.outcomes.some(item => item.state === 'deleted'));
  assert.ok(existsSync(join(f.runRoot, f.screenPath)));
  assert.throws(() => f.makeService().openRunFile(f.runID, f.screenPath), ProductEvidenceError);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
  assert.equal((await f.service.reports()).rows[0]!.evidence, 'deletion-confirmation-needed');
});

test('download rechecks local principal, current policy, expiration and revocation without granting external transmission', async t => {
  const f = fixture(t), consent = await grant(f, await previewAll(f, 'export'));
  const result = await execute(f, consent);
  assert.throws(() => f.service.openDownload(result.exportID!, {}), ProductEvidenceError);
  assert.throws(() => f.service.openDownload(result.exportID!, { operatorReview: { principalId: 'different-local-user', channel: 'local-ui' } }), ProductEvidenceError);
  f.changePolicy({ version: 'test/v2', localExport: true, rawLocalExport: false, delete: true });
  assert.throws(() => f.service.openDownload(result.exportID!, reviewer), ProductEvidenceError);
  f.changePolicy({ version: 'test/v1', localExport: true, rawLocalExport: true, delete: true });
  f.advance(600001);
  assert.throws(() => f.service.openDownload(result.exportID!, reviewer), ProductEvidenceError);
});

test('only selected finalized local operations are authorized; active results and partial delete scope are blocked', async t => {
  const f = fixture(t), library = await f.service.library();
  const partial = await previewAll(f, 'delete', [library.artifacts.find(item => item.kind === 'video')!.id]);
  assert.ok(partial.blocked.length > 0);
  await assert.rejects(grant(f, partial));
  f.run.state = 'running'; f.run.attempts[0]!.state = 'running';
  const active = await previewAll(f, 'export', []);
  assert.ok(active.blocked.length > 0);
  await assert.rejects(grant(f, active));
  assert.equal(readdirSync(join(f.authorityRoot, 'exports')).length, 0);
});

test('held run media stops before the next delivered chunk when deletion becomes authoritative', async t => {
  const f = fixture(t), reader = f.service.openRunFile(f.runID, f.videoPath), received: Buffer[] = [];
  const consent = await grant(f, await previewAll(f, 'delete'));
  await assert.rejects(consumeRunFile(reader, received, async index => {
    if (index !== 1) return;
    const result = await execute(f, consent);
    assert.ok(result.outcomes.every(item => item.state === 'deleted'));
  }), error => error instanceof ProductEvidenceError && error.status === 410);
  assert.deepEqual(Buffer.concat(received), Buffer.from('test'));
  assert.throws(() => f.service.openRunFile(f.runID, f.videoPath), error => error instanceof ProductEvidenceError && error.status === 410);
});

test('an already-open restored duplicate in another run is stopped by original content revocation', async t => {
  const f = fixture(t), restoredID = 'restored-duplicate';
  const restored = ensureDir(join(f.root, '.qa', 'runs', restoredID));
  writeFileSync(join(restored, 'copy.mp4'), readFileSync(join(f.runRoot, f.videoPath)), { mode: 0o600 });
  const reader = f.service.openRunFile(restoredID, 'copy.mp4'), received: Buffer[] = [];
  const consent = await grant(f, await previewAll(f, 'delete'));
  await assert.rejects(consumeRunFile(reader, received, async index => { if (index === 1) await execute(f, consent); }), error => error instanceof ProductEvidenceError && error.status === 410);
  assert.deepEqual(Buffer.concat(received), Buffer.from('test'));
  assert.ok(existsSync(join(restored, 'copy.mp4')));
  assert.throws(() => f.makeService().openRunFile(restoredID, 'copy.mp4'), error => error instanceof ProductEvidenceError && error.status === 410);
});

test('restored revoked media cannot bypass content revocation by adopting an immutable filename', async t => {
  const f = fixture(t), bytes = readFileSync(join(f.runRoot, f.videoPath));
  const restoredID = 'restored-under-receipt-names', restored = ensureDir(join(f.root, '.qa', 'runs', restoredID));
  await execute(f, await grant(f, await previewAll(f, 'delete')));
  for (const path of ['copy.yaml', 'copy.source.json', 'manifest.json', 'events.jsonl']) {
    writeFileSync(join(restored, path), bytes, { mode: 0o600 });
    assert.throws(() => f.service.openRunFile(restoredID, path), error => error instanceof ProductEvidenceError && error.status === 410, path);
  }
});

test('run reader rejects unsafe names, symlinks, FIFOs, hard links and exposed modes before streaming', t => {
  const f = fixture(t), path = join(f.runRoot, f.screenPath);
  assert.throws(() => f.service.openRunFile(f.runID, '../summary.json'), ProductEvidenceError);
  assert.throws(() => f.service.openRunFile(`${f.runID}/nested`, 'summary.json'), ProductEvidenceError);
  unlinkSync(path); symlinkSync(join(f.runRoot, f.videoPath), path);
  assert.throws(() => f.service.openRunFile(f.runID, f.screenPath));
  unlinkSync(path); linkSync(join(f.runRoot, f.videoPath), path);
  assert.throws(() => f.service.openRunFile(f.runID, f.screenPath), ProductEvidenceError);
  unlinkSync(path); execFileSync('/usr/bin/mkfifo', [path]); chmodSync(path, 0o600);
  assert.throws(() => f.service.openRunFile(f.runID, f.screenPath), ProductEvidenceError);
  unlinkSync(path); f.write(f.screenPath, 'private'); chmodSync(path, 0o644);
  assert.throws(() => f.service.openRunFile(f.runID, f.screenPath), ProductEvidenceError);
  chmodSync(path, 0o600); chmodSync(dirname(path), 0o755);
  assert.throws(() => f.service.openRunFile(f.runID, f.screenPath), ProductEvidenceError);
});

test('held readers reject file, symlink, FIFO and ancestor replacements without opening replacements', async t => {
  for (const replacement of ['file', 'symlink', 'fifo', 'ancestor', 'mode', 'overwrite'] as const) {
    const f = fixture(t), reader = f.service.openRunFile(f.runID, f.screenPath), received: Buffer[] = [];
    await assert.rejects(consumeRunFile(reader, received, index => {
      if (index !== 1) return;
      const path = join(f.runRoot, f.screenPath);
      if (replacement === 'ancestor') {
        const directory = dirname(path);
        renameSync(directory, `${directory}-original`);
        ensureDir(directory); writeFileSync(path, 'substituted', { mode: 0o600 });
      } else if (replacement === 'mode') chmodSync(path, 0o644);
      else if (replacement === 'overwrite') writeFileSync(path, 'same-length-malicious-bytes!', { mode: 0o600 });
      else {
        renameSync(path, `${path}.original`);
        if (replacement === 'file') writeFileSync(path, 'substituted', { mode: 0o600 });
        if (replacement === 'symlink') symlinkSync(`${path}.original`, path);
        if (replacement === 'fifo') { execFileSync('/usr/bin/mkfifo', [path]); chmodSync(path, 0o600); }
      }
    }), error => error instanceof ProductEvidenceError && error.code === 'evidence_changed', replacement);
    assert.deepEqual(Buffer.concat(received), Buffer.from('test'), replacement);
  }
});

test('finite events reads retain only the captured prefix and reject prefix rewriting disguised as append', async t => {
  const f = fixture(t), path = join(f.runRoot, 'events.jsonl'), original = '{"seq":1}\n{"seq":2}\n';
  f.write('events.jsonl', original);
  const reader = f.service.openRunFile(f.runID, 'events.jsonl'), received: Buffer[] = [];
  await consumeRunFile(reader, received, index => {
    if (index === 1) appendFileSync(path, '{"seq":3}\n', { mode: 0o600 });
    if (index === 2) appendFileSync(path, '{"seq":4}\n', { mode: 0o600 });
  });
  assert.equal(reader.bytes, Buffer.byteLength(original));
  assert.equal(Buffer.concat(received).toString(), original);
  const tampered = f.service.openRunFile(f.runID, 'events.jsonl'), delivered: Buffer[] = [];
  await assert.rejects(consumeRunFile(tampered, delivered, index => {
    if (index !== 1) return;
    const fd = openSync(path, 'r+');
    try { writeSync(fd, Buffer.from('X'), 0, 1, 0); } finally { closeSync(fd); }
    appendFileSync(path, '{"seq":5}\n');
  }), error => error instanceof ProductEvidenceError && error.code === 'evidence_changed');
  assert.deepEqual(Buffer.concat(delivered), Buffer.from(original.slice(0, 4)));
});

test('events truncation and arbitrary media append do not receive the finite-events exception', async t => {
  for (const kind of ['events', 'media'] as const) {
    const f = fixture(t), relativePath = kind === 'events' ? 'events.jsonl' : f.videoPath;
    if (kind === 'events') f.write(relativePath, '{"seq":1}\n{"seq":2}\n');
    const reader = f.service.openRunFile(f.runID, relativePath);
    await assert.rejects(consumeRunFile(reader, [], index => {
      if (index !== 1) return;
      if (kind === 'events') truncateSync(join(f.runRoot, relativePath), 5);
      else appendFileSync(join(f.runRoot, relativePath), 'unreviewed');
    }), error => error instanceof ProductEvidenceError && error.code === 'evidence_changed');
  }
});

test('media deletion preserves held and fresh immutable result, journal, event and receipt readers', async t => {
  const f = fixture(t);
  f.write('events.jsonl', '{"seq":1}\n{"seq":2}\n');
  f.write(`${f.videoPath}.integrity.json`, '{"valid":true}');
  const paths = ['summary.json', 'attempt-result.json', 'journal.jsonl', 'events.jsonl', 'scenario-revision.json', `${f.videoPath}.integrity.json`];
  const originals = paths.map(path => readFileSync(join(f.runRoot, path)));
  const readers = paths.map(path => f.service.openRunFile(f.runID, path));
  await execute(f, await grant(f, await previewAll(f, 'delete')));
  for (const [index, reader] of readers.entries()) {
    const held: Buffer[] = [];
    await consumeRunFile(reader, held);
    assert.deepEqual(Buffer.concat(held), originals[index]);
    const fresh: Buffer[] = [];
    await consumeRunFile(f.service.openRunFile(f.runID, paths[index]!), fresh);
    assert.deepEqual(Buffer.concat(fresh), originals[index]);
  }
});

test('unrelated ancestor writes do not invalidate a held evidence descriptor', async t => {
  const f = fixture(t), reader = f.service.openRunFile(f.runID, f.videoPath), received: Buffer[] = [];
  await consumeRunFile(reader, received, index => {
    if (index !== 1) return;
    ensureDir(join(f.root, '.qa', 'runs', 'another-run'));
    writeFileSync(join(dirname(f.root), 'unrelated-user-file'), 'unrelated', { mode: 0o600 });
  });
  assert.equal(Buffer.concat(received).toString(), 'test-owned-finalized-video-bytes');
});

test('file permission ABA is rejected even after the private mode is restored', async t => {
  const f = fixture(t), reader = f.service.openRunFile(f.runID, f.videoPath), received: Buffer[] = [];
  await assert.rejects(consumeRunFile(reader, received, index => {
    if (index !== 1) return;
    const path = join(f.runRoot, f.videoPath);
    chmodSync(path, 0o400); chmodSync(path, 0o600);
  }), error => error instanceof ProductEvidenceError && error.code === 'evidence_changed');
  assert.deepEqual(Buffer.concat(received), Buffer.from('test'));
});

test('an ancestor symlink swap cannot redirect the held descriptor, including after restoration', async t => {
  const f = fixture(t), original = dirname(join(f.runRoot, f.screenPath)), replacement = ensureDir(join(f.runRoot, 'replacement'));
  writeFileSync(join(replacement, 'before.png'), 'must-not-be-delivered', { mode: 0o600 });
  const reader = f.service.openRunFile(f.runID, f.screenPath), received: Buffer[] = [];
  await consumeRunFile(reader, received, index => {
    if (index !== 1) return;
    renameSync(original, `${original}-held`);
    symlinkSync(replacement, original);
    try { assert.throws(() => reader.assertUnchanged(), ProductEvidenceError); }
    finally { unlinkSync(original); renameSync(`${original}-held`, original); }
  });
  assert.equal(Buffer.concat(received).toString(), 'test-owned-screenshot-bytes');
});

test('zero-length events stay a zero-length view even when events arrive before consumption', async t => {
  const f = fixture(t);
  f.write('events.jsonl', '');
  const reader = f.service.openRunFile(f.runID, 'events.jsonl'), received: Buffer[] = [];
  appendFileSync(join(f.runRoot, 'events.jsonl'), '{"seq":1}\n');
  await consumeRunFile(reader, received);
  assert.equal(reader.bytes, 0);
  assert.equal(Buffer.concat(received).length, 0);
});

test('an already-open export stops delivering chunks after consent revocation', async t => {
  const f = fixture(t), consent = await grant(f, await previewAll(f, 'export'));
  const exported = await execute(f, consent), reader = f.service.openDownload(exported.exportID!, reviewer), received: Buffer[] = [];
  await assert.rejects(consumeRunFile(reader, received, async index => {
    if (index === 1) await f.service.dispatch({ method: 'consent.revoke', consentID: consent.consentID }, reviewer);
  }));
  assert.equal(Buffer.concat(received).length, 4);
});

test('producer elements and source captures can be deleted without deleting the immutable effect journal', async t => {
  const f = fixture(t), elements = 'TC-007/desktop-chrome/step-01/elements.json', source = 'TC-007/desktop-chrome/step-01/source.xml';
  f.write(elements, '{"text":"private capture"}'); f.write(source, '<screen>private capture</screen>');
  const journal = readFileSync(join(f.runRoot, 'journal.jsonl'));
  f.manifest.entries.push(
    { kind: 'elements', relativePath: elements, sizeBytes: readFileSync(join(f.runRoot, elements)).length },
    { kind: 'source', relativePath: source, sizeBytes: readFileSync(join(f.runRoot, source)).length },
    { kind: 'log', relativePath: 'journal.jsonl', sizeBytes: journal.length },
  );
  writeJsonAtomic(join(f.runRoot, 'manifest.json'), f.manifest);
  const erased = await execute(f, await grant(f, await previewAll(f, 'delete')));
  assert.ok(erased.outcomes.every(item => item.state === 'deleted'));
  assert.equal(existsSync(join(f.runRoot, elements)), false); assert.equal(existsSync(join(f.runRoot, source)), false);
  assert.deepEqual(readFileSync(join(f.runRoot, 'journal.jsonl')), journal);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
});

test('raw source-only exports cannot use a sanitized-text policy as permission', async t => {
  const f = fixture(t), path = 'TC-007/desktop-chrome/step-01/source.xml';
  f.write(path, '<screen>unmasked personal details</screen>');
  f.manifest.entries.push({ kind: 'source', relativePath: path, sizeBytes: readFileSync(join(f.runRoot, path)).length });
  writeJsonAtomic(join(f.runRoot, 'manifest.json'), f.manifest);
  const artifact = (await f.service.library()).artifacts.find(item => item.relativePath === path)!;
  f.changePolicy({ version: 'no-raw-export', localExport: true, rawLocalExport: false, delete: true });
  const preview = await previewAll(f, 'export', [artifact.id]);
  await assert.rejects(grant(f, preview), ProductEvidenceError);
  assert.deepEqual(readFileSync(join(f.runRoot, path)), Buffer.from('<screen>unmasked personal details</screen>'));
});

test('revoked raw JSON cannot be restored as a typed report observation', async t => {
  const f = fixture(t), privateReason = '삭제한 로그의 내용은 새 관측 결과가 아님', path = 'logs/private.log';
  const bytes = JSON.stringify({ runId: f.runID, tests: [{ id: 'TC-007', platform: 'desktop-chrome', deviceId: 'owned-chrome-test', verdict: 'FAIL', code: 'assert_text_missing', reason: privateReason, steps: [] }] });
  f.write(path, bytes);
  f.manifest.entries.push({ kind: 'log', relativePath: path, sizeBytes: Buffer.byteLength(bytes) });
  writeJsonAtomic(join(f.runRoot, 'manifest.json'), f.manifest);
  await execute(f, await grant(f, await previewAll(f, 'delete')));
  f.write('summary.json', bytes);
  const report = await f.makeService().reports();
  assert.equal(JSON.stringify(report).includes(privateReason), false);
  assert.equal(report.rows[0]!.business, 'FAIL');
  assert.deepEqual(report.rows[0]!.expected, f.revision.definition.checks);
});

test('results-only exports still require raw export permission for actual observations and conditions', async t => {
  const f = fixture(t);
  f.changePolicy({ version: 'no-raw-results', localExport: true, rawLocalExport: false, delete: true });
  const preview = await previewAll(f, 'export', []);
  await assert.rejects(grant(f, preview), ProductEvidenceError);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
});

test('Native reservation is a protected private empty original inode, not an arbitrary path or agent export grant', async t => {
  const f = fixture(t), { preview, exported, lease } = await nativeExport(f);
  const stat = lstatSync(lease.path, { bigint: true });
  assert.equal(lease.directory, join(f.authorityRoot, 'native-downloads', lease.id));
  assert.equal(lease.path, join(lease.directory, 'payload.tar'));
  assert.equal(stat.size, 0n); assert.equal(stat.nlink, 1n); assert.equal(Number(stat.mode & 0o777n), 0o600);
  assert.equal(lstatSync(lease.directory).mode & 0o777, 0o700);
  assert.deepEqual(lease.identity, { device: stat.dev.toString(), inode: stat.ino.toString(), uid: Number(stat.uid) });
  assert.equal(lease.scopeDigest, preview.scopeDigest); assert.equal(lease.policyDigest, preview.policyDigest);
  assert.deepEqual({ bytes: lease.bytes, sha256: lease.sha256 }, hashPrivateEvidence(f.authorityRoot, `exports/${exported.exportID}.tar`));
  for (const request of [{ method: 'native-download.reserve', exportID: exported.exportID }, { method: 'native-download.pending' }, { method: 'native-download.retire', id: lease.id, secret: lease.secret }, { method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }]) await assert.rejects(f.service.dispatch(request), /로컬 사용자/);
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID, path: join(f.root, 'arbitrary') }, reviewer));
  const other = { operatorReview: { channel: 'local-ui' as const, principalId: 'another-local-user' } };
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, other));
  assert.equal(NativeDownloadPending.parse(await f.service.dispatch({ method: 'native-download.pending' }, other)).records.length, 0);
  assert.equal(NativeDownloadPending.parse(await f.makeService().dispatch({ method: 'native-download.pending' }, reviewer)).records[0]!.id, lease.id);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
});

test('Native reserve revalidates export expiry, revocation, policy, reviewed scope and archive identity', async t => {
  for (const change of ['expiry', 'revocation', 'policy', 'scope', 'archive', 'export-identity', 'project', 'runs', 'digests'] as const) {
    const f = fixture(t), consent = await grant(f, await previewAll(f, 'export')), exported = await execute(f, consent);
    if (change === 'expiry') f.advance(600001);
    if (change === 'revocation') await f.service.dispatch({ method: 'consent.revoke', consentID: consent.consentID }, reviewer);
    if (change === 'policy') f.changePolicy({ version: 'revoked-raw', localExport: true, rawLocalExport: false, delete: true });
    if (['scope', 'export-identity', 'project', 'runs', 'digests'].includes(change)) {
      const path = join(f.authorityRoot, 'exports', `${exported.exportID}.json`), metadata = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (change === 'scope') metadata.scopeDigest = '0'.repeat(64);
      if (change === 'export-identity') metadata.exportID = randomUUID();
      if (change === 'project') metadata.projectDigest = '0'.repeat(64);
      if (change === 'runs') metadata.authorizedRunIDs = ['not-the-original-run'];
      if (change === 'digests') metadata.digests = [];
      writeJsonAtomic(path, metadata);
    }
    if (change === 'archive') appendFileSync(join(f.authorityRoot, 'exports', `${exported.exportID}.tar`), 'changed');
    await assert.rejects(f.makeService().dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), change);
    assert.equal(existsSync(join(f.authorityRoot, 'native-downloads')), false, change);
    assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
  }
});

test('pending Native copies block preview and already-consented execute before any original or tombstone mutation', async t => {
  const f = fixture(t), deletion = await grant(f, await previewAll(f, 'delete'));
  const originals = new Map([f.videoPath, f.screenPath, 'report.html', 'attempt-result.json', 'summary.json', 'journal.jsonl'].map(path => [path, readFileSync(join(f.runRoot, path))]));
  const { lease } = await nativeExport(f);
  writeFileSync(lease.path, 'in-progress-copy');
  const preview = await previewAll(f, 'delete');
  await assert.rejects(grant(f, preview)); await assert.rejects(execute(f, deletion));
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(f.runRoot, path)), bytes);
  for (const directory of ['tombstones', 'run-tombstones', 'revoked-digests']) assert.deepEqual(readdirSync(join(f.authorityRoot, directory)), []);
  assert.equal(readFileSync(lease.path, 'utf8'), 'in-progress-copy');
  assert.equal(existsSync(join(lease.directory, 'retired.json')), false);
  await closeNative(f, lease);
  const fresh = await previewAll(f, 'delete');
  assert.deepEqual(fresh.blocked, []);
  const result = await execute(f, await grant(f, fresh));
  assert.ok(result.outcomes.every(outcome => outcome.state === 'deleted'));
  for (const path of ['attempt-result.json', 'summary.json', 'journal.jsonl']) assert.deepEqual(readFileSync(join(f.runRoot, path)), originals.get(path));
  assert.equal((await f.makeService().reports()).rows[0]!.business, 'FAIL');
});

test('retire never unlinks a producer and acknowledgement requires original secret, identity, retirement, receipt and absence', async t => {
  const f = fixture(t), { lease } = await nativeExport(f), fd = openSync(lease.path, 'r+');
  const acknowledge = (secret = lease.secret) => f.service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret }, reviewer);
  nativeReceipt(lease);
  await assert.rejects(acknowledge(), error => error instanceof ProductEvidenceError && error.code === 'native_download_cleanup_required');
  await assert.rejects(f.service.dispatch({ method: 'native-download.retire', id: lease.id, secret: '0'.repeat(64) }, reviewer));
  assert.equal(existsSync(join(lease.directory, 'retired.json')), false);
  await f.service.dispatch({ method: 'native-download.retire', id: lease.id, secret: lease.secret }, reviewer);
  try {
    writeSync(fd, 'still-owned-producer');
    await assert.rejects(acknowledge(), error => error instanceof ProductEvidenceError && error.code === 'native_download_cleanup_required');
    assert.equal(fstatSync(fd, { bigint: true }).ino.toString(), lease.identity.inode);
    unlinkSync(lease.path); commitDirectory(lease.directory);
    unlinkSync(join(lease.directory, 'cleanup.json'));
    await assert.rejects(acknowledge());
    assert.equal(NativeDownloadPending.parse(await f.service.dispatch({ method: 'native-download.pending' }, reviewer)).records.length, 1);
  } finally { closeSync(fd); }
  for (const change of [
    { id: randomUUID() }, { secret: '0'.repeat(64) }, { identity: { ...lease.identity, inode: '0' } },
    { identity: { ...lease.identity, device: '0' } }, { identity: { ...lease.identity, uid: lease.identity.uid + 1 } },
    { payloadRemoved: false }, { localStaging: 'unknown' }, { localStaging: 'pending' }, { closedAt: 'not-an-ISO-time' },
  ]) {
    nativeReceipt(lease, change); await assert.rejects(acknowledge());
    await assert.rejects(grant(f, await previewAll(f, 'delete')), ProductEvidenceError);
  }
  nativeReceipt(lease, { localStaging: 'removed' });
  await assert.rejects(acknowledge('0'.repeat(64)));
  await assert.rejects(f.service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, { operatorReview: { channel: 'local-ui', principalId: 'other' } }));
  assert.deepEqual(await acknowledge(), { closed: true });
  assert.deepEqual(await f.makeService().dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, reviewer), { closed: true });
  assert.equal(NativeDownloadPending.parse(await f.makeService().dispatch({ method: 'native-download.pending' }, reviewer)).records.length, 0);
});

test('cleanup receipts are exact bounded private regular files and never authorize deleting a user destination', async t => {
  const f = fixture(t), { lease } = await nativeExport(f), receipt = join(lease.directory, 'cleanup.json');
  await f.service.dispatch({ method: 'native-download.retire', id: lease.id, secret: lease.secret }, reviewer);
  unlinkSync(lease.path); commitDirectory(lease.directory);
  const outside = join(f.root, 'user-chosen-saved-export.tar');
  writeFileSync(outside, 'user-owned-saved-bytes', { mode: 0o600 });
  for (const kind of ['symlink', 'hardlink', 'mode', 'fifo', 'oversize', 'destination'] as const) {
    nativeReceipt(lease);
    if (kind === 'symlink' || kind === 'hardlink' || kind === 'fifo') {
      unlinkSync(receipt);
      if (kind === 'symlink') symlinkSync(outside, receipt);
      if (kind === 'hardlink') linkSync(outside, receipt);
      if (kind === 'fifo') { execFileSync('/usr/bin/mkfifo', [receipt]); chmodSync(receipt, 0o600); }
    }
    if (kind === 'mode') chmodSync(receipt, 0o644);
    if (kind === 'oversize') appendFileSync(receipt, ' '.repeat(4096));
    if (kind === 'destination') nativeReceipt(lease, { localStaging: 'removed', path: outside });
    await assert.rejects(f.service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, reviewer), kind);
    assert.equal(readFileSync(outside, 'utf8'), 'user-owned-saved-bytes');
    unlinkSync(receipt);
  }
  nativeReceipt(lease, { localStaging: 'promoted' });
  assert.deepEqual(await f.service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, reviewer), { closed: true });
  assert.equal(readFileSync(outside, 'utf8'), 'user-owned-saved-bytes');
});

test('revocation, expiry and changed raw policy fence pending Native leases without claiming cleanup or removing bytes', async t => {
  for (const reason of ['revocation', 'expiry', 'policy'] as const) {
    const f = fixture(t), { consent, exported, lease } = await nativeExport(f);
    writeFileSync(lease.path, 'pending-private-copy');
    if (reason === 'revocation') await f.service.dispatch({ method: 'consent.revoke', consentID: consent.consentID }, reviewer);
    if (reason === 'expiry') f.advance(600001);
    if (reason === 'policy') f.changePolicy({ version: 'new-policy', localExport: false, rawLocalExport: false, delete: true });
    const pending = NativeDownloadPending.parse(await f.makeService().dispatch({ method: 'native-download.pending' }, reviewer));
    assert.equal(pending.records[0]!.retired, true);
    assert.ok(existsSync(join(lease.directory, 'retired.json')));
    assert.equal(readFileSync(lease.path, 'utf8'), 'pending-private-copy');
    await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer));
    await assert.rejects(grant(f, await previewAll(f, 'delete')), ProductEvidenceError);
    await closeNative(f, lease);
    assert.deepEqual((await previewAll(f, 'delete')).blocked, []);
    assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
  }
});

test('a verified closed Native lease stays fenced across restart and restored payloads return to pending', async t => {
  const f = fixture(t), { exported, lease } = await nativeExport(f);
  await closeNative(f, lease);
  const service = f.makeService();
  assert.equal(NativeDownloadPending.parse(await service.dispatch({ method: 'native-download.pending' }, reviewer)).records.length, 0);
  const next = NativeDownloadLease.parse(await service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer));
  assert.notEqual(next.id, lease.id); assert.notEqual(next.secret, lease.secret);
  assert.equal(existsSync(lease.path), false); assert.ok(existsSync(join(lease.directory, 'retired.json')));
  await closeNative(f, next);
  writeFileSync(lease.path, 'restored-native-cache', { mode: 0o600, flag: 'wx' });
  const restored = NativeDownloadPending.parse(await f.makeService().dispatch({ method: 'native-download.pending' }, reviewer));
  assert.deepEqual(restored.records.map(record => record.id), [lease.id]);
  await assert.rejects(service.dispatch({ method: 'native-download.acknowledge', id: lease.id, secret: lease.secret }, reviewer), error => error instanceof ProductEvidenceError && error.code === 'native_download_cleanup_required');
  await assert.rejects(grant(f, await previewAll(f, 'delete')), ProductEvidenceError);
  assert.equal(readFileSync(lease.path, 'utf8'), 'restored-native-cache');
});

test('a damaged or unsafe retirement fence or closed marker makes the Native pending list a typed cleanup-required refusal', async t => {
  const f = fixture(t), { lease } = await nativeExport(f);
  const refused = (error: unknown): boolean => error instanceof ProductEvidenceError && error.code === 'native_download_cleanup_required';
  const fence = join(lease.directory, 'retired.json');
  writeFileSync(fence, '{"schema":', { mode: 0o600 });
  await assert.rejects(f.service.dispatch({ method: 'native-download.pending' }, reviewer), refused, 'truncated fence');
  writeFileSync(fence, '{"schema":"garbled"}', { mode: 0o600 });
  await assert.rejects(f.service.dispatch({ method: 'native-download.pending' }, reviewer), refused, 'unparsable fence');
  chmodSync(fence, 0o644);
  await assert.rejects(f.service.dispatch({ method: 'native-download.pending' }, reviewer), refused, 'fence outside the private boundary');
  const other = fixture(t), closed = await nativeExport(other);
  writeFileSync(join(closed.lease.directory, 'closed.json'), '{"schema":', { mode: 0o600 });
  await assert.rejects(other.service.dispatch({ method: 'native-download.pending' }, reviewer), refused, 'truncated closed marker');
});

test('pending Native provenance blocks identical content restored under a different logical run', async t => {
  const f = fixture(t), { lease } = await nativeExport(f), restoredID = 'restored-logical-run';
  const restored = join(f.root, '.qa', 'runs', restoredID);
  cpSync(f.runRoot, restored, { recursive: true });
  const directories = [restored];
  for (const directory of directories) {
    chmodSync(directory, 0o700);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) directories.push(join(directory, entry.name));
  }
  f.run.attempts[0]!.runId = restoredID;
  writeJsonAtomic(join(restored, 'attempt-result.json'), { ...JSON.parse(readFileSync(join(restored, 'attempt-result.json'), 'utf8')), runId: restoredID });
  writeJsonAtomic(join(restored, 'manifest.json'), { ...f.manifest, runId: restoredID });
  writeJsonAtomic(join(restored, `video/${f.attemptID}/manifest.json`), { ...f.video, binding: { ...f.video.binding, runId: restoredID } });
  writeJsonAtomic(join(restored, 'summary.json'), { ...JSON.parse(readFileSync(join(restored, 'summary.json'), 'utf8')), runId: restoredID });
  const preview = await previewAll(f, 'delete');
  assert.ok(preview.artifacts.some(item => item.runID === restoredID && item.relativePath === f.videoPath));
  await assert.rejects(grant(f, preview));
  assert.ok(existsSync(join(restored, f.videoPath)));
  assert.deepEqual(readdirSync(join(f.authorityRoot, 'tombstones')), []);
  await closeNative(f, lease);
  await execute(f, await grant(f, await previewAll(f, 'delete')));
  assert.equal(existsSync(join(restored, f.videoPath)), false);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
});

test('Native pending quota counts retired unknown leases until real cleanup and archive size is bounded before reserve', async t => {
  const f = fixture(t), { exported, lease } = await nativeExport(f), leases = [lease];
  for (let count = 1; count < 4; count++) leases.push(NativeDownloadLease.parse(await f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer)));
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), error => error instanceof ProductEvidenceError && error.code === 'native_download_limit' && error.status === 507);
  await f.service.dispatch({ method: 'native-download.retire', id: lease.id, secret: lease.secret }, reviewer);
  await assert.rejects(f.makeService().dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), error => error instanceof ProductEvidenceError && error.code === 'native_download_limit' && error.status === 507);
  await closeNative(f, lease);
  const fresh = NativeDownloadLease.parse(await f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer));
  assert.ok(!leases.some(item => item.id === fresh.id));
  assert.equal(NativeDownloadPending.parse(await f.service.dispatch({ method: 'native-download.pending' }, reviewer)).records.length, 4);
  const large = fixture(t), result = await execute(large, await grant(large, await previewAll(large, 'export')));
  truncateSync(join(large.authorityRoot, 'exports', `${result.exportID}.tar`), 2 * 1024 ** 3 + 1);
  await assert.rejects(large.service.dispatch({ method: 'native-download.reserve', exportID: result.exportID }, reviewer));
  assert.equal(existsSync(join(large.authorityRoot, 'native-downloads')), false);
});

test('ordinary HTTP archives retain their authority while older missing Native provenance cannot reserve a lease', async t => {
  const f = fixture(t), exported = await execute(f, await grant(f, await previewAll(f, 'export')));
  const path = join(f.authorityRoot, 'exports', `${exported.exportID}.json`);
  const metadata = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete metadata.projectDigest; delete metadata.authorizedRunIDs;
  writeJsonAtomic(path, metadata);
  const reader = f.makeService().openDownload(exported.exportID!, reviewer);
  try { reader.assertUnchanged(); assert.ok(reader.bytes > 0); } finally { closeSync(reader.fd); }
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), /원래 프로젝트/);
  assert.equal(existsSync(join(f.authorityRoot, 'native-downloads')), false);
});

test('Native results-only export after media deletion retains immutable results without resurrecting removed payloads', async t => {
  const f = fixture(t);
  await execute(f, await grant(f, await previewAll(f, 'delete')));
  const exported = await execute(f, await grant(f, await previewAll(f, 'export', [])));
  const lease = NativeDownloadLease.parse(await f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer));
  const pending = NativeDownloadPending.parse(await f.makeService().dispatch({ method: 'native-download.pending' }, reviewer));
  assert.equal(pending.records[0]!.id, lease.id); assert.equal(pending.records[0]!.retired, false);
  assert.equal(existsSync(join(f.runRoot, f.videoPath)), false);
  assert.equal((await f.service.reports()).rows[0]!.business, 'FAIL');
  await closeNative(f, lease);
  assert.equal(existsSync(lease.path), false);
});

test('evidence reads accept OS-alias ancestors such as the temp directory but refuse a symlinked storage root', t => {
  const base = mkdtempSync(join(tmpdir(), 'qautra-evidence-root-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = ensureDir(join(base, 'root'));
  writeFileSync(join(root, 'record.json'), '{"ok":true}', { mode: 0o600 });
  assert.equal(hashPrivateEvidence(root, 'record.json').bytes, 11);
  const alias = join(base, 'alias');
  symlinkSync(root, alias);
  assert.throws(() => hashPrivateEvidence(alias, 'record.json'), (error: unknown) => error instanceof ProductEvidenceError && error.code === 'evidence_boundary_unsafe');
});

test('a persisted consent without a parsable offset expiry is refused for export, delete, download and Native fences', async t => {
  const garble = (authorityRoot: string, consentID: string, expiresAt: string | undefined): void => {
    const path = join(authorityRoot, 'consents', `${consentID}.json`), record = JSON.parse(readFileSync(path, 'utf8')) as { preview: Record<string, unknown> };
    if (expiresAt === undefined) delete record.preview.expiresAt; else record.preview.expiresAt = expiresAt;
    writeJsonAtomic(path, record);
  };
  const invalid = (error: unknown): boolean => error instanceof ProductEvidenceError && error.code === 'consent_record_invalid';
  for (const operation of ['export', 'delete'] as const) for (const expiresAt of [undefined, 'not-a-date', '2099-01-01T00:00:00']) {
    const f = fixture(t), consent = await grant(f, await previewAll(f, operation));
    garble(f.authorityRoot, consent.consentID, expiresAt);
    await assert.rejects(execute(f, consent), invalid, `${operation}:${expiresAt}`);
    assert.ok(existsSync(join(f.runRoot, f.videoPath)));
    assert.deepEqual(readdirSync(join(f.authorityRoot, 'exports')), []);
    assert.deepEqual(readdirSync(join(f.authorityRoot, 'tombstones')), []);
  }
  const f = fixture(t), { consent, exported, lease } = await nativeExport(f);
  garble(f.authorityRoot, consent.consentID, 'not-a-date');
  assert.throws(() => f.service.openDownload(exported.exportID!, reviewer), invalid);
  assert.equal(NativeDownloadPending.parse(await f.service.dispatch({ method: 'native-download.pending' }, reviewer)).records.find(item => item.id === lease.id)?.retired, true);
});

test('a failed export write removes the partial archive', async t => {
  const f = fixture(t);
  const service = new ProductEvidenceService({ root: f.root, authorityRoot: f.authorityRoot, query: f.query, now: () => Date.parse(at), renderPortableHtml: () => { throw new Error('renderer failed'); } });
  const failing = { service, requestID: f.requestID };
  await assert.rejects(execute(failing, await grant(failing, await previewAll(failing, 'export'))), /renderer failed/);
  assert.deepEqual(readdirSync(join(f.authorityRoot, 'exports')), []);
});

test('Native reserve failure leaves no lease-less entry and a pre-existing orphan is a typed refusal, not a raw ENOENT', async t => {
  const f = fixture(t), registry = new NativeDownloadRegistry(f.authorityRoot, () => Date.parse(at));
  assert.throws(() => registry.reserve({ exportID: randomUUID(), consentID: randomUUID(), principal: 'local-test-user', projectDigest: 'not-a-digest', scopeDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), expiresAt: at, runIDs: [], revocableRunIDs: [], digests: [], bytes: 1, sha256: 'c'.repeat(64) }));
  assert.deepEqual(readdirSync(registry.root), []);
  assert.deepEqual(registry.pending('local-test-user').records, []);
  assert.throws(() => registry.retire(randomUUID(), 'd'.repeat(64), 'local-test-user'), (error: unknown) => error instanceof ProductEvidenceError && error.code === 'native_download_missing');
  const exported = await execute(f, await grant(f, await previewAll(f, 'export')));
  const orphan = join(registry.root, randomUUID());
  mkdirSync(orphan, { mode: 0o700 });
  const refused = (error: unknown): boolean => error instanceof ProductEvidenceError && error.code === 'native_download_cleanup_required';
  assert.throws(() => f.service.openDownload(exported.exportID!, reviewer), refused);
  await assert.rejects(f.service.dispatch({ method: 'native-download.pending' }, reviewer), refused);
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), refused);
  await assert.rejects(grant(f, await previewAll(f, 'export')), refused);
  await assert.rejects(previewAll(f, 'delete'), refused);
  assert.ok(existsSync(orphan));
  writeFileSync(join(orphan, 'lease.json'), '{"schema":"garbled"}', { mode: 0o600 });
  await assert.rejects(f.service.dispatch({ method: 'native-download.pending' }, reviewer), refused);
  writeFileSync(join(orphan, 'lease.json'), '{"schema":', { mode: 0o600 });
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), refused, 'truncated JSON');
  chmodSync(join(orphan, 'lease.json'), 0o644);
  await assert.rejects(f.service.dispatch({ method: 'native-download.reserve', exportID: exported.exportID }, reviewer), refused, 'file outside the private boundary');
});
