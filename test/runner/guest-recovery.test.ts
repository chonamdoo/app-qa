import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import { sha256, writeJsonAtomic } from '../../src/core/fsx.ts';
import { createProjectFixtureGuard } from '../../src/runner/project-fixture.ts';
import { regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { chromeAttemptRecovery } from '../../src/drivers/chrome-attempt-recovery.ts';
import { guestAttemptRecovery } from '../../src/drivers/vm/attempt-recovery.ts';
import { latestRecoveryObservation, verifyExecutionRecovery } from '../../src/runner/recovery.ts';
import { guestRecoveryFixture } from '../drivers/fixtures/guest-recovery.ts';
import { fixture } from '../fixtures/project-fixture.ts';

async function original(t: TestContext, separateAdmission = false) {
  const f = await fixture(t);
  const machineId = randomUUID(), contextId = randomUUID(), recorderId = randomUUID();
  const target = { platform: 'desktop-safari' as const, deviceId: `guest:${contextId}` };
  f.subject.target = target;
  for (const kind of ['launch', 'terminate', 'observe', 'capture-screen', 'record-video'] as const) f.subject.scope.operations.push({ kind, effect: 'read', entityIds: [], sinkIds: [] });
  f.subject.scope.effects.push('read');
  f.evidence.subject = structuredClone(f.subject);
  f.adapter.subjectSha256 = regressionGrantSubjectSha256(f.subject); f.save();
  const attemptId = randomUUID(), ownerId = `attempt:${attemptId}`, binding = f.bind();
  const guard = createProjectFixtureGuard({ root: f.root, binding, attemptId, ownerId });
  await f.start(guard);
  const directory = separateAdmission ? mkdtempSync(join(tmpdir(), 'qautra-original-guest-admission-')) : join(f.root, '.qa', 'admission');
  if (separateAdmission) t.after(() => rmSync(directory, { recursive: true, force: true }));
  const admission = createExecutionAdmission(directory, { verifyRecovery: scope => verifyExecutionRecovery(directory, scope, chromeAttemptRecovery, guestAttemptRecovery) });
  const held = admission.acquire(ownerId, `target:${f.subject.target.deviceId}`);
  const execution = admission.ownerContext()!;
  const runDir = join(f.root, '.qa', 'runs', 'original-guest');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const outcome = join(runDir, 'attempt-result.json');
  writeFileSync(outcome, JSON.stringify({ business: 'FAIL', evidence: 'incomplete', requiredChecks: ['expected-a', 'expected-b'] }), { mode: 0o600 });
  const outcomeDigest = sha256(readFileSync(outcome));
  const identity = { machineId, contextId, recorderId, generation: 1, epoch: 1, guestPid: 1234, attemptId, runId: 'original-guest' };
  const stored = guestRecoveryFixture({
    context: { root: f.root, runDir, runId: identity.runId, attemptId, revisionId: 'a'.repeat(64), testId: 'original-tc', ownerId, fixtureSeedId: guard.recoverySeedId, grantId: binding.grantId, grantSha256: binding.grantSha256, subjectSha256: regressionGrantSubjectSha256(f.subject), target },
    execution: { ...execution, resources: [...execution.resources] }, identity, evidenceFile: join(runDir, 'video.mov'),
  });
  admission.registerRecoverySource(execution, stored.source);
  held.unknown('original_controller_lost');
  // These signed files exercise the reader/composer boundary, not an actual VZ stop or Safari recording.
  function sealPartialInventory(problems: string[] = []) {
    stored.seal('stop', { schema: 'qautra/guest-native-stop/v1', recorderId, bindingSha256: stored.source.bindingSha256, nativeGeneration: stored.binding.native.nativeGeneration, observedAt: new Date().toISOString(), observation: 'vz-delegate-stop' });
    const spool = join(stored.binding.machinesRoot, machineId, 'status/recordings', contextId, recorderId);
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    const final = { identity, state: 'incomplete', capture: 'stopped', encoder: 'failed', media: 'partial', readyAt: null, startedAt: null, frames: 0, width: 0, height: 0, code: 'channel_lost' };
    const status = { identity, state: 'failed', readyAt: null, heartbeatAt: 1, frames: 0, width: 0, height: 0, code: 'channel_lost', firstFrameAt: null, capture: 'stopped', encoder: 'failed' };
    writeJsonAtomic(join(spool, 'status.json'), status); writeJsonAtomic(join(spool, 'final.json'), final);
    writeFileSync(join(spool, 'video.mov'), 'truncated-recording', { mode: 0o600 });
    const artifacts = (['status.json', 'final.json', 'video.mov'] as const).map(name => {
      const file = join(spool, name), bytes = readFileSync(file), stat = lstatSync(file);
      return { name, location: 'spool' as const, identity: `${stat.dev}:${stat.ino}`, bytes: bytes.length, sha256: sha256(bytes) };
    });
    stored.seal('inventory', { schema: 'qautra/guest-recorder-inventory/v1', recorderId, bindingSha256: stored.source.bindingSha256, nativeGeneration: stored.binding.native.nativeGeneration, sealedAt: new Date().toISOString(), capture: 'closed', encoder: 'failed', media: 'partial', video: 'incomplete', artifacts, status, final, problems });
  }
  return { f, guard, directory, admission, stored, identity, outcome, outcomeDigest, sealPartialInventory };
}

it('keeps original guest resources quarantined without native terminal or complete inventory', async t => {
  const x = await original(t);
  await x.guard.settle(); await x.guard.cleanup();
  const before = { prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests };
  await assert.rejects(x.admission.reconcile());
  assert.equal(x.admission.status().state, 'unknown');
  let row = latestRecoveryObservation(x.directory)!.sources[0]!;
  assert.equal(row.checks.find(check => check.kind === 'binding')!.status, 'verified');
  assert.equal(row.checks.find(check => check.kind === 'native-stop')!.status, 'blocked');
  x.sealPartialInventory(['guest_original_inventory_unfinalized']);
  await assert.rejects(x.admission.reconcile());
  row = latestRecoveryObservation(x.directory)!.sources[0]!;
  assert.equal(row.checks.find(check => check.kind === 'native-stop')!.status, 'verified');
  assert.equal(row.checks.find(check => check.kind === 'evidence')!.status, 'blocked');
  assert.equal(row.video, 'incomplete');
  assert.equal(sha256(readFileSync(x.outcome)), x.outcomeDigest);
  assert.deepEqual({ prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests }, before);
});

it('requires original backend cleanup despite signed native termination and preserves incomplete video after recovery', async t => {
  const x = await original(t);
  x.sealPartialInventory();
  await assert.rejects(x.admission.reconcile());
  let row = latestRecoveryObservation(x.directory)!.sources[0]!;
  assert.equal(row.checks.find(check => check.kind === 'native-stop')!.status, 'verified');
  assert.equal(row.checks.find(check => check.kind === 'evidence')!.status, 'verified');
  assert.equal(row.checks.find(check => check.kind === 'fixture')!.status, 'blocked');
  x.f.lease()!.expiresAt = '2000-01-01T00:00:00.000Z';
  x.f.restoreExpiredLease();
  const before = { prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests };
  await x.admission.reconcile();
  assert.equal(x.admission.status().state, 'idle');
  row = latestRecoveryObservation(x.directory)!.sources[0]!;
  assert.ok(row.checks.every(check => check.status === 'verified'));
  assert.equal(row.video, 'incomplete'); assert.deepEqual(row.segments, []);
  assert.equal(sha256(readFileSync(x.outcome)), x.outcomeDigest);
  assert.deepEqual({ prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests }, before);
});

it('ignores replacement current fixture configuration and rejects a changed original guest binding', async t => {
  const x = await original(t), other = await fixture(t);
  x.sealPartialInventory(); await x.guard.settle(); await x.guard.cleanup();
  x.f.state.enforcementAdapter = structuredClone(x.f.adapter);
  x.f.adapter.endpoint = `${other.origin}/guard`; x.f.save();
  const previous = x.f.state.requests;
  await x.admission.reconcile();
  assert.equal(x.admission.status().state, 'idle');
  assert.ok(x.f.state.requests > previous); assert.equal(other.state.requests, 0);
  x.stored.seal('binding', { ...x.stored.binding, native: { ...x.stored.binding.native, nativeGeneration: randomUUID() } });
  assert.throws(() => guestAttemptRecovery.read(join(x.f.root, '.qa/instances'), x.stored.source, x.stored.binding.execution), error => (error as { code: string }).code === 'guest_recovery_binding_changed');
  assert.equal(sha256(readFileSync(x.outcome)), x.outcomeDigest);
});

it('recovers the original guest from a separate admission authority without replaying QA', async t => {
  const x = await original(t, true);
  x.sealPartialInventory();
  await x.guard.settle(); await x.guard.cleanup();
  const before = { prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests };
  await x.admission.reconcile();
  assert.equal(x.admission.status().state, 'idle');
  const row = latestRecoveryObservation(x.directory)!.sources[0]!;
  assert.ok(row.checks.every(check => check.status === 'verified'));
  assert.equal(row.video, 'incomplete');
  assert.deepEqual(row.segments, []);
  assert.equal(sha256(readFileSync(x.outcome)), x.outcomeDigest);
  assert.deepEqual({ prepares: x.f.state.prepareCount, effects: x.f.state.appliedEffects, pages: x.f.state.pageRequests }, before);
});
