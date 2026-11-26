import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import { RegressionGrantError, type RegressionGrant, type RegressionGrantEvidence, type RegressionGrantScope } from '../../src/core/regression-grant.ts';
import { assertRegressionGrant, bindRegressionGrant, listRegressionGrants, selectRegressionGrant } from '../../src/policy/regression-grant.ts';

const NOW = Date.parse('2026-11-01T06:00:00Z');
const operation = { kind: 'tap', effect: 'fixture-write', entityIds: ['order-1'], sinkIds: [] } as const;

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qautra-grant-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.qa', 'policy', 'regression');
  mkdirSync(join(directory, 'evidence'), { recursive: true, mode: 0o700 });
  const scope: RegressionGrantScope = {
    environment: 'staging', tenant: 'tenant-a', accountRef: 'qa-account', credentialRef: 'keychain-qa-account',
    fixture: { id: 'fixture-1', entityIds: ['order-1'], initialStateSha256: 'a'.repeat(64) },
    operations: [{ ...operation, entityIds: [...operation.entityIds], sinkIds: [] }], effects: ['fixture-write'], sinks: [],
  };
  const subject: RegressionGrant['subject'] = { appId: 'shop', target: { platform: 'desktop-chrome', deviceId: 'owned-chrome' }, scope, origins: ['https://staging.example'], policyVersion: 'policy-1' };
  const evidence: RegressionGrantEvidence = {
    schema: 'qautra/backend-enforcement-probe/v1', subject: structuredClone(subject),
    checkedAt: '2026-11-01T06:00:00Z', expiresAt: '2026-11-01T06:05:00Z', enforcement: 'server-enforced-tenant-credential',
    credential: { ref: scope.credentialRef, accountRef: scope.accountRef, tenant: scope.tenant },
    probes: { crossTenant: { tenant: 'tenant-b', observedStatus: 403 }, unownedEntity: { entityId: 'other-order', observedStatus: 403 }, unapprovedSink: { sinkId: 'production-mail', observedStatus: 403 } },
    initialState: { fixtureId: scope.fixture.id, entityIds: [...scope.fixture.entityIds], observedStateSha256: scope.fixture.initialStateSha256 },
  };
  const grant: RegressionGrant = { grantId: 'shop-staging', subject, issuedAt: '2026-11-01T05:59:00Z', expiresAt: '2026-11-01T07:00:00Z', revokedAt: null, evidence: { file: 'shop.json', sha256: '0'.repeat(64) } };
  const policy = { schema: 'qautra/regression-grant-policy/v1', policyVersion: 'policy-1', grants: [grant] };
  const policyFile = join(directory, 'policy.json');
  const evidenceFile = join(directory, 'evidence', 'shop.json');
  function save() {
    const bytes = JSON.stringify(evidence);
    grant.evidence.sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(evidenceFile, bytes, { mode: 0o600 });
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  }
  save();
  const input = { root, grantId: grant.grantId, appId: subject.appId, target: subject.target, scope, origins: subject.origins, now: NOW };
  return { root, directory, scope, subject, evidence, grant, policy, policyFile, evidenceFile, save, input };
}

function denied(action: () => unknown, code: string) {
  assert.throws(action, error => error instanceof RegressionGrantError && error.code === code && error.effect === 'not_started' && error.reasons[0]?.code === code);
}

it('binds trusted historical metadata separately from live runtime proof', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  assert.equal(binding.schema, 'qautra/regression-grant-binding/v2');
  assert.equal(binding.expiresAt, f.grant.expiresAt);
  assert.equal(binding.evidenceCheckedAt, f.evidence.checkedAt);
  assert.equal(binding.evidenceExpiresAt, f.evidence.expiresAt);
  assertRegressionGrant({ root: f.root, binding, operation: { ...operation, entityIds: ['order-1'], sinkIds: [] }, now: NOW + 1 });
  const descriptor = listRegressionGrants(f.root)[0];
  assert.equal(descriptor?.grantId, f.grant.grantId);
  assert.equal(JSON.stringify(descriptor).includes(f.scope.accountRef), false);
  assert.equal(JSON.stringify(descriptor).includes(f.scope.credentialRef), false);
  assert.equal(JSON.stringify(descriptor).includes('probes'), false);
});

it('rejects tenant, account, credential, fixture, state, target, origin, application and effect drift', t => {
  const f = fixture(t);
  const variants = [
    { scope: { ...f.scope, tenant: 'tenant-b' } },
    { scope: { ...f.scope, accountRef: 'other-account' } },
    { scope: { ...f.scope, credentialRef: 'other-credential' } },
    { scope: { ...f.scope, fixture: { ...f.scope.fixture, id: 'fixture-2' } } },
    { scope: { ...f.scope, fixture: { ...f.scope.fixture, initialStateSha256: 'b'.repeat(64) } } },
    { target: { ...f.subject.target, deviceId: 'personal-chrome' } },
    { origins: ['https://production.example'] },
    { applicationId: 'other-app' },
    { scope: { ...f.scope, effects: ['fixture-write', 'read'] } },
  ];
  for (const variant of variants) denied(() => bindRegressionGrant({ ...f.input, ...variant } as typeof f.input), 'grant_scope_mismatch');
});

it('does not expand operations, entities, effects or sinks at dispatch', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  for (const changed of [
    { ...operation, kind: 'press', entityIds: ['order-1'], sinkIds: [] },
    { ...operation, entityIds: ['other-order'], sinkIds: [] },
    { ...operation, effect: 'read', entityIds: ['order-1'], sinkIds: [] },
    { ...operation, effect: 'external-send', entityIds: ['order-1'], sinkIds: ['production-mail'] },
  ]) denied(() => assertRegressionGrant({ root: f.root, binding, operation: changed as Parameters<typeof assertRegressionGrant>[0]['operation'], now: NOW }), 'grant_operation_denied');
});

it('rejects same grant ID with changed content and a forged binding scope', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  const forged = structuredClone(binding);
  forged.subject.scope.tenant = 'tenant-b';
  denied(() => assertRegressionGrant({ root: f.root, binding: forged, operation: f.scope.operations[0]!, now: NOW }), 'grant_changed');
  f.grant.subject.scope.fixture.id = 'fixture-2';
  f.save();
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW }), 'grant_changed');
});

it('rereads policy deletion, revocation and expiry before dispatch', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW + 3_600_000 }), 'grant_expired');
  f.grant.revokedAt = '2026-11-01T06:00:00Z';
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_revoked');
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW }), 'grant_revoked');
  unlinkSync(f.policyFile);
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW }), 'grant_policy_missing');
});

it('rejects absent, changed, expired and unknown enforcement evidence', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  writeFileSync(f.evidenceFile, '{}', { mode: 0o600 });
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW }), 'grant_changed');
  unlinkSync(f.evidenceFile);
  denied(() => bindRegressionGrant(f.input), 'grant_evidence_missing');
  f.save();
  f.evidence.expiresAt = '2026-11-01T06:00:00Z';
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_enforcement_unverified');
  f.evidence.expiresAt = '2026-11-01T06:05:00Z';
  Object.assign(f.evidence, { enforcement: 'declared-isolated' });
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_evidence_invalid');
});

it('requires credential enforcement denial probes and matching observed initial state', t => {
  const f = fixture(t);
  f.evidence.probes.crossTenant.tenant = f.scope.tenant;
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_enforcement_unverified');
  f.evidence.probes.crossTenant.tenant = 'tenant-b';
  f.evidence.initialState.observedStateSha256 = 'b'.repeat(64);
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_initial_state_unverified');
});

it('rejects symlink policy, evidence, directory and project aliases', t => {
  const f = fixture(t);
  const backup = join(f.directory, 'saved.json');
  renameSync(f.policyFile, backup);
  symlinkSync(backup, f.policyFile);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  unlinkSync(f.policyFile);
  renameSync(backup, f.policyFile);
  const savedEvidence = join(f.directory, 'saved-evidence.json');
  renameSync(f.evidenceFile, savedEvidence);
  symlinkSync(savedEvidence, f.evidenceFile);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  unlinkSync(f.evidenceFile);
  renameSync(savedEvidence, f.evidenceFile);
  const evidenceDirectory = join(f.directory, 'evidence');
  renameSync(evidenceDirectory, join(f.directory, 'saved-evidence'));
  symlinkSync(join(f.directory, 'saved-evidence'), evidenceDirectory);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  const alias = `${f.root}-alias`;
  symlinkSync(f.root, alias);
  t.after(() => unlinkSync(alias));
  denied(() => bindRegressionGrant({ ...f.input, root: alias }), 'grant_file_unsafe');
});

it('rejects hardlinks, public permissions and oversized policy bytes', t => {
  const f = fixture(t);
  const alias = join(f.directory, 'hardlink.json');
  linkSync(f.policyFile, alias);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  unlinkSync(alias);
  chmodSync(f.policyFile, 0o644);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  chmodSync(f.policyFile, 0o600);
  chmodSync(join(f.root, '.qa'), 0o755);
  denied(() => bindRegressionGrant(f.input), 'grant_file_unsafe');
  chmodSync(join(f.root, '.qa'), 0o700);
  writeFileSync(f.policyFile, ' '.repeat(256 * 1024 + 1), { mode: 0o600 });
  denied(() => bindRegressionGrant(f.input), 'grant_file_limit');
});

it('rejects traversal, duplicate grants and client authority fields', t => {
  const f = fixture(t);
  f.grant.evidence.file = '../policy.json';
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_policy_invalid');
  f.grant.evidence.file = 'shop.json';
  f.policy.grants.push(structuredClone(f.grant));
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_policy_invalid');
  f.policy.grants.pop();
  Object.assign(f.scope, { allowRisky: true });
  f.save();
  denied(() => bindRegressionGrant(f.input), 'grant_policy_invalid');
});

it('keeps initial probe time historical during a longer authorized flow', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW + 1_200_000 });
  assert.equal(binding.evidenceCheckedAt, f.evidence.checkedAt);
  assert.equal(binding.evidenceExpiresAt, f.evidence.expiresAt);
  denied(() => bindRegressionGrant({ ...f.input, now: NOW + 1_200_000 }), 'grant_enforcement_unverified');
});

it('does not invalidate a selected grant when an unrelated grant changes', t => {
  const f = fixture(t);
  const binding = bindRegressionGrant(f.input);
  f.policy.grants.push({ ...structuredClone(f.grant), grantId: 'other-owner-grant' });
  f.save();
  assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW + 1 });
  f.grant.expiresAt = '2026-11-01T08:00:00Z';
  f.save();
  denied(() => assertRegressionGrant({ root: f.root, binding, operation: f.scope.operations[0]!, now: NOW + 1 }), 'grant_changed');
});

it('selects only the private subject matching the public semantic digest', t => {
  const f = fixture(t);
  const descriptor = listRegressionGrants(f.root)[0]!;
  const input = { root: f.root, grantId: descriptor.grantId, subjectSha256: descriptor.subjectSha256, appId: f.subject.appId, target: f.subject.target, origins: f.subject.origins, now: NOW };
  assert.deepEqual(selectRegressionGrant(input), bindRegressionGrant(f.input));
  denied(() => selectRegressionGrant({ ...input, subjectSha256: '0'.repeat(64) }), 'grant_changed');
});

it('requires separate capture-screen and record-video operations instead of inferring them from read', t => {
  const f = fixture(t);
  f.scope.effects.push('read');
  f.scope.operations.push({ kind: 'observe', effect: 'read', entityIds: [], sinkIds: [] });
  f.evidence.subject = structuredClone(f.subject);
  f.save();
  const binding = bindRegressionGrant(f.input);
  for (const kind of ['capture-screen', 'record-video'] as const) denied(() => assertRegressionGrant({ root: f.root, binding, operation: { kind, effect: 'read', entityIds: [], sinkIds: [] }, now: NOW }), 'grant_operation_denied');
  f.scope.operations.push({ kind: 'capture-screen', effect: 'read', entityIds: [], sinkIds: [] }, { kind: 'record-video', effect: 'read', entityIds: [], sinkIds: [] });
  f.evidence.subject = structuredClone(f.subject);
  f.save();
  const captured = bindRegressionGrant(f.input);
  for (const kind of ['capture-screen', 'record-video'] as const) assertRegressionGrant({ root: f.root, binding: captured, operation: { kind, effect: 'read', entityIds: [], sinkIds: [] }, now: NOW });
  denied(() => assertRegressionGrant({ root: f.root, binding: captured, operation: { kind: 'capture-screen', effect: 'external-send', entityIds: ['order-1'], sinkIds: ['outside'] }, now: NOW }), 'grant_operation_denied');
});
