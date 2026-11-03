import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutionAdmission } from '../../src/core/admission.ts';
import { ExecutionRecoveryViewSchema } from '../../src/core/recovery.ts';
import { writeJsonAtomic } from '../../src/core/fsx.ts';
import { observeChromeOwner } from '../../src/drivers/chrome-owner-client.ts';
import { createAgentService } from '../../src/runner/index.ts';
import { verifyExecutionRecovery } from '../../src/runner/recovery.ts';
import { chromeAttemptRecovery } from '../../src/drivers/chrome-attempt-recovery.ts';
import { guestAttemptRecovery } from '../../src/drivers/vm/attempt-recovery.ts';

const [mode, root] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(root, 'native-recovery.json'), 'utf8'));
const directory = join(root, '.qa', 'admission');
const admission = createExecutionAdmission(directory, { verifyRecovery: scope => verifyExecutionRecovery(directory, scope, chromeAttemptRecovery, guestAttemptRecovery) });
const service = createAgentService({ root, appsDir: join(root, 'apps'), runsDir: join(root, '.qa', 'runs'), inventoryDir: join(root, '.qa', 'inventory'), fixturesDir: join(root, 'fixtures'), ocr: null, admission,
  instanceProfiles: async () => [{ id: config.profileId, name: 'Owned Chrome recovery fixture', platform: 'desktop-chrome', runtime: 'owned-chrome' }] });
const operatorReview = { principalId: 'local-fixture-operator', channel: 'local-ui' };
async function call(request, human = false) {
  const reply = await service.call(request, human ? { operatorReview } : {});
  if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
  return reply.result;
}
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (mode === 'controller') {
  await call({ method: 'instance.create', requestId: config.instanceId, profileId: config.profileId }, true);
  await call({ method: 'instance.prepare', instanceId: config.instanceId }, true);
  const candidate = await call({ method: 'scenario.preview', paths: ['tests/owned-recovery.e2e.yaml'] });
  assert.deepEqual(candidate.problems, []);
  const revision = await call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: candidate.definition.checks.map(check => check.id) }, true);
  const run = await call({ method: 'regression.submit', requestId: config.requestId, name: 'Actual controller loss and original authority recovery', revisionIds: [revision.revisionId], targets: [config.target], authorizations: [{ appId: 'shop', target: config.target, grantId: config.grantId, subjectSha256: config.subjectSha256 }], evidence: 'required-video' });
  writeJsonAtomic(join(root, 'native-recovery-accepted.json'), { requestId: run.requestId, attemptId: run.attempts[0].attemptId, revisionId: revision.revisionId });
  output({ accepted: true, attemptId: run.attempts[0].attemptId });
  await new Promise(() => { setInterval(() => {}, 1000); });
} else {
  const accepted = JSON.parse(readFileSync(join(root, 'native-recovery-accepted.json'), 'utf8'));
  try {
    const runBefore = await call({ method: 'regression.status', requestId: config.requestId });
    assert.equal(runBefore.state, 'unknown');
    let native = null;
    let nextRun = null;
    if (mode === 'inspect') {
      const denied = await service.call({ method: 'execution.reconcile' });
      assert.equal(denied.ok, false); assert.equal(denied.error.code, 'operator_action_required');
      const scoped = await service.call({ method: 'execution.reconcile' }, { operatorReview, scriptId: '00000000-0000-4000-8000-000000000001' });
      assert.equal(scoped.ok, false); assert.equal(scoped.error.code, 'scope_denied');
      const initial = await service.call({ method: 'execution.reconcile' }, { operatorReview });
      assert.equal(initial.ok, false); assert.equal(initial.error.code, 'reconciliation_verification_failed');
      const first = ExecutionRecoveryViewSchema.parse(await call({ method: 'execution.status', attemptId: accepted.attemptId }));
      assert.ok(first.observation?.sources.length);
      const binding = chromeAttemptRecovery.read(directory, first.observation.sources[0].reference, first.observation.scope);
      const deadline = performance.now() + 40_000;
      do { native = await observeChromeOwner(binding.native); if (native.phase === 'closed') break; await delay(100); } while (performance.now() < deadline);
      assert.equal(native.phase, 'closed');
      const incomplete = await service.call({ method: 'execution.reconcile' }, { operatorReview });
      assert.equal(incomplete.ok, false); assert.equal(incomplete.error.code, 'reconciliation_verification_failed');
      assert.equal(admission.status().state, 'unknown');
      assert.throws(() => admission.acquire('another-owner', 'target:another'), error => error.code === 'execution_reconciliation_required');
    } else if (mode === 'authorize-and-crash') {
      await admission.reconcile();
      assert.equal(admission.status().state, 'idle');
      process.kill(process.pid, 'SIGKILL');
      await new Promise(() => {});
    } else if (mode === 'next') {
      const next = JSON.parse(readFileSync(join(root, 'native-recovery-next.json'), 'utf8'));
      await call({ method: 'instance.prepare', instanceId: config.instanceId }, true);
      const candidate = await call({ method: 'scenario.preview', paths: ['tests/owned-recovery.e2e.yaml'] });
      assert.deepEqual(candidate.problems, []);
      const revision = await call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: candidate.definition.checks.map(check => check.id) }, true);
      const request = { method: 'regression.submit', requestId: next.requestId, name: 'Explicit new run after resource recovery', revisionIds: [revision.revisionId], targets: [config.target], authorizations: [{ appId: 'shop', target: config.target, grantId: config.grantId, subjectSha256: next.subjectSha256 }], evidence: 'required-video' };
      const preflight = await call({ method: 'regression.preflight', revisionIds: request.revisionIds, targets: request.targets, authorizations: request.authorizations, evidence: request.evidence });
      assert.equal(preflight.canQueue, true, JSON.stringify(preflight));
      await call(request);
      const deadline = performance.now() + 45_000;
      let run;
      do {
        run = await call({ method: 'regression.status', requestId: next.requestId });
        if (['finished', 'blocked', 'cancelled', 'unknown'].includes(run.state)) break;
        await delay(100);
      } while (performance.now() < deadline);
      assert.equal(run.state, 'finished', JSON.stringify(run));
      assert.equal(run.attempts[0].business, 'PASS', JSON.stringify(run));
      assert.equal(run.attempts[0].evidence, 'ready');
      assert.equal(run.attempts[0].cleanup, 'confirmed');
      assert.deepEqual([...run.attempts[0].completedChecks].sort(), [...run.attempts[0].requiredChecks].sort());
      assert.deepEqual(await call({ method: 'regression.status', requestId: config.requestId }), runBefore);
      nextRun = run;
    } else if (mode === 'recover') {
      const result = ExecutionRecoveryViewSchema.parse(await call({ method: 'execution.reconcile' }, true));
      assert.equal(result.admission.state, 'idle');
      assert.deepEqual(result.instances, { recovered: [config.instanceId], blocked: [] });
      const instance = await call({ method: 'instance.status', instanceId: config.instanceId });
      assert.equal(instance.state, 'setup-required'); assert.equal(instance.activeRunId, null); assert.equal(instance.activeSessionId, null);
      const next = admission.acquire('another-owner', 'target:another'); next.ended();
    } else assert.equal(mode, 'reader');
    const view = ExecutionRecoveryViewSchema.parse(await call({ method: 'execution.status', attemptId: accepted.attemptId }));
    const runAfter = await call({ method: 'regression.status', requestId: config.requestId });
    assert.deepEqual(runAfter, runBefore);
    assert.equal(view.originalOutcomePreserved, true);
    assert.equal(view.observation.scope.ownerId, `attempt:${accepted.attemptId}`);
    if (mode === 'inspect') {
      const checks = view.observation.sources[0].checks;
      for (const kind of ['binding', 'native-stop', 'evidence']) assert.equal(checks.find(check => check.kind === kind).status, 'verified');
      assert.equal(checks.find(check => check.kind === 'fixture').status, 'blocked');
    } else {
      assert.equal(view.admission.state, 'idle'); assert.equal(view.observation.state, 'verified');
      assert.ok(view.observation.sources.every(source => source.checks.every(check => check.status === 'verified')));
    }
    output({ mode, accepted, runBefore, runAfter, view, native, next: nextRun });
  } finally { await service.shutdown(); }
}
