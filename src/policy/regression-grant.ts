import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  RegressionGrantBindingSchema, RegressionGrantError, RegressionGrantEvidenceSchema,
  RegressionGrantOperationSchema, RegressionGrantPolicySchema, RegressionGrantSubjectSchema,
  type RegressionGrant, type RegressionGrantBinding, type RegressionGrantBlockCode,
  type RegressionGrantDescriptor, type RegressionGrantScope,
} from '../core/regression-grant.ts';
import type { RegressionTarget } from '../core/regression.ts';

interface LoadedPolicy {
  root: string;
  directory: string;
  policy: z.infer<typeof RegressionGrantPolicySchema>;
}

export function regressionGrantCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(regressionGrantCanonical).sort().join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${regressionGrantCanonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function regressionGrantSubjectSha256(subject: RegressionGrantBinding['subject']): string {
  return digest(regressionGrantCanonical(subject));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: RegressionGrantBlockCode): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RegressionGrantError(code);
  return parsed.data;
}

export function readTrustedRegressionFile(root: string, file: string, maximum: number, missing: RegressionGrantBlockCode): Buffer {
  const directories: { path: string; ino: number; dev: number }[] = [];
  let cursor = dirname(file);
  try {
    while (true) {
      const stat = lstatSync(cursor);
      const inside = cursor === root || cursor.startsWith(`${root}/`);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (inside && (stat.uid !== process.getuid?.() || (stat.mode & (cursor === root ? 0o022 : 0o077)) !== 0))) throw new RegressionGrantError('grant_file_unsafe');
      directories.push({ path: cursor, ino: stat.ino, dev: stat.dev });
      const parent = dirname(cursor);
      if (cursor === parent) break;
      cursor = parent;
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || (before.mode & 0o077) !== 0) throw new RegressionGrantError('grant_file_unsafe');
      if (before.size < 1 || before.size > maximum) throw new RegressionGrantError('grant_file_limit');
      const bytes = Buffer.allocUnsafe(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      const after = fstatSync(fd);
      const named = lstatSync(file);
      if (count !== before.size || before.ino !== named.ino || before.dev !== named.dev || named.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode || after.uid !== before.uid || after.nlink !== 1) throw new RegressionGrantError('grant_file_changed');
      for (const directory of directories) {
        const current = lstatSync(directory.path);
        if (current.ino !== directory.ino || current.dev !== directory.dev || current.isSymbolicLink()) throw new RegressionGrantError('grant_file_changed');
      }
      return bytes.subarray(0, count);
    } finally { closeSync(fd); }
  } catch (error) {
    if (error instanceof RegressionGrantError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new RegressionGrantError(missing);
    throw new RegressionGrantError('grant_file_unsafe');
  }
}

function json(bytes: Buffer, code: RegressionGrantBlockCode): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new RegressionGrantError(code); }
}

function load(rootInput: string): LoadedPolicy {
  if (typeof rootInput !== 'string' || rootInput.length === 0 || rootInput.length > 4096) throw new RegressionGrantError('grant_input_invalid');
  const root = resolve(rootInput);
  const directory = join(root, '.qa', 'policy', 'regression');
  const bytes = readTrustedRegressionFile(root, join(directory, 'policy.json'), 256 * 1024, 'grant_policy_missing');
  const policy = parse(RegressionGrantPolicySchema, json(bytes, 'grant_policy_invalid'), 'grant_policy_invalid');
  return { root, directory, policy };
}

function currentGrant(grant: RegressionGrant, policyVersion: string, now: number): void {
  if (!Number.isFinite(now)) throw new RegressionGrantError('grant_input_invalid');
  if (grant.revokedAt !== null) throw new RegressionGrantError('grant_revoked');
  if (Date.parse(grant.issuedAt) > now || Date.parse(grant.expiresAt) <= now || Date.parse(grant.issuedAt) >= Date.parse(grant.expiresAt)) throw new RegressionGrantError('grant_expired');
  if (grant.subject.policyVersion !== policyVersion) throw new RegressionGrantError('grant_scope_mismatch');
}

function evidenceFor(loaded: LoadedPolicy, grant: RegressionGrant, now: number, initialBinding = true) {
  const bytes = readTrustedRegressionFile(loaded.root, join(loaded.directory, 'evidence', grant.evidence.file), 64 * 1024, 'grant_evidence_missing');
  if (digest(bytes) !== grant.evidence.sha256) throw new RegressionGrantError('grant_changed');
  const evidence = parse(RegressionGrantEvidenceSchema, json(bytes, 'grant_evidence_invalid'), 'grant_evidence_invalid');
  if (regressionGrantCanonical(evidence.subject) !== regressionGrantCanonical(grant.subject)) throw new RegressionGrantError('grant_scope_mismatch');
  if (Date.parse(evidence.checkedAt) > now || Date.parse(evidence.checkedAt) < Date.parse(grant.issuedAt) || (initialBinding && Date.parse(evidence.expiresAt) <= now) || Date.parse(evidence.expiresAt) - Date.parse(evidence.checkedAt) > 300_000 || Date.parse(evidence.expiresAt) <= Date.parse(evidence.checkedAt)) throw new RegressionGrantError('grant_enforcement_unverified');
  const scope = grant.subject.scope;
  if (evidence.credential.ref !== scope.credentialRef || evidence.credential.accountRef !== scope.accountRef || evidence.credential.tenant !== scope.tenant || evidence.probes.crossTenant.tenant === scope.tenant || scope.fixture.entityIds.includes(evidence.probes.unownedEntity.entityId) || scope.sinks.some(sink => sink.id === evidence.probes.unapprovedSink.sinkId)) throw new RegressionGrantError('grant_enforcement_unverified');
  if (evidence.initialState.fixtureId !== scope.fixture.id || regressionGrantCanonical(evidence.initialState.entityIds) !== regressionGrantCanonical(scope.fixture.entityIds) || evidence.initialState.observedStateSha256 !== scope.fixture.initialStateSha256) throw new RegressionGrantError('grant_initial_state_unverified');
  return evidence;
}

/** Binds owner metadata and its historical probe, not a live principal, fixture or effect ledger. */
export function bindRegressionGrant(input: {
  root: string;
  grantId: string;
  appId: string;
  target: RegressionTarget;
  scope: RegressionGrantScope;
  origins?: string[];
  applicationId?: string;
  now?: number;
}): RegressionGrantBinding {
  const loaded = load(input.root);
  const grant = loaded.policy.grants.find(item => item.grantId === input.grantId);
  if (!grant) throw new RegressionGrantError('grant_not_found');
  const now = input.now ?? Date.now();
  currentGrant(grant, loaded.policy.policyVersion, now);
  const subject = parse(RegressionGrantSubjectSchema, { appId: input.appId, target: input.target, scope: input.scope, origins: input.origins ?? [], ...(input.applicationId === undefined ? {} : { applicationId: input.applicationId }), policyVersion: loaded.policy.policyVersion }, 'grant_input_invalid');
  if (regressionGrantCanonical(subject) !== regressionGrantCanonical(grant.subject)) throw new RegressionGrantError('grant_scope_mismatch');
  const evidence = evidenceFor(loaded, grant, now);
  return {
    schema: 'qautra/regression-grant-binding/v2', grantId: grant.grantId, root: loaded.root,
    grantSha256: digest(regressionGrantCanonical(grant)), evidenceSha256: grant.evidence.sha256,
    evidenceCheckedAt: evidence.checkedAt, evidenceExpiresAt: evidence.expiresAt,
    subject, expiresAt: grant.expiresAt,
  };
}

/** Dispatch also requires ProjectFixtureGuard.assertCurrentProof; probe age is not current backend evidence. */
export function assertRegressionGrant(input: {
  root: string;
  binding: RegressionGrantBinding;
  operation: z.input<typeof RegressionGrantOperationSchema>;
  now?: number;
}): void {
  const binding = parse(RegressionGrantBindingSchema, input.binding, 'grant_input_invalid');
  const operation = parse(RegressionGrantOperationSchema, input.operation, 'grant_input_invalid');
  const now = input.now ?? Date.now();
  const loaded = load(input.root);
  if (binding.root !== loaded.root) throw new RegressionGrantError('grant_changed');
  const grant = loaded.policy.grants.find(item => item.grantId === binding.grantId);
  if (!grant) throw new RegressionGrantError('grant_not_found');
  currentGrant(grant, loaded.policy.policyVersion, now);
  if (Date.parse(binding.expiresAt) <= now) throw new RegressionGrantError('grant_expired');
  if (binding.grantSha256 !== digest(regressionGrantCanonical(grant)) || binding.evidenceSha256 !== grant.evidence.sha256 || regressionGrantCanonical(binding.subject) !== regressionGrantCanonical(grant.subject)) throw new RegressionGrantError('grant_changed');
  const evidence = evidenceFor(loaded, grant, now, false);
  if (binding.evidenceCheckedAt !== evidence.checkedAt || binding.evidenceExpiresAt !== evidence.expiresAt) throw new RegressionGrantError('grant_changed');
  if (Date.parse(binding.expiresAt) > Date.parse(grant.expiresAt)) throw new RegressionGrantError('grant_changed');
  if (!grant.subject.scope.operations.some(allowed => regressionGrantCanonical(allowed) === regressionGrantCanonical(operation))) throw new RegressionGrantError('grant_operation_denied');
}

export function selectRegressionGrant(input: {
  root: string;
  grantId: string;
  subjectSha256: string;
  appId: string;
  target: RegressionTarget;
  origins?: string[];
  applicationId?: string;
  now?: number;
}): RegressionGrantBinding {
  const loaded = load(input.root);
  const grant = loaded.policy.grants.find(item => item.grantId === input.grantId);
  if (!grant) throw new RegressionGrantError('grant_not_found');
  if (regressionGrantSubjectSha256(grant.subject) !== input.subjectSha256) throw new RegressionGrantError('grant_changed');
  return bindRegressionGrant({ ...input, scope: grant.subject.scope });
}

export function listRegressionGrants(root: string): RegressionGrantDescriptor[] {
  return load(root).policy.grants.map(grant => ({
    grantId: grant.grantId, subjectSha256: regressionGrantSubjectSha256(grant.subject), appId: grant.subject.appId, target: grant.subject.target,
    environment: grant.subject.scope.environment, tenant: grant.subject.scope.tenant,
    policyVersion: grant.subject.policyVersion, expiresAt: grant.expiresAt, revoked: grant.revokedAt !== null,
  }));
}
