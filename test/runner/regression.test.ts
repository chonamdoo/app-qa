import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, it, type TestContext } from 'node:test';
import { AgentExecutionError } from '../../src/core/agent.ts';
import { sha256, writeAtomic, writeJsonAtomic } from '../../src/core/fsx.ts';
import { RegressionGrantError, type RegressionGrant, type RegressionGrantEvidence, type RegressionGrantOperation } from '../../src/core/regression-grant.ts';
import { ProjectFixtureError, projectFixtureSha256, type ProjectFixtureProof } from '../../src/core/project-fixture.ts';
import { regressionGrantCanonical, regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import type { AttemptConditionsReceipt, PublishedRevision, RegressionPreflight, RegressionRequest, RegressionRun, RevisionCandidate } from '../../src/core/regression.ts';
import { createRegressionService, type AttemptCompletion, type AttemptExecution, type RegressionDependencies } from '../../src/runner/regression.ts';
import { createAttemptConditions } from '../../src/runner/conditions.ts';
import { tempRoot } from '../helpers/run.ts';

const noDeviceResult: AttemptCompletion = {
  runId: null, business: 'NOT_RUN', completedChecks: [], evidence: 'incomplete', cleanup: 'confirmed', certainty: 'known',
  code: 'scheduler_probe_only', message: 'No device test executed',
};
type Service = ReturnType<typeof createRegressionService>;
type Submit = Extract<RegressionRequest, { method: 'regression.submit' }>;
const controlKinds = ['setup', 'cleanup', 'observe', 'capture-screen', 'record-video'] as const;
const readOperations = (...kinds: RegressionGrantOperation['kind'][]): RegressionGrantOperation[] =>
  kinds.map(kind => ({ kind, effect: 'read', entityIds: [], sinkIds: [] }));
/** Queue tests drive a fake executor, so every target counts as engine-owned; the refusal test overrides this. */
const anyTarget: RegressionDependencies['supportsTarget'] = () => true;
interface FixtureOptions {
  web?: boolean;
  dependencies?: Partial<Pick<RegressionDependencies, 'inspectAuthority' | 'inspectTarget' | 'capacity' | 'supportsTarget'>>;
  scenario?: Record<string, unknown>;
  files?: Record<string, string>;
  operations?: RegressionGrantOperation[];
}

async function fixture(t: TestContext, execute: (input: AttemptExecution) => Promise<AttemptCompletion>, release = () => {}, options: FixtureOptions = {}): Promise<{ root: string; service: Service; request: Submit; subject: RegressionGrant['subject'] }> {
  const platform = options.web ? 'desktop-chrome' : 'android';
  const root = realpathSync(tempRoot({
    ...(options.web ? { 'apps/example.yaml': JSON.stringify({ id: 'example', name: 'Observed comparison', web: { url: 'https://example.test/', platforms: ['desktop-chrome'] } }) } : {}),
    'tests/queue.e2e.yaml': JSON.stringify({ id: 'queue', name: 'Queue boundary', app: 'example', platforms: [platform], steps: [{ assertText: 'ready' }], ...options.scenario }),
    ...options.files,
  }));
  const now = Date.now();
  const target = { platform, deviceId: options.web ? 'chrome:comparison-device' : 'queue-boundary-device' } as const;
  const subject: RegressionGrant['subject'] = {
    appId: 'example', target, ...(options.web ? { origins: ['https://example.test'] } : { applicationId: 'example.tickets', origins: [] }), policyVersion: 'queue-policy',
    scope: {
      environment: 'queue-boundary', tenant: 'queue-tenant', accountRef: 'queue-account', credentialRef: 'queue-credential',
      fixture: { id: 'queue-fixture', entityIds: ['queue-record'], initialStateSha256: sha256('queue-metadata-only') },
      operations: options.operations ?? readOperations(...controlKinds, 'launch', 'terminate'), effects: ['read'], sinks: [],
    },
  };
  const evidence: RegressionGrantEvidence = {
    schema: 'qautra/backend-enforcement-probe/v1', subject,
    checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 240_000).toISOString(), enforcement: 'server-enforced-tenant-credential',
    credential: { ref: subject.scope.credentialRef, accountRef: subject.scope.accountRef, tenant: subject.scope.tenant },
    probes: { crossTenant: { tenant: 'other-tenant', observedStatus: 403 }, unownedEntity: { entityId: 'other-record', observedStatus: 403 }, unapprovedSink: { sinkId: 'production-sink', observedStatus: 403 } },
    initialState: { fixtureId: subject.scope.fixture.id, entityIds: subject.scope.fixture.entityIds, observedStateSha256: subject.scope.fixture.initialStateSha256 },
  };
  const bytes = JSON.stringify(evidence);
  const grant: RegressionGrant = { grantId: 'queue-grant', subject, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString(), revokedAt: null, evidence: { file: 'queue.json', sha256: sha256(bytes) } };
  const directory = join(root, '.qa', 'policy', 'regression');
  mkdirSync(join(directory, 'evidence'), { recursive: true, mode: 0o700 });
  writeAtomic(join(directory, 'evidence', 'queue.json'), bytes);
  writeJsonAtomic(join(directory, 'policy.json'), { schema: 'qautra/regression-grant-policy/v1', policyVersion: 'queue-policy', grants: [grant] });
  const service = createRegressionService({ root, appsDir: join(root, 'apps'), generatedDir: join(root, 'tests', 'generated'), execute, supportsTarget: anyTarget, ...options.dependencies });
  t.after(async () => { release(); await service.shutdown(); });
  const candidate = await service.call({ method: 'scenario.preview', paths: ['tests/queue.e2e.yaml'] }) as RevisionCandidate;
  const revision = await service.call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: candidate.definition.checks.map(check => check.id) }, { operatorReview: { principalId: 'local-test-operator', channel: 'local-ui' } }) as PublishedRevision;
  return { root, service, subject, request: { method: 'regression.submit', requestId: randomUUID(), revisionIds: [revision.revisionId], targets: [target], authorizations: [{ appId: subject.appId, target, grantId: grant.grantId, subjectSha256: regressionGrantSubjectSha256(subject) }], name: 'Queue boundary', evidence: 'required-video' } };
}

async function terminal(service: Service, requestId: string): Promise<RegressionRun> {
  for (let turn = 0; turn < 100; turn++) {
    const run = await service.call({ method: 'regression.status', requestId }) as RegressionRun;
    if (['finished', 'cancelled', 'blocked', 'unknown'].includes(run.state)) return run;
    await setImmediate();
  }
  throw new Error('Accepted run did not settle');
}

async function mixedPlatformSuite(t: TestContext, dispatched: string[]) {
  const setup = await fixture(t, async ({ attempt }) => {
    dispatched.push(`${attempt.testId}:${attempt.target.platform}`);
    return { ...noDeviceResult, business: 'FAIL', evidence: 'ready', code: 'observed_requirement_failure', message: 'Observed failure in the scheduler fixture' };
  }, () => {}, {
    web: true,
    files: {
      'apps/example.yaml': JSON.stringify({ id: 'example', name: 'Mixed browser suite', web: { url: 'https://example.test/', platforms: ['desktop-chrome', 'desktop-safari'] } }),
      'tests/safari.e2e.yaml': JSON.stringify({ id: 'safari', name: 'Safari requirement', app: 'example', platforms: ['desktop-safari'], steps: [{ assertText: 'Safari required text' }] }),
    },
  });
  const directory = join(setup.root, '.qa', 'policy', 'regression');
  const policy = JSON.parse(readFileSync(join(directory, 'policy.json'), 'utf8')) as { schema: string; policyVersion: string; grants: RegressionGrant[] };
  const original = policy.grants[0]!;
  const target = { platform: 'desktop-safari', deviceId: 'guest:mixed-safari' } as const;
  const subject: RegressionGrant['subject'] = { ...setup.subject, target };
  const evidence = JSON.parse(readFileSync(join(directory, 'evidence', original.evidence.file), 'utf8')) as RegressionGrantEvidence;
  evidence.subject = subject;
  const bytes = JSON.stringify(evidence);
  writeAtomic(join(directory, 'evidence', 'safari.json'), bytes);
  policy.grants.push({ ...original, grantId: 'safari-grant', subject, evidence: { file: 'safari.json', sha256: sha256(bytes) } });
  writeJsonAtomic(join(directory, 'policy.json'), policy);
  const candidate = await setup.service.call({ method: 'scenario.preview', paths: ['tests/queue.e2e.yaml', 'tests/safari.e2e.yaml'] }) as RevisionCandidate;
  assert.deepEqual(candidate.problems, []);
  const revision = await setup.service.call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: candidate.definition.checks.map(check => check.id) }, { operatorReview: { principalId: 'local-test-operator', channel: 'local-ui' } }) as PublishedRevision;
  const request: Submit = {
    ...setup.request, revisionIds: [revision.revisionId], targets: [...setup.request.targets, target],
    authorizations: [...setup.request.authorizations, { appId: subject.appId, target, grantId: 'safari-grant', subjectSha256: regressionGrantSubjectSha256(subject) }],
  };
  return { ...setup, request };
}

describe('published regression execution boundaries', () => {
  it('maps a mixed Chrome/Safari suite to each test’s declared targets without cross-pairing', async t => {
    const dispatched: string[] = [];
    const { service, request } = await mixedPlatformSuite(t, dispatched);
    const accepted = await service.call(request) as RegressionRun;
    assert.deepEqual(accepted.attempts.map(attempt => [attempt.testId, attempt.target.platform]), [['queue', 'desktop-chrome'], ['safari', 'desktop-safari']]);
    const result = await terminal(service, request.requestId);
    assert.equal(result.state, 'finished');
    assert.deepEqual(dispatched, ['queue:desktop-chrome', 'safari:desktop-safari']);
    assert.ok(result.attempts.every(attempt => attempt.business === 'FAIL'));
  });

  for (const invalid of ['missing required platform', 'unrelated target', 'missing target grant', 'unused target grant'] as const) {
    it(`rejects a mixed suite with ${invalid} before dispatch`, async t => {
      const dispatched: string[] = [];
      const { service, request } = await mixedPlatformSuite(t, dispatched);
      const expected = invalid === 'missing required platform' ? 'required_target_missing'
        : invalid === 'unrelated target' ? 'target_scope_mismatch'
        : invalid === 'missing target grant' ? 'project_grant_required' : 'unused_authorization';
      if (invalid === 'missing required platform') {
        request.targets = request.targets.slice(0, 1);
        request.authorizations = request.authorizations.slice(0, 1);
      } else if (invalid === 'unrelated target') request.targets.push({ platform: 'ios', deviceId: 'unrequested-ios' });
      else if (invalid === 'missing target grant') request.authorizations = request.authorizations.slice(0, 1);
      else request.authorizations.push({ ...request.authorizations[0]!, target: { platform: 'desktop-chrome', deviceId: 'unrequested-chrome' } });
      await assert.rejects(service.call(request), (error: unknown) => error instanceof AgentExecutionError && error.code === expected);
      assert.deepEqual(dispatched, []);
      assert.deepEqual(await service.call({ method: 'regression.list' }), []);
    });
  }

  it('refuses a target without frozen owner, recording and recovery support in preflight and before queueing or dispatch', async t => {
    let dispatched = 0;
    const inspected: string[] = [];
    const { service, request } = await fixture(t, async () => { dispatched++; return noDeviceResult; }, () => {}, {
      dependencies: {
        supportsTarget: target => target.platform.startsWith('desktop-'),
        inspectTarget: async target => { inspected.push(target.deviceId); return [{ category: 'evidence', target, status: 'available', code: null, message: 'adapter claims support' }]; },
      },
    });
    const { revisionIds, targets, authorizations, evidence } = request;
    const preflight = await service.call({ method: 'regression.preflight', revisionIds, targets, authorizations, evidence }) as RegressionPreflight;
    assert.equal(preflight.canQueue, false);
    assert.ok(preflight.checks.some(check => check.code === 'frozen_target_unsupported' && check.status === 'blocked'));
    assert.deepEqual(inspected, []);
    await assert.rejects(service.call(request), (error: unknown) => error instanceof AgentExecutionError && error.code === 'frozen_target_unsupported');
    assert.equal(dispatched, 0);
    assert.deepEqual(await service.call({ method: 'regression.list' }), []);
    await assert.rejects(service.call({ method: 'regression.status', requestId: request.requestId }), (error: unknown) => error instanceof AgentExecutionError && error.code === 'run_not_found');
  });

  it('dispatches concurrent identical submissions once and replays the same attempt identity', async t => {
    const gate = Promise.withResolvers<void>();
    let dispatched = 0;
    const { service, request } = await fixture(t, async () => { dispatched++; await gate.promise; return noDeviceResult; }, () => gate.resolve());
    const [first, second] = await Promise.all([service.call(request), service.call(request)]) as [RegressionRun, RegressionRun];
    assert.equal(first.attempts[0]!.attemptId, second.attempts[0]!.attemptId);
    gate.resolve();
    const original = await terminal(service, request.requestId);
    const replay = await service.call(request) as RegressionRun;
    assert.deepEqual(replay, original);
    assert.equal(dispatched, 1);
  });

  it('continues an independent chain after a confirmed failure while preserving unexecuted dependent checks', async t => {
    const dispatched: string[] = [];
    const setup = await fixture(t, async input => {
      dispatched.push(input.attempt.testId);
      const first = input.attempt.testId === 'queue';
      return {
        runId: `scheduler-fixture-${dispatched.length}`, business: first ? 'FAIL' : 'PASS',
        completedChecks: first ? ['queue:steps[0]'] : ['independent:steps[0]'],
        evidence: 'ready', cleanup: 'confirmed', certainty: 'known',
        code: first ? 'text_not_found' : null, message: first ? 'Expected text was absent' : null,
      };
    }, () => {}, {
      scenario: { steps: [{ assertText: 'first expected text' }, { assertText: 'dependent expected text' }] },
      files: { 'tests/z-independent.e2e.yaml': JSON.stringify({ id: 'independent', name: 'Independent chain', app: 'example', platforms: ['android'], steps: [{ assertText: 'independent expected text' }] }) },
    });
    const candidate = await setup.service.call({ method: 'scenario.preview', paths: ['tests/queue.e2e.yaml', 'tests/z-independent.e2e.yaml'] }) as RevisionCandidate;
    assert.deepEqual(candidate.problems, []);
    const revision = await setup.service.call({ method: 'scenario.publish', candidateId: candidate.candidateId, digest: candidate.digest, reviewedChecks: candidate.definition.checks.map(check => check.id) }, { operatorReview: { principalId: 'local-test-operator', channel: 'local-ui' } }) as PublishedRevision;
    await setup.service.call({ ...setup.request, revisionIds: [revision.revisionId] });
    const run = await terminal(setup.service, setup.request.requestId);
    assert.equal(run.state, 'finished');
    assert.deepEqual(dispatched, ['queue', 'independent']);
    assert.equal(run.attempts[0]!.business, 'FAIL');
    assert.equal(run.attempts[0]!.code, 'text_not_found');
    assert.equal(run.attempts[0]!.requiredChecks.length, 2);
    assert.deepEqual(run.attempts[0]!.completedChecks, ['queue:steps[0]']);
    assert.equal(run.attempts[1]!.business, 'PASS');
  });

  it('rejects a concurrent reuse of the request identity with different material input', async t => {
    const gate = Promise.withResolvers<void>();
    let dispatched = 0;
    const { service, request } = await fixture(t, async () => { dispatched++; await gate.promise; return noDeviceResult; }, () => gate.resolve());
    const [accepted, conflict] = await Promise.allSettled([service.call(request), service.call({ ...request, name: 'Different requested execution' })]);
    assert.equal(accepted.status, 'fulfilled');
    assert.equal(conflict.status, 'rejected');
    if (conflict.status !== 'rejected') assert.fail('Expected idempotency conflict');
    assert.ok(conflict.reason instanceof AgentExecutionError);
    assert.equal(conflict.reason.code, 'idempotency_conflict');
    gate.resolve();
    await terminal(service, request.requestId);
    assert.equal(dispatched, 1);
  });

  it('keeps a stopped queued request from reaching the executor after the active flow settles', async t => {
    const gate = Promise.withResolvers<void>();
    const dispatched: string[] = [];
    const { service, request } = await fixture(t, async input => { dispatched.push(input.attempt.attemptId); await gate.promise; return noDeviceResult; }, () => gate.resolve());
    const first = await service.call(request) as RegressionRun;
    const second = await service.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    const stopped = await service.call({ method: 'regression.stop', requestId: second.requestId }) as RegressionRun;
    assert.equal(stopped.state, 'cancelled');
    gate.resolve();
    await terminal(service, first.requestId);
    await setImmediate();
    assert.deepEqual(dispatched, [first.attempts[0]!.attemptId]);
    const after = await service.call({ method: 'regression.status', requestId: second.requestId }) as RegressionRun;
    assert.equal(after.state, 'cancelled');
  });

  for (const business of ['PASS', 'FAIL'] as const) {
    it(`${business === 'PASS' ? 'does not accept PASS without every required assertion' : 'preserves the original FAIL'} when mandatory evidence is incomplete`, async t => {
      const { service, request } = await fixture(t, async () => ({ ...noDeviceResult, business }));
      await service.call(request);
      const result = await terminal(service, request.requestId);
      assert.equal(result.state, 'blocked');
      assert.equal(result.attempts[0]!.business, business === 'PASS' ? 'INCONCLUSIVE' : 'FAIL');
      assert.equal(result.attempts[0]!.evidence, 'incomplete');
      if (business === 'PASS') assert.equal(result.attempts[0]!.code, 'required_assertion_missing');
    });
  }

  it('quarantines a persisted in-flight record without replaying it or dispatching later queued work', async t => {
    const first = await fixture(t, async () => noDeviceResult);
    await first.service.call(first.request);
    const interrupted = await terminal(first.service, first.request.requestId);
    await first.service.shutdown();
    interrupted.state = 'running';
    interrupted.attempts[0]!.state = 'running';
    interrupted.attempts[0]!.evidence = 'recording';
    interrupted.attempts[0]!.cleanup = 'pending';
    const file = join(first.root, '.qa', 'product', 'regressions', `${interrupted.requestId}.json`);
    writeJsonAtomic(file, interrupted);
    let dispatched = 0;
    const restarted = createRegressionService({ root: first.root, appsDir: join(first.root, 'apps'), generatedDir: join(first.root, 'tests', 'generated'), supportsTarget: anyTarget, execute: async () => { dispatched++; return noDeviceResult; } });
    t.after(() => restarted.shutdown());
    const recovered = await restarted.call({ method: 'regression.status', requestId: interrupted.requestId }) as RegressionRun;
    assert.equal(recovered.state, 'unknown');
    assert.equal(recovered.attempts[0]!.cleanup, 'unknown');
    assert.equal(recovered.attempts[0]!.evidence, 'incomplete');
    const queued = await restarted.call({ ...first.request, requestId: randomUUID() }) as RegressionRun;
    await setImmediate();
    assert.equal((await restarted.call({ method: 'regression.status', requestId: queued.requestId }) as RegressionRun).state, 'queued');
    assert.equal(dispatched, 0);
    const durable = JSON.parse(readFileSync(file, 'utf8')) as RegressionRun;
    assert.equal(durable.state, 'unknown');
  });

  const restartWith = (t: TestContext, root: string, dispatched: string[], resourcesRecovered?: RegressionDependencies['resourcesRecovered']): Service => {
    const restarted = createRegressionService({ root, appsDir: join(root, 'apps'), generatedDir: join(root, 'tests', 'generated'), supportsTarget: anyTarget, execute: async input => { dispatched.push(input.attempt.attemptId); return noDeviceResult; }, ...(resourcesRecovered ? { resourcesRecovered } : {}) });
    t.after(() => restarted.shutdown());
    return restarted;
  };
  const interruptAfterAttemptPersist = async (t: TestContext, mutate: (run: RegressionRun) => void) => {
    const first = await fixture(t, async () => noDeviceResult);
    await first.service.call(first.request);
    const settled = await terminal(first.service, first.request.requestId);
    await first.service.shutdown();
    mutate(settled);
    writeJsonAtomic(join(first.root, '.qa', 'product', 'regressions', `${settled.requestId}.json`), settled);
    return { ...first, original: settled };
  };

  it('releases the queue barrier for a crash after every attempt confirmed cleanup, keeping the run unknown and never resubmitting', async t => {
    // Crash between the final attempt persist and the run persist: attempts are terminal with confirmed cleanup, the run is not.
    const { root, request, original } = await interruptAfterAttemptPersist(t, run => { run.state = 'running'; });
    assert.equal(original.attempts[0]!.cleanup, 'confirmed');
    const dispatched: string[] = [];
    const restarted = restartWith(t, root, dispatched);
    const recovered = await restarted.call({ method: 'regression.status', requestId: original.requestId }) as RegressionRun;
    assert.equal(recovered.state, 'unknown');
    assert.ok(recovered.attempts.every(attempt => attempt.state !== 'unknown'));
    const next = await restarted.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    await terminal(restarted, next.requestId);
    assert.deepEqual(dispatched, [next.attempts[0]!.attemptId]);
    assert.equal((await restarted.call({ method: 'regression.status', requestId: original.requestId }) as RegressionRun).state, 'unknown');
    const durable = JSON.parse(readFileSync(join(root, '.qa', 'product', 'regressions', `${original.requestId}.json`), 'utf8')) as RegressionRun;
    assert.equal(durable.state, 'unknown');
  });

  it('holds an unknown run whose terminal attempt has unconfirmed cleanup until operator-verified recovery, without resubmitting', async t => {
    const { root, request, original } = await interruptAfterAttemptPersist(t, run => {
      run.state = 'unknown'; run.code = 'execution_unconfirmed';
      run.attempts[0]!.state = 'blocked'; run.attempts[0]!.cleanup = 'unknown'; run.attempts[0]!.runId = 'run-unconfirmed';
    });
    const blockedDispatch: string[] = [];
    const stalled = restartWith(t, root, blockedDispatch, () => false);
    const waiting = await stalled.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    await setImmediate();
    assert.equal((await stalled.call({ method: 'regression.status', requestId: waiting.requestId }) as RegressionRun).state, 'queued');
    const preflight = await stalled.call({ method: 'regression.preflight', revisionIds: request.revisionIds, targets: request.targets, authorizations: request.authorizations, evidence: request.evidence }) as RegressionPreflight;
    assert.equal(preflight.checks.find(check => check.category === 'capacity')!.code, 'execution_reconciliation_required');
    assert.deepEqual(blockedDispatch, []);
    await stalled.shutdown();

    const dispatched: string[] = [], checked: string[] = [];
    const reconciled = restartWith(t, root, dispatched, attempt => { checked.push(attempt.attemptId); return true; });
    const next = await reconciled.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    await terminal(reconciled, next.requestId);
    assert.ok(checked.includes(original.attempts[0]!.attemptId));
    assert.deepEqual(dispatched, [next.attempts[0]!.attemptId]);
    assert.equal((await reconciled.call({ method: 'regression.status', requestId: original.requestId }) as RegressionRun).state, 'unknown');
  });

  it('keeps blocking the queue while an unknown run has an unknown attempt without verified recovery', async t => {
    const { root, request } = await interruptAfterAttemptPersist(t, run => {
      run.state = 'unknown'; run.attempts[0]!.state = 'unknown'; run.attempts[0]!.cleanup = 'confirmed';
    });
    const dispatched: string[] = [];
    const restarted = restartWith(t, root, dispatched, attempt => attempt.state !== 'unknown');
    const next = await restarted.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    await setImmediate();
    assert.equal((await restarted.call({ method: 'regression.status', requestId: next.requestId }) as RegressionRun).state, 'queued');
    assert.deepEqual(dispatched, []);
  });

  it('does not equate matching scenario and target IDs with verified identical runtime conditions', async t => {
    const { service, request } = await fixture(t, async () => noDeviceResult);
    await service.call(request);
    await terminal(service, request.requestId);
    const second = await service.call({ ...request, requestId: randomUUID() }) as RegressionRun;
    await terminal(service, second.requestId);
    const comparison = await service.call({ method: 'regression.compare', before: request.requestId, after: second.requestId }) as { readOnly: boolean; comparisons: { comparable: boolean; classification: string }[] };
    assert.equal(comparison.readOnly, true);
    assert.equal(comparison.comparisons[0]!.comparable, false);
    assert.equal(comparison.comparisons[0]!.classification, 'conditions_unverified');
  });
});

function observedCompletion(input: AttemptExecution, subject: RegressionGrant['subject'], change?: (receipt: AttemptConditionsReceipt) => void): AttemptCompletion {
  const now = Date.now(), session = randomUUID(), profile = `/owned/${session}`;
  const initial: ProjectFixtureProof = {
    receiptSha256: sha256(`prepare:${session}`), phase: 'prepare', observedAt: new Date(now - 1000).toISOString(),
    clientObservedAt: new Date(now - 500).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
    subjectSha256: regressionGrantSubjectSha256(subject), scopeSha256: createHash('sha256').update(regressionGrantCanonical(subject.scope)).digest('hex'),
    adapterSha256: sha256('protected-adapter'), attemptId: input.attempt.attemptId, ownerId: `attempt:${input.attempt.attemptId}`,
    lease: { id: session, generation: 1, fence: 1, expiresAt: new Date(now + 60_000).toISOString() },
    state: { fixtureId: subject.scope.fixture.id, entityIds: subject.scope.fixture.entityIds, baselineStateSha256: subject.scope.fixture.initialStateSha256, currentStateSha256: subject.scope.fixture.initialStateSha256, conditions: { frontendSha256: sha256('frontend'), apiSha256: sha256('api'), configSha256: sha256('config') } },
    ledger: { sequence: 1, sha256: sha256(`ledger:${session}`), pendingEffectIds: [], throughFence: 1, disposition: 'active', fenceStatus: 'active', restoration: 'not_requested' },
    effect: 'committed', cleanup: 'not_started', comparison: 'same_conditions',
  };
  let conditions = createAttemptConditions({
    attemptId: input.attempt.attemptId, revisionId: input.attempt.revisionId, testId: input.attempt.testId, target: input.attempt.target, runId: session,
    initial, final: { ...initial, phase: 'cleanup', receiptSha256: sha256(`cleanup:${session}`), observedAt: new Date(now + 1).toISOString(), cleanup: 'complete', ledger: { ...initial.ledger, sequence: 3, disposition: 'drained', fenceStatus: 'revoked', restoration: 'restored' } },
    worker: { runtime: 'owned-chrome', instanceId: randomUUID(), machineId: null, workerId: 'observed-worker', generation: 1 },
    browser: {
      capturedAt: new Date(now).toISOString(),
      identity: {
        browserSessionId: session, browserVersion: '156.0.1.2', osVersion: '25.6.0', binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', profile,
        args: ['--headless=new', '--lang=ko-KR', `--user-data-dir=${profile}`], os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' },
        viewport: { width: 1280, height: 800 }, observed: { width: 1280, height: 800, dpr: 1, userAgent: 'Chrome/156', language: 'ko-KR', timezone: 'Asia/Seoul' },
        capabilities: { browserName: 'chrome', browserVersion: '156.0.1.2', chrome: { chromedriverVersion: '156.0.1.2 (build)', userDataDir: profile }, 'goog:chromeOptions': { debuggerAddress: `127.0.0.1:${10000 + now % 50000}` }, 'goog:processID': now % 10000 },
      },
      browserBinary: { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', sha256: sha256('actual-browser-executable'), bytes: 1024, coverage: 'main-executable-only' },
      driverBinary: { path: '/trusted/.tools/chromedriver/chromedriver-mac-arm64_v156.0.1.2', sha256: sha256('actual-driver-executable'), bytes: 2048, coverage: 'main-executable-only' },
    },
    runtime: input.revision.definition.runtime, subject,
  });
  if (change) { change(conditions); conditions = createAttemptConditions(conditions); }
  return { runId: session, business: 'PASS', completedChecks: input.attempt.requiredChecks, evidence: 'ready', cleanup: 'confirmed', certainty: 'known', code: null, message: null, conditions };
}

interface Comparison {
  readOnly: true;
  comparisons: { comparable: boolean; classification: string; reason: string; before: { business: string; evidence: string; cleanup: string; conditions: AttemptConditionsReceipt }; after: { business: string; conditions: AttemptConditionsReceipt } }[];
}

describe('actual-condition comparison API', () => {
  it('compares equal observed proof, retains original FAIL, and survives durable reload without backfill', async t => {
    let subject!: RegressionGrant['subject'], count = 0;
    const setup = await fixture(t, async input => ({ ...observedCompletion(input, subject), business: count++ === 0 ? 'FAIL' : 'PASS' }), () => {}, { web: true });
    subject = setup.subject;
    await setup.service.call(setup.request);
    const before = await terminal(setup.service, setup.request.requestId);
    const next = { ...setup.request, requestId: randomUUID() };
    await setup.service.call(next);
    const after = await terminal(setup.service, next.requestId);
    assert.equal(before.attempts[0]!.conditions?.status, 'verified');
    assert.equal(before.attempts[0]!.conditions?.materialSha256, after.attempts[0]!.conditions?.materialSha256);
    assert.notEqual(before.attempts[0]!.conditions?.receiptSha256, after.attempts[0]!.conditions?.receiptSha256);
    const comparison = await setup.service.call({ method: 'regression.compare', before: before.requestId, after: after.requestId }) as Comparison;
    assert.equal(comparison.readOnly, true);
    assert.equal(comparison.comparisons[0]!.comparable, true);
    assert.equal(comparison.comparisons[0]!.classification, 'same_conditions');
    assert.equal(comparison.comparisons[0]!.before.business, 'FAIL');
    assert.equal(comparison.comparisons[0]!.after.business, 'PASS');
    assert.deepEqual(comparison.comparisons[0]!.before.conditions, before.attempts[0]!.conditions);
    assert.deepEqual(await setup.service.call({ method: 'regression.status', requestId: before.requestId }), before);
    await setup.service.shutdown();
    const restarted = createRegressionService({ root: setup.root, appsDir: join(setup.root, 'apps'), generatedDir: join(setup.root, 'tests', 'generated'), supportsTarget: anyTarget, execute: async () => { throw new Error('Comparison must not dispatch'); } });
    t.after(() => restarted.shutdown());
    assert.deepEqual(await restarted.call({ method: 'regression.compare', before: before.requestId, after: after.requestId }), comparison);
  });

  const changes: [string, (receipt: AttemptConditionsReceipt) => void][] = [
    ['frontend', receipt => { receipt.initial!.state.conditions.frontendSha256 = sha256('changed-frontend'); receipt.final!.state.conditions.frontendSha256 = sha256('changed-frontend'); }],
    ['API', receipt => { receipt.initial!.state.conditions.apiSha256 = sha256('changed-api'); receipt.final!.state.conditions.apiSha256 = sha256('changed-api'); }],
    ['configuration', receipt => { receipt.initial!.state.conditions.configSha256 = sha256('changed-config'); receipt.final!.state.conditions.configSha256 = sha256('changed-config'); }],
    ['OS', receipt => { const identity = receipt.browser!.identity; identity.osVersion = '26.0.0'; (identity.os as Record<string, string>).release = '26.0.0'; }],
    ['observed viewport', receipt => { (receipt.browser!.identity.observed as Record<string, number>).width = 1440; (receipt.browser!.identity.viewport as Record<string, number>).width = 1440; }],
    ['baseline', receipt => { receipt.initial!.state.baselineStateSha256 = sha256('different-baseline'); receipt.final!.state.baselineStateSha256 = sha256('different-baseline'); }],
    ['cleanup drift', receipt => { receipt.final!.state.conditions.frontendSha256 = sha256('drift'); receipt.final!.comparison = 'changed_conditions'; }],
    ['driver binary', receipt => { receipt.browser!.driverBinary.sha256 = sha256('changed-driver'); }],
    ['worker', receipt => { receipt.worker!.workerId = 'another-worker'; }],
    ['DPR', receipt => { (receipt.browser!.identity.observed as Record<string, number>).dpr = 2; }],
  ];
  for (const [name, change] of changes) it(`does not call changed ${name} the same conditions`, async t => {
    let subject!: RegressionGrant['subject'], count = 0;
    const setup = await fixture(t, async input => observedCompletion(input, subject, count++ === 0 ? undefined : change), () => {}, { web: true });
    subject = setup.subject;
    await setup.service.call(setup.request);
    await terminal(setup.service, setup.request.requestId);
    const next = { ...setup.request, requestId: randomUUID() };
    await setup.service.call(next);
    await terminal(setup.service, next.requestId);
    const result = await setup.service.call({ method: 'regression.compare', before: setup.request.requestId, after: next.requestId }) as Comparison;
    assert.equal(result.comparisons[0]!.classification, 'changed_conditions');
    assert.equal(result.comparisons[0]!.comparable, false);
  });

  for (const missing of ['initial', 'client witness', 'browser', 'final cleanup', 'required checks'] as const) it(`leaves missing ${missing} unverified`, async t => {
    let subject!: RegressionGrant['subject'], count = 0;
    const setup = await fixture(t, async input => {
      const first = count++ === 0;
      const result = observedCompletion(input, subject, first ? undefined : receipt => {
        if (missing === 'initial') receipt.initial = null;
        else if (missing === 'client witness') delete receipt.initial!.clientObservedAt;
        else if (missing === 'browser') receipt.browser = null;
        else if (missing === 'final cleanup') receipt.final = null;
      });
      if (!first && missing === 'required checks') result.completedChecks = [];
      return result;
    }, () => {}, { web: true });
    subject = setup.subject;
    await setup.service.call(setup.request);
    await terminal(setup.service, setup.request.requestId);
    const next = { ...setup.request, requestId: randomUUID() };
    await setup.service.call(next);
    const after = await terminal(setup.service, next.requestId);
    const result = await setup.service.call({ method: 'regression.compare', before: setup.request.requestId, after: next.requestId }) as Comparison;
    assert.equal(result.comparisons[0]!.comparable, false);
    assert.equal(result.comparisons[0]!.classification, 'conditions_unverified');
    if (missing === 'required checks') assert.equal(after.attempts[0]!.business, 'INCONCLUSIVE');
  });

  for (const field of ['materialSha256', 'receiptSha256', 'projection'] as const) it(`rejects inconsistent ${field} instead of admitting equivalence`, async t => {
    let subject!: RegressionGrant['subject'];
    const setup = await fixture(t, async input => {
      const result = observedCompletion(input, subject);
      if (field === 'projection') {
        result.conditions!.material!.fixture.conditions.frontendSha256 = sha256('forged-projection');
        result.conditions!.materialSha256 = projectFixtureSha256(result.conditions!.material);
      } else result.conditions![field] = sha256('mismatched-digest');
      if (field !== 'receiptSha256') {
        const { receiptSha256: _previousDigest, ...body } = result.conditions!;
        result.conditions!.receiptSha256 = projectFixtureSha256(body);
      }
      return result;
    }, () => {}, { web: true });
    subject = setup.subject;
    await setup.service.call(setup.request);
    const result = await terminal(setup.service, setup.request.requestId);
    assert.equal(result.state, 'unknown');
    assert.equal(result.code, 'attempt_conditions_invalid');
    assert.equal(result.attempts[0]!.conditions, undefined);
  });
});

describe('live authority preflight and undispatched failures', () => {
  for (const status of ['missing', 'blocked', 'unknown', 'verified'] as const) it(`exposes ${status} authority without mutating or dispatching`, async t => {
    let dispatched = 0, inspections = 0;
    const setup = await fixture(t, async () => { dispatched++; return noDeviceResult; }, () => {}, {
      dependencies: {
        inspectTarget: async target => [{ category: 'target', target, status: 'verified', code: null, message: 'Actual target inspection' }, { category: 'evidence', target, status: 'verified', code: null, message: 'Actual recording prerequisites' }],
        capacity: () => ({ category: 'capacity', target: null, status: 'available', code: null, message: 'Serial capacity available' }),
        ...(status === 'missing' ? {} : { inspectAuthority: async binding => { inspections++; assert.equal(binding.subject.appId, 'example'); return [{ category: 'authority' as const, target: binding.subject.target, status, code: status === 'verified' ? null : 'protected_adapter_unavailable', message: 'Actual adapter and credential prerequisites' }]; } }),
      },
    });
    const result = await setup.service.call({ method: 'regression.preflight', revisionIds: setup.request.revisionIds, targets: setup.request.targets, authorizations: setup.request.authorizations, evidence: 'required-video' }) as RegressionPreflight;
    assert.equal(result.canQueue, status === 'verified');
    assert.equal(result.checks.find(check => check.category === 'authority')!.status, status === 'missing' ? 'unknown' : status);
    assert.equal(inspections, status === 'missing' ? 0 : 1);
    assert.equal(dispatched, 0);
    assert.deepEqual(await setup.service.call({ method: 'regression.list' }), []);
  });

  for (const kind of ['fixture', 'grant'] as const) it(`blocks a ${kind} not_started failure without poisoning later queue admission`, async t => {
    let dispatched = 0;
    const setup = await fixture(t, async () => {
      if (dispatched++ === 0) throw kind === 'fixture' ? new ProjectFixtureError('fixture_adapter_missing') : new RegressionGrantError('grant_expired');
      return noDeviceResult;
    });
    await setup.service.call(setup.request);
    const first = await terminal(setup.service, setup.request.requestId);
    assert.equal(first.state, 'blocked');
    assert.equal(first.attempts[0]!.business, 'NOT_RUN');
    assert.equal(first.attempts[0]!.cleanup, 'not_started');
    const next = { ...setup.request, requestId: randomUUID() };
    await setup.service.call(next);
    assert.equal((await terminal(setup.service, next.requestId)).state, 'blocked');
    assert.equal(dispatched, 2);
  });

  it('quarantines uncertain fixture effects and does not dispatch later work', async t => {
    let dispatched = 0;
    const setup = await fixture(t, async () => { dispatched++; throw new ProjectFixtureError('fixture_transport_failed', 'unknown'); });
    await setup.service.call(setup.request);
    assert.equal((await terminal(setup.service, setup.request.requestId)).state, 'unknown');
    const next = await setup.service.call({ ...setup.request, requestId: randomUUID() }) as RegressionRun;
    await setImmediate();
    assert.equal((await setup.service.call({ method: 'regression.status', requestId: next.requestId }) as RegressionRun).state, 'queued');
    assert.equal(dispatched, 1);
  });
});

describe('preflight authority cannot authorize submission', () => {
  it('revalidates the current owner grant after a verified read-only preflight', async t => {
    let dispatched = 0;
    const setup = await fixture(t, async () => { dispatched++; return noDeviceResult; }, () => {}, {
      dependencies: {
        inspectAuthority: async binding => [{ category: 'authority', target: binding.subject.target, status: 'verified', code: null, message: 'Protected prerequisites observed' }],
        inspectTarget: async target => [{ category: 'target', target, status: 'verified', code: null, message: 'Actual target' }, { category: 'evidence', target, status: 'verified', code: null, message: 'Recorder prerequisites' }],
        capacity: () => ({ category: 'capacity', target: null, status: 'available', code: null, message: 'Serial capacity' }),
      },
    });
    const result = await setup.service.call({ method: 'regression.preflight', revisionIds: setup.request.revisionIds, targets: setup.request.targets, authorizations: setup.request.authorizations, evidence: 'required-video' }) as RegressionPreflight;
    assert.equal(result.canQueue, true);
    const policyFile = join(setup.root, '.qa', 'policy', 'regression', 'policy.json');
    const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { grants: RegressionGrant[] };
    policy.grants[0]!.revokedAt = new Date().toISOString();
    writeJsonAtomic(policyFile, policy);
    await assert.rejects(setup.service.call(setup.request), (error: unknown) => error instanceof AgentExecutionError && error.code === 'grant_revoked');
    assert.equal(dispatched, 0);
    assert.deepEqual(await setup.service.call({ method: 'regression.list' }), []);
  });
});

describe('frozen operation authorization before admission', () => {
  const prerequisites: NonNullable<FixtureOptions['dependencies']> = {
    inspectAuthority: async binding => [{ category: 'authority', target: binding.subject.target, status: 'verified', code: null, message: 'Metadata fixture authority' }],
    inspectTarget: async target => [{ category: 'target', target, status: 'verified', code: null, message: 'Metadata fixture target' }, { category: 'evidence', target, status: 'verified', code: null, message: 'Metadata fixture recorder' }],
    capacity: () => ({ category: 'capacity', target: null, status: 'available', code: null, message: 'Metadata fixture capacity' }),
  };
  async function preflight(setup: Awaited<ReturnType<typeof fixture>>): Promise<RegressionPreflight> {
    return setup.service.call({ method: 'regression.preflight', revisionIds: setup.request.revisionIds, targets: setup.request.targets, authorizations: setup.request.authorizations, evidence: 'required-video' }) as Promise<RegressionPreflight>;
  }
  async function refused(t: TestContext, options: FixtureOptions): Promise<void> {
    let dispatched = 0;
    const setup = await fixture(t, async () => { dispatched++; return noDeviceResult; }, () => {}, { ...options, dependencies: prerequisites });
    const result = await preflight(setup);
    assert.equal(result.canQueue, false);
    assert.ok(result.checks.some(check => check.code === 'grant_operation_denied'));
    await assert.rejects(setup.service.call(setup.request), (error: unknown) => error instanceof AgentExecutionError && error.code === 'grant_operation_denied');
    assert.equal(dispatched, 0);
    assert.deepEqual(await setup.service.call({ method: 'regression.list' }), []);
  }

  it('refuses missing mandatory video authority before creating a queued run', async t => {
    await refused(t, { operations: readOperations('setup', 'cleanup', 'observe', 'capture-screen', 'launch', 'terminate') });
  });
  it('requires press separately from type when a reviewed input submits', async t => {
    await refused(t, {
      operations: readOperations(...controlKinds, 'launch', 'terminate', 'type'),
      scenario: { steps: [{ type: 'fixture', into: { id: 'note' }, submit: true }, { assertText: 'ready' }] },
    });
  });
  it('refuses ambiguous operation kinds even when each distinct scope is otherwise valid', async t => {
    await refused(t, { operations: [...readOperations(...controlKinds, 'launch', 'terminate'), { kind: 'launch', effect: 'read', entityIds: ['queue-record'], sinkIds: [] }] });
  });
  it('includes required inputs inside a repeated frozen subflow', async t => {
    await refused(t, {
      scenario: { steps: [{ repeat: { times: 2, steps: [{ use: 'edit.flow.yaml' }] } }, { assertText: 'ready' }] },
      files: { 'tests/edit.flow.yaml': JSON.stringify({ name: 'Edit fixture', steps: [{ clear: { id: 'note' } }] }) },
    });
  });
  it('includes teardown operations instead of borrowing main-step authority', async t => {
    await refused(t, { scenario: { teardown: [{ back: true }] } });
  });

  for (const row of [
    { name: 'attach does not launch', scenario: { start: 'attach' }, extra: [], web: false },
    { name: 'desktop relaunch does not terminate or hide a native keyboard', scenario: { steps: [{ hideKeyboard: true }, { assertText: 'ready' }] }, extra: ['launch'], web: true },
    { name: 'native clear already launches without extra launch options', scenario: { reset: 'clear' }, extra: ['reset'], web: false },
  ] as const) it(row.name, async t => {
    const setup = await fixture(t, async () => noDeviceResult, () => {}, {
      web: row.web, scenario: row.scenario, operations: readOperations(...controlKinds, ...row.extra), dependencies: prerequisites,
    });
    assert.equal((await preflight(setup)).canQueue, true);
    assert.deepEqual(await setup.service.call({ method: 'regression.list' }), []);
  });

  it('requires a new launch after a native clear with custom launch options', async t => {
    await refused(t, {
      scenario: { start: 'attach', steps: [{ launch: { reset: 'clear', arguments: [] } }, { assertText: 'ready' }] },
      operations: readOperations(...controlKinds, 'reset'),
    });
  });

  it('does not require an Android-only input operation in the iOS binding', async t => {
    const setup = await fixture(t, async () => noDeviceResult, () => {}, {
      dependencies: prerequisites,
      operations: readOperations(...controlKinds, 'launch', 'terminate', 'type'),
      scenario: { platforms: ['android', 'ios'], setup: [{ type: 'fixture', into: { id: 'note' }, platforms: ['android'] }] },
      files: { 'apps/example.yaml': JSON.stringify({ id: 'example', name: 'Metadata-only dual platform', android: { package: 'example.tickets' }, ios: { bundleId: 'example.tickets.ios' } }) },
    });
    const directory = join(setup.root, '.qa', 'policy', 'regression');
    const policyFile = join(directory, 'policy.json');
    const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as { grants: RegressionGrant[] };
    const original = policy.grants[0]!;
    const grant = structuredClone(original);
    grant.grantId = 'queue-ios';
    grant.subject.target = { platform: 'ios', deviceId: 'metadata-ios' };
    grant.subject.applicationId = 'example.tickets.ios';
    grant.subject.scope.operations = grant.subject.scope.operations.filter(operation => operation.kind !== 'type');
    const evidence = JSON.parse(readFileSync(join(directory, 'evidence', original.evidence.file), 'utf8')) as RegressionGrantEvidence;
    evidence.subject = grant.subject;
    const bytes = JSON.stringify(evidence);
    grant.evidence = { file: 'queue-ios.json', sha256: sha256(bytes) };
    writeAtomic(join(directory, 'evidence', grant.evidence.file), bytes);
    policy.grants.push(grant);
    writeJsonAtomic(policyFile, policy);
    setup.request.targets.push(grant.subject.target);
    setup.request.authorizations.push({ appId: grant.subject.appId, target: grant.subject.target, grantId: grant.grantId, subjectSha256: regressionGrantSubjectSha256(grant.subject) });
    assert.equal((await preflight(setup)).canQueue, true);
    assert.deepEqual(await setup.service.call({ method: 'regression.list' }), []);
  });
});
