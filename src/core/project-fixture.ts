import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { RegressionGrantBindingSchema, RegressionGrantSubjectSchema, type RegressionGrantBinding, type RegressionGrantOperation } from './regression-grant.ts';

const Ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const EnvRef = z.string().regex(/^env:[A-Z_][A-Z0-9_]{0,127}$/);
const Ids = z.array(Ref).max(100).refine(values => new Set(values).size === values.length);
const Origin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }
  catch { return false; }
});
const Path = z.string().regex(/^\/[A-Za-z0-9/_-]*$/).max(512).refine(value => !value.startsWith('//'));
const Conditions = z.strictObject({ frontendSha256: Digest, apiSha256: Digest, configSha256: Digest });
export const PROJECT_FIXTURE_PROTOCOL = 'qautra/project-fixture/v1' as const;
export const ProjectFixturePhaseSchema = z.enum(['prepare', 'observe', 'settle', 'cleanup', 'renew']);
export const ProjectFixtureNativeIdentitySchema = z.strictObject({
  platform: z.enum(['android', 'ios']), deviceId: Ref, applicationId: Ref,
  buildSha256: Digest, sessionId: Ref,
});
const WebBootstrapConfiguration = z.strictObject({ kind: z.literal('web-cookie'), origin: Origin, cookieName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/), entryPath: Path, witnessPath: Path });
const NativeBootstrapConfiguration = z.strictObject({
  kind: z.literal('native-private-mailbox'), applicationId: Ref, buildSha256: Digest,
  mailbox: z.literal('qautra-fixture'), clientEndpoint: z.string().url().max(2048),
});
export const ProjectFixtureAdapterSchema = z.strictObject({
  id: Ref,
  grantId: Ref,
  subjectSha256: Digest,
  endpoint: z.string().max(2048),
  peerAddresses: z.array(z.string().refine(value => isIP(value) !== 0)).min(1).max(8).refine(values => new Set(values).size === values.length),
  tlsCertificateSha256: Digest.nullable(),
  credentialRef: EnvRef,
  receiptKeyRef: EnvRef,
  enforcement: z.strictObject({ protocol: z.literal(PROJECT_FIXTURE_PROTOCOL), auditRef: Ref, auditSha256: Digest }),
  conditions: Conditions,
  limits: z.strictObject({
    timeoutMs: z.number().int().min(50).max(30_000),
    maximumRequestBytes: z.number().int().min(1024).max(65_536),
    maximumResponseBytes: z.number().int().min(1024).max(262_144),
    proofTtlMs: z.number().int().min(50).max(60_000),
    leaseTtlMs: z.number().int().min(1000).max(3_600_000),
  }),
  bootstrap: z.discriminatedUnion('kind', [WebBootstrapConfiguration, NativeBootstrapConfiguration]),
}).superRefine((adapter, context) => {
  try {
    const url = new URL(adapter.endpoint);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '127.0.0.1' || host === '::1';
    if (url.href !== adapter.endpoint || url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && (!loopback || adapter.peerAddresses.some(peer => peer !== host))) || (url.protocol === 'https:' && adapter.tlsCertificateSha256 === null) || (isIP(host) !== 0 && !adapter.peerAddresses.includes(host))) throw new Error();
    if (adapter.bootstrap.kind === 'web-cookie') {
      const bootstrapOrigin = new URL(adapter.bootstrap.origin);
      if (bootstrapOrigin.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(bootstrapOrigin.hostname) && !bootstrapOrigin.hostname.endsWith('.localhost')) throw new Error();
    } else {
      const client = new URL(adapter.bootstrap.clientEndpoint);
      if (client.protocol !== 'https:' || client.username || client.password || client.hash || client.search) throw new Error();
    }
  } catch { context.addIssue({ code: 'custom', message: 'A fixed HTTPS endpoint with certificate and address pins, or an exact loopback HTTP peer, is required' }); }
});
export const ProjectFixturePolicySchema = z.strictObject({
  schema: z.literal('qautra/project-fixture-policy/v1'),
  adapters: z.array(ProjectFixtureAdapterSchema).min(1).max(100),
}).superRefine((policy, context) => {
  if (new Set(policy.adapters.map(adapter => adapter.grantId)).size !== policy.adapters.length) context.addIssue({ code: 'custom', message: 'Duplicate grant adapter' });
});
export const ProjectFixtureLeaseSchema = z.strictObject({ id: Ref, generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), fence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), expiresAt: Timestamp });
export const ProjectFixtureRequestSchema = z.strictObject({
  schema: z.literal(PROJECT_FIXTURE_PROTOCOL),
  phase: ProjectFixturePhaseSchema,
  requestKey: Digest,
  challenge: Digest,
  attemptId: Ref,
  ownerId: Ref,
  subject: RegressionGrantSubjectSchema,
  subjectSha256: Digest,
  scopeSha256: Digest,
  adapterSha256: Digest,
  grantSha256: Digest,
  grantExpiresAt: Timestamp,
  previousReceiptSha256: Digest.nullable(),
  lease: ProjectFixtureLeaseSchema.nullable(),
  nativeClient: ProjectFixtureNativeIdentitySchema.optional(),
});
const Receipt = z.strictObject({
  schema: z.literal(PROJECT_FIXTURE_PROTOCOL),
  phase: ProjectFixturePhaseSchema,
  requestKey: Digest,
  challenge: Digest,
  attemptId: Ref,
  ownerId: Ref,
  subjectSha256: Digest,
  scopeSha256: Digest,
  adapterSha256: Digest,
  grantSha256: Digest,
  previousReceiptSha256: Digest.nullable(),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  decision: z.enum(['allowed', 'denied']),
  effect: z.enum(['not_started', 'not_committed', 'committed', 'unknown']),
  enforcement: z.strictObject({ protocol: z.literal(PROJECT_FIXTURE_PROTOCOL), auditSha256: Digest, credentialRef: Ref, principalRef: Ref, accountRef: Ref, tenant: Ref, clientAuthorityId: Ref }),
  lease: ProjectFixtureLeaseSchema,
  state: z.strictObject({ fixtureId: Ref, entityIds: Ids, baselineStateSha256: Digest, currentStateSha256: Digest, conditions: Conditions }),
  ledger: z.strictObject({ sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), sha256: Digest, pendingEffectIds: Ids, throughFence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), disposition: z.enum(['active', 'drained', 'isolated']), fenceStatus: z.enum(['active', 'revoked']), restoration: z.enum(['not_requested', 'restored', 'incomplete']) }),
});
const Bootstrap = z.strictObject({
  kind: z.literal('web-cookie'),
  origin: Origin,
  cookie: z.strictObject({ name: z.string().max(80), value: z.string().regex(/^[\x21-\x7e]{16,4096}$/).refine(value => !/[;,\\\"]/.test(value)), path: z.literal('/'), httpOnly: z.literal(true), secure: z.boolean(), sameSite: z.literal('Strict') }),
  clientAuthorityId: Ref,
  lease: ProjectFixtureLeaseSchema,
  attemptId: Ref,
  ownerId: Ref,
  subjectSha256: Digest,
  scopeSha256: Digest,
});
const NativeBootstrap = Bootstrap.omit({ kind: true, origin: true, cookie: true }).extend({
  kind: z.literal('native-private-mailbox'), nativeClient: ProjectFixtureNativeIdentitySchema,
  clientEndpoint: z.string().url().max(2048), mailbox: z.literal('qautra-fixture'),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Sign projectFixtureCanonical({ receipt, bootstrapSha256 }) with HMAC-SHA256; bootstrapSha256 is projectFixtureSha256(bootstrap), or null. */
export const ProjectFixtureEnvelopeSchema = z.strictObject({ receipt: Receipt, bootstrap: z.discriminatedUnion('kind', [Bootstrap, NativeBootstrap]).nullable(), signature: Digest });
export const ProjectFixtureAuditRecordSchema = z.strictObject({
  schema: z.literal('qautra/project-fixture-audit-receipt/v1'), receipt: Receipt,
  bootstrapSha256: Digest.nullable(), signature: Digest,
});
export const ProjectFixtureRecoveryAuthoritySchema = z.strictObject({
  schema: z.literal('qautra/project-fixture-recovery-authority/v1'), phase: z.enum(['prepare', 'renew']),
  attemptId: Ref, ownerId: Ref, binding: RegressionGrantBindingSchema, adapter: ProjectFixtureAdapterSchema, signature: Digest,
  nativeClient: ProjectFixtureNativeIdentitySchema.optional(),
});
/** Witness signatures cover projectFixtureCanonical({ witness }) with the same protected receipt key. */
export const ProjectFixtureClientWitnessSchema = z.strictObject({
  witness: z.strictObject({
    schema: z.literal('qautra/project-fixture-client-witness/v1'),
    challenge: Digest,
    attemptId: Ref,
    ownerId: Ref,
    subjectSha256: Digest,
    adapterSha256: Digest,
    scopeSha256: Digest,
    receiptSha256: Digest,
    lease: ProjectFixtureLeaseSchema,
    clientAuthorityId: Ref,
    principalRef: Ref,
    accountRef: Ref,
    tenant: Ref,
    conditions: Conditions,
    nativeClient: ProjectFixtureNativeIdentitySchema.optional(),
    observedAt: Timestamp,
    expiresAt: Timestamp,
  }),
  signature: Digest,
});
export type ProjectFixtureAdapter = z.infer<typeof ProjectFixtureAdapterSchema>;
export type ProjectFixtureRequest = z.infer<typeof ProjectFixtureRequestSchema>;
export type ProjectFixtureEnvelope = z.infer<typeof ProjectFixtureEnvelopeSchema>;
export type ProjectFixtureClientWitness = z.infer<typeof ProjectFixtureClientWitnessSchema>;
export type ProjectFixtureBootstrap = z.infer<typeof Bootstrap>;
export type ProjectFixtureNativeIdentity = z.infer<typeof ProjectFixtureNativeIdentitySchema>;
export type ProjectFixtureNativeBootstrap = z.infer<typeof NativeBootstrap>;
export const ProjectFixtureNativeClaimSchema = z.strictObject({
  schema: z.literal('qautra/project-fixture-native-claim/v1'),
  token: z.string().regex(/^[a-f0-9]{64}$/), nativeClient: ProjectFixtureNativeIdentitySchema,
  challenge: Digest, receiptSha256: Digest,
});
export type ProjectFixtureNativeClaim = z.infer<typeof ProjectFixtureNativeClaimSchema>;
export interface ProjectFixtureNativeClient {
  nativeProjectFixtureIdentity(): Promise<ProjectFixtureNativeIdentity>;
  applyNativeProjectFixture(bootstrap: ProjectFixtureNativeBootstrap): Promise<void>;
  nativeProjectFixtureWitness(claim: ProjectFixtureNativeClaim, signal?: AbortSignal): Promise<unknown>;
}
export type ProjectFixturePhase = z.infer<typeof ProjectFixturePhaseSchema>;
export type ProjectFixtureEffect = ProjectFixtureEnvelope['receipt']['effect'];
export interface ProjectFixtureProof {
  readonly receiptSha256: string;
  readonly phase: ProjectFixturePhase;
  readonly observedAt: string;
  readonly clientObservedAt?: string;
  readonly expiresAt: string;
  readonly subjectSha256: string;
  readonly scopeSha256: string;
  readonly adapterSha256: string;
  readonly attemptId: string;
  readonly ownerId: string;
  readonly lease: z.infer<typeof ProjectFixtureLeaseSchema>;
  readonly state: ProjectFixtureEnvelope['receipt']['state'];
  readonly ledger: ProjectFixtureEnvelope['receipt']['ledger'];
  readonly effect: ProjectFixtureEffect;
  readonly cleanup: 'not_started' | 'incomplete' | 'complete' | 'quarantined';
  readonly comparison: 'same_conditions' | 'changed_conditions' | 'unobserved';
}
export type ProjectFixtureBlockCode = 'fixture_adapter_missing' | 'fixture_adapter_invalid' | 'fixture_adapter_changed' | 'fixture_native_bootstrap_unsupported' | 'fixture_credential_missing' | 'fixture_input_invalid' | 'fixture_scope_denied' | 'fixture_peer_mismatch' | 'fixture_transport_failed' | 'fixture_response_invalid' | 'fixture_receipt_mismatch' | 'fixture_proof_stale' | 'fixture_baseline_drift' | 'fixture_conditions_drift' | 'fixture_effects_pending' | 'fixture_cleanup_incomplete' | 'fixture_client_unverified' | 'fixture_request_reused' | 'fixture_request_unresolved' | 'fixture_ownership_unverified' | 'fixture_state_invalid' | 'fixture_recovery_unavailable';
export class ProjectFixtureError extends Error {
  readonly reasons: readonly { code: ProjectFixtureBlockCode; preparation: 'environment_owner' }[];
  readonly code: ProjectFixtureBlockCode;
  readonly effect: ProjectFixtureEffect;
  constructor(code: ProjectFixtureBlockCode, effect: ProjectFixtureEffect = 'not_started') {
    super(code);
    this.code = code;
    this.effect = effect;
    this.name = 'ProjectFixtureError';
    this.reasons = [{ code, preparation: 'environment_owner' }];
  }
}
export interface ProjectFixtureGuard {
  readonly recoverySeedId: string;
  bindNativeClient(identity: ProjectFixtureNativeIdentity): void;
  prepare(signal?: AbortSignal): Promise<ProjectFixtureProof>;
  observe(signal?: AbortSignal): Promise<ProjectFixtureProof>;
  settle(signal?: AbortSignal): Promise<ProjectFixtureProof>;
  cleanup(signal?: AbortSignal): Promise<ProjectFixtureProof>;
  renew(binding: RegressionGrantBinding, signal?: AbortSignal): Promise<ProjectFixtureProof>;
  withBootstrap(apply: (bootstrap: ProjectFixtureBootstrap) => Promise<void>): Promise<void>;
  withNativeBootstrap(apply: (bootstrap: ProjectFixtureNativeBootstrap) => Promise<void>): Promise<void>;
  nativeWitnessRequest(): ProjectFixtureNativeClaim;
  clientWitnessRequest(): { url: string; entryURL: string; requiredCapabilities: readonly ['project-fixture-cookie', 'project-fixture-client-witness', 'project-fixture-fence'] };
  acceptClientWitness(value: unknown): void;
  assertCurrentProof(operation: RegressionGrantOperation): ProjectFixtureProof;
  markDispatchUnknown(): void;
  currentProof(): ProjectFixtureProof | undefined;
  initialProof(): ProjectFixtureProof | undefined;
}
export interface ProjectFixtureRecoveryObserver {
  observe(signal?: AbortSignal): Promise<ProjectFixtureProof>;
}

/** Protocol signatures preserve array order; grant subject hashes use the grant's set semantics. */
export function projectFixtureCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(projectFixtureCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${projectFixtureCanonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function projectFixtureSha256(value: unknown): string {
  return createHash('sha256').update(projectFixtureCanonical(value)).digest('hex');
}
