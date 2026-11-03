import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { RegressionGrantError } from '../../src/core/regression-grant.ts';
import { ProjectFixtureClientWitnessSchema, ProjectFixtureError, projectFixtureCanonical, type ProjectFixtureEnvelope, type ProjectFixtureGuard } from '../../src/core/project-fixture.ts';
import { regressionGrantSubjectSha256 } from '../../src/policy/regression-grant.ts';
import { createProjectFixtureGuard, createProjectFixtureRecoveryObserver } from '../../src/runner/project-fixture.ts';
import { baselineEntities, changedEntities, INITIAL, CHANGED, tap, iso, fixture } from '../fixtures/project-fixture.ts';

function denied(code: string, effect?: string) {
  return (error: unknown) => error instanceof ProjectFixtureError && error.code === code && (effect === undefined || error.effect === effect);
}

it('requires a provisioned adapter and credentials before any backend effect', async t => {
  const f = await fixture(t);
  unlinkSync(f.adapterFile);
  assert.throws(f.guard, denied('fixture_adapter_missing', 'not_started'));
  f.save();
  delete process.env[f.authName];
  await assert.rejects(f.guard().prepare(), denied('fixture_credential_missing', 'not_started'));
  assert.equal(f.state.requests, 0);
  assert.equal(f.state.prepareCount, 0);
});

it('prepares the approved baseline and requires a cookie-authenticated, single-use current principal witness', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const prepared = await guard.prepare();
  assert.deepEqual(f.state.entities, baselineEntities);
  assert.equal(prepared.comparison, 'unobserved');
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_client_unverified'));
  let cookie = '';
  await guard.withBootstrap(async payload => { cookie = `${payload.cookie.name}=${payload.cookie.value}`; assert.equal(JSON.stringify(payload).includes(f.cookieValue), false); });
  const unauthenticated = await fetch(guard.clientWitnessRequest().url, { redirect: 'error' });
  assert.equal(unauthenticated.status, 403);
  guard.acceptClientWitness(await f.clientWitness(guard, cookie));
  assert.equal(guard.assertCurrentProof(tap).comparison, 'same_conditions');
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_proof_stale'));
  const files = readdirSync(join(f.root, '.qa', 'fixture-requests')).map(file => readFileSync(join(f.root, '.qa', 'fixture-requests', file), 'utf8')).join('');
  assert.equal(files.includes(f.cookieValue), false);
  assert.equal(files.includes(process.env[f.authName]!), false);
  assert.equal(JSON.stringify(guard.currentProof()).includes(f.cookieValue), false);
});

it('rejects a fixed endpoint peer, origin and secret mismatch without granting runtime proof', async t => {
  const f = await fixture(t);
  f.adapter.peerAddresses = ['127.0.0.2'];
  f.save();
  assert.throws(f.guard, denied('fixture_adapter_invalid'));
  f.adapter.peerAddresses = ['127.0.0.1'];
  f.adapter.bootstrap.origin = 'https://production.example';
  f.save();
  assert.throws(f.guard, denied('fixture_scope_denied'));
  f.adapter.bootstrap.origin = f.origin;
  f.save();
  const guard = f.guard();
  process.env[f.authName] = randomBytes(32).toString('hex');
  await assert.rejects(guard.prepare(), denied('fixture_response_invalid', 'unknown'));
  assert.equal(f.state.prepareCount, 0);
  assert.equal(guard.currentProof(), undefined);
});

it('rejects DNS peers outside the protected address pins before sending a credential', async t => {
  const f = await fixture(t);
  f.adapter.endpoint = `https://localhost:${new URL(f.origin).port}/guard`;
  f.adapter.peerAddresses = ['127.0.0.2'];
  f.adapter.tlsCertificateSha256 = INITIAL;
  f.save();
  await assert.rejects(f.guard().prepare(), denied('fixture_peer_mismatch', 'not_started'));
  assert.equal(f.state.requests, 0);
});

it('rejects signed nonce, subject, attempt, owner, scope and bootstrap-origin mismatches', async t => {
  const faults: ((envelope: ProjectFixtureEnvelope) => void)[] = [
    value => { value.receipt.challenge = CHANGED; },
    value => { value.receipt.subjectSha256 = CHANGED; },
    value => { value.receipt.attemptId = 'other-attempt'; },
    value => { value.receipt.ownerId = 'other-owner'; },
    value => { value.receipt.scopeSha256 = CHANGED; },
    value => { if (value.bootstrap?.kind === 'web-cookie') value.bootstrap.origin = 'https://production.example'; },
  ];
  for (const fault of faults) {
    const f = await fixture(t);
    f.state.fault = fault;
    const guard = f.guard();
    await assert.rejects(guard.prepare(), denied('fixture_receipt_mismatch', 'unknown'));
    assert.equal(guard.currentProof(), undefined);
    assert.equal(f.state.prepareCount, 1);
  }
});

it('requires authenticated receipts, not HTTP 200 or caller booleans', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  process.env[f.keyName] = randomBytes(32).toString('hex');
  await assert.rejects(guard.prepare(), denied('fixture_response_invalid', 'unknown'));
  assert.throws(() => guard.acceptClientWitness({ authorized: true, clean: true }), denied('fixture_response_invalid'));
  assert.equal(guard.currentProof(), undefined);
});

it('records backend-denied scope as not committed and never dispatches preparation again', async t => {
  const f = await fixture(t);
  f.state.denied = true;
  const guard = f.guard();
  await assert.rejects(guard.prepare(), denied('fixture_scope_denied', 'not_committed'));
  await assert.rejects(guard.prepare(), denied('fixture_state_invalid'));
  assert.equal(f.state.prepareCount, 0);
  assert.equal(f.state.requests, 1);
});

it('blocks baseline drift and mixed frontend/API/config conditions without rewriting the expected state', async t => {
  const f = await fixture(t);
  f.state.driftBaseline = true;
  const guard = f.guard();
  await assert.rejects(guard.prepare(), denied('fixture_baseline_drift', 'committed'));
  assert.equal(guard.initialProof(), undefined);
  assert.equal(f.subject.scope.fixture.initialStateSha256, INITIAL);
  assert.equal(guard.currentProof()?.state.currentStateSha256, CHANGED);
  const other = await fixture(t);
  const otherGuard = other.guard();
  await other.start(otherGuard);
  const initial = otherGuard.initialProof();
  other.state.driftConditions = true;
  await assert.rejects(otherGuard.observe(), denied('fixture_conditions_drift'));
  assert.deepEqual(otherGuard.initialProof(), initial);
  assert.equal(otherGuard.currentProof()?.comparison, 'changed_conditions');
  assert.throws(() => otherGuard.assertCurrentProof(tap), denied('fixture_client_unverified'));
});

it('keeps a lost mutating response unknown across restart and reconciles cleanup without replay', async t => {
  const f = await fixture(t);
  const binding = f.bind();
  f.state.losePrepareResponse = true;
  const guard = createProjectFixtureGuard({ root: f.root, binding, attemptId: 'attempt-1', ownerId: 'owner-1' });
  await assert.rejects(guard.prepare(), denied('fixture_transport_failed', 'unknown'));
  assert.equal(f.state.prepareCount, 1);
  const recovered = createProjectFixtureGuard({ root: f.root, binding, attemptId: 'attempt-1', ownerId: 'owner-1' });
  await assert.rejects(recovered.prepare(), denied('fixture_state_invalid', 'unknown'));
  const observation = await recovered.observe();
  assert.equal(observation.effect, 'unknown');
  assert.equal(observation.comparison, 'unobserved');
  const cleaned = await recovered.cleanup();
  assert.equal(cleaned.cleanup, 'complete');
  assert.equal(cleaned.effect, 'unknown');
  assert.equal(f.state.prepareCount, 1);
});

it('holds pending effects until a revoked fence rejects their delayed commit', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const release = await f.queueEffect(cookie);
  await guard.observe();
  guard.acceptClientWitness(await f.clientWitness(guard, cookie));
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_effects_pending'));
  await assert.rejects(guard.settle(), denied('fixture_effects_pending'));
  assert.equal(f.state.fence, 'revoked');
  assert.equal(f.state.pending.size, 1);
  await release();
  assert.equal(f.state.appliedEffects, 0);
  assert.equal(f.state.blockedEffects, 1);
  const cleaned = await guard.cleanup();
  assert.equal(cleaned.cleanup, 'complete');
  assert.equal(cleaned.ledger.pendingEffectIds.length, 0);
  assert.equal(cleaned.state.currentStateSha256, INITIAL);
});

it('does not call incomplete cleanup safe or retry its mutating request', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  f.state.incompleteCleanup = true;
  await assert.rejects(guard.cleanup(), denied('fixture_cleanup_incomplete'));
  assert.equal(guard.currentProof()?.cleanup, 'incomplete');
  await assert.rejects(guard.cleanup(), denied('fixture_request_reused'));
});

it('refreshes live conditions after twenty minutes without redating the original baseline probe', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T09:00:00Z') });
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const initial = guard.initialProof();
  t.mock.timers.tick(1_200_000);
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_proof_stale'));
  f.state.entities = structuredClone(changedEntities);
  await guard.observe();
  guard.acceptClientWitness(await f.clientWitness(guard, cookie));
  assert.equal(guard.assertCurrentProof(tap).state.currentStateSha256, CHANGED);
  assert.deepEqual(guard.initialProof(), initial);
  assert.equal(f.evidence.checkedAt, iso(Date.parse('2026-11-01T09:00:00Z') - 500));
});

it('renews only unchanged material authority through the live chained backend receipt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T09:00:00Z') });
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const initial = guard.initialProof();
  t.mock.timers.tick(1000);
  f.evidence.checkedAt = iso(Date.now());
  f.evidence.expiresAt = iso(Date.now() + 299_000);
  f.grant.expiresAt = iso(Date.now() + 3_600_000);
  f.save();
  assert.throws(() => guard.assertCurrentProof(tap), error => error instanceof RegressionGrantError && error.code === 'grant_changed');
  await guard.renew(f.bind());
  guard.acceptClientWitness(await f.clientWitness(guard, cookie));
  assert.equal(guard.assertCurrentProof(tap).comparison, 'same_conditions');
  assert.deepEqual(guard.initialProof(), initial);
  const expanded = f.bind();
  expanded.subject.scope.effects.push('read');
  await assert.rejects(guard.renew(expanded), denied('fixture_scope_denied'));
});

it('rejects stale renewal receipts and audit-chain substitution', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  f.state.fault = value => { value.receipt.previousReceiptSha256 = CHANGED; };
  await assert.rejects(guard.renew(f.bind()), denied('fixture_receipt_mismatch', 'unknown'));
  const other = await fixture(t);
  const otherGuard = other.guard();
  await other.start(otherGuard);
  other.state.fault = value => { value.receipt.issuedAt = iso(Date.now() - 60_000); value.receipt.expiresAt = iso(Date.now() - 1); };
  await assert.rejects(otherGuard.renew(other.bind()), denied('fixture_proof_stale', 'unknown'));
});

it('rejects a stale or different current browser principal witness', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const oldWitness = await f.clientWitness(guard, cookie);
  await guard.observe();
  assert.throws(() => guard.acceptClientWitness(oldWitness), denied('fixture_client_unverified'));
  const other = await fixture(t);
  const otherGuard = other.guard();
  const otherCookie = await other.start(otherGuard);
  const otherWitness = await other.clientWitness(otherGuard, otherCookie);
  assert.throws(() => guard.acceptClientWitness(otherWitness), denied('fixture_client_unverified'));
  const changedPrincipal = ProjectFixtureClientWitnessSchema.parse(await f.clientWitness(guard, cookie));
  changedPrincipal.witness.principalRef = 'other-current-principal';
  changedPrincipal.signature = createHmac('sha256', process.env[f.keyName]!).update(projectFixtureCanonical({ witness: changedPrincipal.witness })).digest('hex');
  assert.throws(() => guard.acceptClientWitness(changedPrincipal), denied('fixture_client_unverified'));
});

it('does not follow redirects, accept an oversized body, or accept a bare success status', async t => {
  for (const mode of ['redirect', 'oversize', 'plain200'] as const) {
    const f = await fixture(t);
    f.state.responseMode = mode;
    const guard = f.guard();
    await assert.rejects(guard.prepare(), denied('fixture_response_invalid', 'unknown'));
    assert.equal(f.state.prepareCount, 1);
    assert.equal(f.state.redirectRequests, 0);
    assert.equal(guard.currentProof(), undefined);
  }
});

it('treats an actual mutating HTTP deadline as unknown without automatic retransmission', async t => {
  const f = await fixture(t);
  f.adapter.limits.timeoutMs = 50;
  f.state.responseMode = 'hold';
  f.save();
  const guard = f.guard();
  await assert.rejects(guard.prepare(), denied('fixture_transport_failed', 'unknown'));
  await assert.rejects(guard.prepare(), denied('fixture_state_invalid', 'unknown'));
  assert.equal(f.state.prepareCount, 1);
  assert.equal(f.state.requests, 1);
});

it('reconciles a lost cleanup ACK only through the live revoked-fence ledger and restoration receipt', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  f.state.loseCleanupResponse = true;
  await assert.rejects(guard.cleanup(), denied('fixture_transport_failed', 'unknown'));
  const observed = await guard.observe();
  assert.equal(observed.cleanup, 'complete');
  assert.equal(observed.effect, 'unknown');
  assert.equal(observed.ledger.disposition, 'drained');
  assert.equal(observed.ledger.fenceStatus, 'revoked');
  assert.equal(observed.ledger.restoration, 'restored');
  await assert.rejects(guard.cleanup(), denied('fixture_request_reused', 'unknown'));
});

it('keeps a driver-reported unknown outcome separate from confirmed backend cleanup', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const release = await f.queueEffect(cookie);
  guard.markDispatchUnknown();
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_client_unverified', 'unknown'));
  await assert.rejects(guard.settle(), denied('fixture_effects_pending', 'unknown'));
  await release();
  const cleaned = await guard.cleanup();
  assert.equal(cleaned.cleanup, 'complete');
  assert.equal(cleaned.effect, 'unknown');
  assert.equal(cleaned.comparison, 'unobserved');
  assert.equal(f.state.blockedEffects, 1);
  assert.equal(f.state.appliedEffects, 0);
});

it('rejects native bootstrap instead of inventing host input or arbitrary script authority', async t => {
  const f = await fixture(t);
  const binding = f.bind();
  binding.subject.origins = [];
  binding.subject.applicationId = 'com.example.shop';
  f.adapter.subjectSha256 = regressionGrantSubjectSha256(binding.subject);
  f.save();
  assert.throws(() => createProjectFixtureGuard({ root: f.root, binding, attemptId: 'native-attempt', ownerId: 'owner-1' }), denied('fixture_native_bootstrap_unsupported'));
  assert.equal(f.state.requests, 0);
});

it('invalidates an earlier principal proof when fresh signed client conditions drift', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  await guard.observe();
  const witness = ProjectFixtureClientWitnessSchema.parse(await f.clientWitness(guard, cookie));
  guard.acceptClientWitness(witness);
  witness.witness.conditions.frontendSha256 = CHANGED;
  witness.signature = createHmac('sha256', process.env[f.keyName]!).update(projectFixtureCanonical({ witness: witness.witness })).digest('hex');
  assert.throws(() => guard.acceptClientWitness(witness), denied('fixture_conditions_drift'));
  assert.throws(() => guard.assertCurrentProof(tap), denied('fixture_client_unverified'));
  assert.equal(guard.currentProof()?.comparison, 'changed_conditions');
  await guard.observe();
  assert.equal(guard.currentProof()?.comparison, 'changed_conditions');
  assert.throws(() => guard.acceptClientWitness(witness), denied('fixture_client_unverified'));
});

it('recovers a lost cleanup ACK after grant expiry without current policy or mutating authority', async t => {
  const f = await fixture(t);
  const binding = f.bind();
  const guard = f.guard();
  await f.start(guard);
  f.state.loseCleanupResponse = true;
  await assert.rejects(guard.cleanup(), denied('fixture_transport_failed', 'unknown'));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3_600_001 });
  rmSync(join(f.root, '.qa', 'policy'), { recursive: true });
  const input = { root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' };
  const observer = createProjectFixtureRecoveryObserver(input);
  const proof = await observer.observe();
  assert.equal(proof.cleanup, 'complete');
  assert.equal(proof.effect, 'unknown');
  assert.equal(proof.comparison, 'unobserved');
  assert.equal(proof.ledger.fenceStatus, 'revoked');
  assert.equal(proof.ledger.restoration, 'restored');
  assert.equal(proof.ledger.disposition, 'drained');
  assert.deepEqual(f.state.entities, baselineEntities);
  assert.throws(() => (observer as unknown as ProjectFixtureGuard).cleanup(), TypeError);
  assert.throws(() => (observer as unknown as ProjectFixtureGuard).renew(binding), TypeError);
  const second = await createProjectFixtureRecoveryObserver(input).observe();
  assert.ok(second.ledger.sequence > proof.ledger.sequence);
  assert.deepEqual(f.state.phases, ['prepare', 'cleanup', 'observe', 'observe']);
  assert.equal(f.state.prepareCount, 1);
});

it('observes an ACK-lost prepare from its original authority without re-preparing or creating a client bootstrap', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  f.state.losePrepareResponse = true;
  await assert.rejects(guard.prepare(), denied('fixture_transport_failed', 'unknown'));
  const observer = createProjectFixtureRecoveryObserver({ root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' });
  const proof = await observer.observe();
  assert.equal(proof.cleanup, 'incomplete');
  assert.equal(proof.effect, 'unknown');
  assert.equal(proof.comparison, 'unobserved');
  assert.equal(proof.lease.id, 'lease-1');
  assert.equal(proof.lease.fence, 11);
  assert.throws(() => (observer as unknown as ProjectFixtureGuard).withBootstrap(async () => {}), TypeError);
  assert.deepEqual(f.state.phases, ['prepare', 'observe']);
  assert.equal(f.state.prepareCount, 1);
});

it('refuses altered original authority and bootstrap-hash history before contacting the backend', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  const directory = join(f.root, '.qa', 'fixture-requests');
  const input = { root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' };
  const requests = f.state.requests;
  const receiptFile = readdirSync(directory).map(name => join(directory, name)).find(file => JSON.parse(readFileSync(file, 'utf8')).schema === 'qautra/project-fixture-audit-receipt/v1')!;
  const original = readFileSync(receiptFile, 'utf8');
  const receipt = JSON.parse(original);
  assert.notEqual(receipt.bootstrapSha256, null);
  receipt.bootstrapSha256 = '0'.repeat(64);
  writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.throws(() => createProjectFixtureRecoveryObserver(input), denied('fixture_recovery_unavailable', 'unknown'));
  writeFileSync(receiptFile, original);
  const archiveFile = join(directory, readdirSync(directory).find(name => name.endsWith('-prepare-authority.json'))!);
  const archive = JSON.parse(readFileSync(archiveFile, 'utf8'));
  archive.binding.expiresAt = iso(Date.now() + 86_400_000);
  writeFileSync(archiveFile, JSON.stringify(archive));
  assert.throws(() => createProjectFixtureRecoveryObserver(input), denied('fixture_recovery_unavailable', 'unknown'));
  assert.equal(f.state.requests, requests);
});

it('refuses missing or rotated original credentials instead of adopting replacement policy authority', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  const input = { root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' };
  const requests = f.state.requests;
  const originalKey = process.env[f.keyName]!;
  delete process.env[f.keyName];
  assert.throws(() => createProjectFixtureRecoveryObserver(input), denied('fixture_credential_missing', 'unknown'));
  process.env[f.keyName] = randomBytes(32).toString('hex');
  assert.throws(() => createProjectFixtureRecoveryObserver(input), denied('fixture_recovery_unavailable', 'unknown'));
  process.env[f.keyName] = originalKey;
  delete process.env[f.authName];
  assert.throws(() => createProjectFixtureRecoveryObserver(input), denied('fixture_credential_missing', 'unknown'));
  assert.equal(f.state.requests, requests);
});

it('rejects a fresh signed receipt for a different lease fence after cold recovery', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  await f.start(guard);
  const observer = createProjectFixtureRecoveryObserver({ root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' });
  f.state.fault = envelope => {
    envelope.receipt.lease = { ...envelope.receipt.lease, fence: envelope.receipt.lease.fence + 1 };
    envelope.receipt.ledger.throughFence = envelope.receipt.lease.fence;
  };
  await assert.rejects(observer.observe(), denied('fixture_receipt_mismatch', 'unknown'));
  assert.equal(f.state.prepareCount, 1);
  assert.deepEqual(f.state.phases, ['prepare', 'observe']);
});

it('keeps late effects and missing restoration incomplete without replaying settlement or cleanup', async t => {
  const f = await fixture(t);
  const guard = f.guard();
  const cookie = await f.start(guard);
  const release = await f.queueEffect(cookie);
  await assert.rejects(guard.settle(), denied('fixture_effects_pending', 'committed'));
  const observer = createProjectFixtureRecoveryObserver({ root: f.root, seedId: guard.recoverySeedId, attemptId: 'attempt-1', ownerId: 'owner-1' });
  const pending = await observer.observe();
  assert.equal(pending.cleanup, 'quarantined');
  assert.equal(pending.effect, 'unknown');
  assert.equal(pending.ledger.pendingEffectIds.length, 1);
  await release();
  const drained = await observer.observe();
  assert.equal(drained.cleanup, 'incomplete');
  assert.equal(drained.ledger.disposition, 'drained');
  assert.equal(drained.ledger.restoration, 'not_requested');
  assert.equal(f.state.blockedEffects, 1);
  assert.deepEqual(f.state.phases, ['prepare', 'settle', 'observe', 'observe']);
});
