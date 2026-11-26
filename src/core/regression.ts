import { z } from 'zod';
import type { AppProfile, FlowSpec, TestSpec } from '../spec/schema.ts';
import { PLATFORMS } from './platform.ts';
import type { Platform } from './types.ts';
import { ProjectFixtureEnvelopeSchema, ProjectFixtureLeaseSchema, ProjectFixturePhaseSchema } from './project-fixture.ts';
import { RegressionGrantSubjectSchema } from './regression-grant.ts';
import { ExecutionChainSchema, type ExecutionChain } from './execution-chain.ts';
import type { ProductSourceManifest } from './product.ts';
import { GuestAttemptBindingSchema, GuestRecoverySourceSchema } from './guest-recovery.ts';
import { GuestBrowserEvidenceSchema } from './guest-runtime.ts';

const Id = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Paths = z.array(z.string().min(1).max(4096)).min(1).max(100);
const Target = z.strictObject({
  platform: z.enum(PLATFORMS),
  deviceId: z.string().min(1).max(200),
});
export const RegressionAuthorizationSchema = z.strictObject({
  appId: z.string().min(1).max(200),
  target: Target,
  grantId: z.string().min(1).max(200),
  subjectSha256: Digest,
});
const Scope = {
  revisionIds: z.array(Digest).min(1).max(100),
  targets: z.array(Target).min(1).max(32),
  authorizations: z.array(RegressionAuthorizationSchema).min(1).max(1000),
  evidence: z.literal('required-video'),
};
export type RegressionAuthorization = z.infer<typeof RegressionAuthorizationSchema>;

export const RegressionRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('scenario.preview'), paths: Paths, chains: z.array(ExecutionChainSchema).max(500).optional() }),
  z.strictObject({ method: z.literal('scenario.publish'), candidateId: Id, digest: Digest, reviewedChecks: z.array(z.string().min(1).max(1000)).min(1).max(5000) }),
  z.strictObject({ method: z.literal('scenario.list') }),
  z.strictObject({ method: z.literal('scenario.get'), revisionId: Digest }),
  z.strictObject({ method: z.literal('scenario.origin'), revisionId: Digest, testId: z.string().min(1).max(1000) }),
  z.strictObject({ method: z.literal('regression.grants') }),
  z.strictObject({ method: z.literal('regression.preflight'), ...Scope }),
  z.strictObject({ method: z.literal('regression.submit'), requestId: Id, name: z.string().trim().min(1).max(200), ...Scope }),
  z.strictObject({ method: z.literal('regression.status'), requestId: Id }),
  z.strictObject({ method: z.literal('regression.list') }),
  z.strictObject({ method: z.literal('regression.stop'), requestId: Id }),
  z.strictObject({ method: z.literal('regression.compare'), before: Id, after: Id }),
]);
export type RegressionRequest = z.infer<typeof RegressionRequestSchema>;
export type RegressionRequestInput = z.input<typeof RegressionRequestSchema>;
export type RegressionTarget = z.infer<typeof Target>;

export interface RegressionPreflightCheck {
  category: 'definition' | 'authority' | 'target' | 'evidence' | 'capacity';
  target: RegressionTarget | null;
  status: 'verified' | 'available' | 'waiting' | 'blocked' | 'unknown';
  code: string | null;
  message: string;
}
export interface RegressionPreflight {
  canQueue: boolean;
  checks: RegressionPreflightCheck[];
}

export interface FrozenSource {
  path: string;
  sha256: string;
  bytes: number;
  kind: 'test' | 'flow' | 'profile' | 'requirement';
}
export interface RequiredCheck {
  id: string;
  testId: string;
  path: string;
  kind: string;
  description: string;
  scope: 'observed-text' | 'observed-element';
  platforms: Platform[];
}
export interface FrozenTest {
  id: string;
  file: string;
  spec: TestSpec;
  profile: AppProfile;
  flows: { file: string; spec: FlowSpec; source?: string }[];
  sourceManifest?: string;
  testSource?: string;
  profileSource?: string;
}
export interface RevisionProblem {
  code: string;
  testId: string | null;
  path: string;
  message: string;
}
interface RevisionContents {
  tests: FrozenTest[];
  sources: FrozenSource[];
  checks: RequiredCheck[];
  runtime: { node: string; files: { path: string; sha256: string }[]; digest: string };
}
export type RevisionPayload = RevisionContents & (
  { schema: 'qautra/scenario-definition/v1' | 'qautra/scenario-definition/v2' | 'qautra/scenario-definition/v3' } |
  { schema: 'qautra/scenario-definition/v4'; chains: ExecutionChain[] }
);
export interface RevisionCandidate {
  candidateId: string;
  createdAt: string;
  digest: string;
  definition: RevisionPayload;
  problems: RevisionProblem[];
}
export interface PublishedRevision {
  schema: 'qautra/scenario-revision/v1' | 'qautra/scenario-revision/v2' | 'qautra/scenario-revision/v3' | 'qautra/scenario-revision/v4';
  revisionId: string;
  publishedAt: string;
  definition: RevisionPayload;
  review: {
    candidateId: string;
    digest: string;
    checks: string[];
    authority?: { principalId: string; channel: 'local-ui'; approvedAt: string };
  };
}
export type ScenarioOrigin = {
  schema: 'qautra/scenario-origin/v1';
  revisionId: string;
  testId: string;
} & (
  { availability: 'verified'; manifestSha256: string; manifest: ProductSourceManifest } |
  { availability: 'not-captured'; manifestSha256: null; manifest: null }
);
export type RegressionState = 'queued' | 'preparing' | 'running' | 'stopping' | 'finalizing' | 'finished' | 'cancelled' | 'blocked' | 'unknown';
export type BusinessVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_RUN';
const FixtureReceipt = ProjectFixtureEnvelopeSchema.shape.receipt;
export const AttemptFixtureProofSchema = z.strictObject({
  receiptSha256: Digest, phase: ProjectFixturePhaseSchema, observedAt: z.iso.datetime({ offset: true }),
  clientObservedAt: z.iso.datetime({ offset: true }).optional(), expiresAt: z.iso.datetime({ offset: true }),
  subjectSha256: Digest, scopeSha256: Digest, adapterSha256: Digest, attemptId: z.string(), ownerId: z.string(),
  lease: ProjectFixtureLeaseSchema, state: FixtureReceipt.shape.state, ledger: FixtureReceipt.shape.ledger,
  effect: FixtureReceipt.shape.effect, cleanup: z.enum(['not_started', 'incomplete', 'complete', 'quarantined']),
  comparison: z.enum(['same_conditions', 'changed_conditions', 'unobserved']),
});
const BinaryEvidence = z.strictObject({ path: z.string().min(1), sha256: Digest, bytes: z.number().int().positive(), coverage: z.literal('main-executable-only') });
export const AttemptBrowserEvidenceSchema = z.strictObject({
  capturedAt: z.iso.datetime(), identity: z.record(z.string(), z.json()),
  browserBinary: BinaryEvidence, driverBinary: BinaryEvidence,
});
const AttemptWorker = z.strictObject({
  runtime: z.enum(['owned-chrome', 'macos-guest']), instanceId: z.string().min(1), machineId: z.string().nullable(),
  workerId: z.string().min(1), generation: z.number().int().positive(),
});
const FrozenRuntime = z.strictObject({ node: z.string(), files: z.array(z.strictObject({ path: z.string(), sha256: Digest })), digest: Digest });
export const AttemptMaterialConditionsSchema = z.strictObject({
  subject: RegressionGrantSubjectSchema, subjectSha256: Digest, scopeSha256: Digest, adapterSha256: Digest,
  fixture: FixtureReceipt.shape.state,
  browser: z.record(z.string(), z.json()), browserBinary: BinaryEvidence, driverBinary: BinaryEvidence,
  worker: AttemptWorker.omit({ instanceId: true, generation: true }), runtime: FrozenRuntime,
  scheduling: z.literal('local-user-serial-1'),
});
export const AttemptConditionsReceiptSchema = z.strictObject({
  schema: z.literal('qautra/attempt-conditions/v1'),
  normalization: z.enum(['owned-chrome-ephemeral/v1', 'macos-guest-ephemeral/v1']),
  attemptId: Id, revisionId: Digest, testId: z.string(), target: Target, runId: z.string().nullable(),
  initial: AttemptFixtureProofSchema.nullable(), final: AttemptFixtureProofSchema.nullable(),
  browser: AttemptBrowserEvidenceSchema.nullable(), worker: AttemptWorker.nullable(),
  guest: z.strictObject({ source: GuestRecoverySourceSchema, binding: GuestAttemptBindingSchema, browser: GuestBrowserEvidenceSchema.nullable() }).optional(),
  runtime: FrozenRuntime, subject: RegressionGrantSubjectSchema,
  material: AttemptMaterialConditionsSchema.nullable(), materialSha256: Digest.nullable(),
  status: z.enum(['verified', 'changed', 'unverified']), reason: z.string().nullable(), receiptSha256: Digest,
});
export type AttemptConditionsReceipt = z.infer<typeof AttemptConditionsReceiptSchema>;
export type AttemptBrowserEvidence = z.infer<typeof AttemptBrowserEvidenceSchema>;
export type AttemptMaterialConditions = z.infer<typeof AttemptMaterialConditionsSchema>;
export interface RegressionAttempt {
  attemptId: string;
  revisionId: string;
  testId: string;
  chain?: ExecutionChain;
  target: RegressionTarget;
  authorization: RegressionAuthorization;
  state: RegressionState;
  runId: string | null;
  business: BusinessVerdict;
  evidence: 'pending' | 'recording' | 'finalizing' | 'ready' | 'incomplete';
  cleanup: 'not_started' | 'pending' | 'confirmed' | 'unknown';
  requiredChecks: string[];
  completedChecks: string[];
  code: string | null;
  message: string | null;
  conditions?: AttemptConditionsReceipt;
}
export interface RegressionRun {
  schema: 'qautra/regression-run/v1';
  requestId: string;
  fingerprint: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  state: RegressionState;
  revisionIds: string[];
  targets: RegressionTarget[];
  authorizations: RegressionAuthorization[];
  evidence: 'required-video';
  attempts: RegressionAttempt[];
  stopRequested: boolean;
  code: string | null;
  message: string | null;
}

const RegressionStateSchema = z.enum(['queued', 'preparing', 'running', 'stopping', 'finalizing', 'finished', 'cancelled', 'blocked', 'unknown']);
const BusinessVerdictSchema = z.enum(['PASS', 'FAIL', 'INCONCLUSIVE', 'NOT_RUN']);
const CheckIds = z.array(z.string().min(1).max(1000)).max(5000);
export const RegressionAttemptSchema = z.strictObject({
  attemptId: Id, revisionId: Digest, testId: z.string(), target: Target, authorization: RegressionAuthorizationSchema,
  chain: ExecutionChainSchema.optional(),
  state: RegressionStateSchema, runId: z.string().nullable(), business: BusinessVerdictSchema,
  evidence: z.enum(['pending', 'recording', 'finalizing', 'ready', 'incomplete']), cleanup: z.enum(['not_started', 'pending', 'confirmed', 'unknown']),
  requiredChecks: CheckIds.min(1), completedChecks: CheckIds, code: z.string().nullable(), message: z.string().nullable(),
  conditions: AttemptConditionsReceiptSchema.optional(),
}) satisfies z.ZodType<RegressionAttempt>;
export const RegressionRunSchema = z.strictObject({
  schema: z.literal('qautra/regression-run/v1'), requestId: Id, fingerprint: Digest, name: z.string().min(1).max(200),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), state: RegressionStateSchema, revisionIds: z.array(Digest).min(1).max(100),
  targets: z.array(Target).min(1).max(32), authorizations: z.array(RegressionAuthorizationSchema).min(1).max(1000),
  evidence: z.literal('required-video'), attempts: z.array(RegressionAttemptSchema).min(1).max(1000), stopRequested: z.boolean(), code: z.string().nullable(), message: z.string().nullable(),
}) satisfies z.ZodType<RegressionRun>;
export const RegressionPreflightSchema = z.strictObject({
  canQueue: z.boolean(),
  checks: z.array(z.strictObject({
    category: z.enum(['definition', 'authority', 'target', 'evidence', 'capacity']), target: Target.nullable(),
    status: z.enum(['verified', 'available', 'waiting', 'blocked', 'unknown']), code: z.string().nullable(), message: z.string(),
  })),
}) satisfies z.ZodType<RegressionPreflight>;
const ComparedAttempt = z.strictObject({
  business: BusinessVerdictSchema, evidence: RegressionAttemptSchema.shape.evidence, cleanup: RegressionAttemptSchema.shape.cleanup,
  conditions: AttemptConditionsReceiptSchema.nullable(),
});
export const RegressionComparisonSchema = z.strictObject({
  before: Id, after: Id, readOnly: z.literal(true),
  comparisons: z.array(z.strictObject({
    attemptId: Id, beforeAttemptId: Id.nullable(), comparable: z.boolean(),
    classification: z.enum(['definition_or_target_changed', 'conditions_unverified', 'changed_conditions', 'same_conditions']),
    reason: z.string().nullable(), before: ComparedAttempt.nullable(), after: ComparedAttempt,
  })),
});
export type RegressionComparison = z.infer<typeof RegressionComparisonSchema>;
// Frozen definitions embed whole DSL test/profile/flow documents; the SDK boundary checks their identity envelope and
// leaves the body to the revision store's digest verification.
const DefinitionEnvelope = z.looseObject({
  schema: z.enum(['qautra/scenario-definition/v1', 'qautra/scenario-definition/v2', 'qautra/scenario-definition/v3', 'qautra/scenario-definition/v4']),
  tests: z.array(z.looseObject({ id: z.string().min(1) })), checks: z.array(z.looseObject({ id: z.string().min(1), testId: z.string() })),
});
export const RevisionCandidateSchema = z.strictObject({
  candidateId: Id, createdAt: z.iso.datetime(), digest: Digest, definition: DefinitionEnvelope,
  problems: z.array(z.strictObject({ code: z.string(), testId: z.string().nullable(), path: z.string(), message: z.string() })),
});
export const PublishedRevisionSchema = z.strictObject({
  schema: z.enum(['qautra/scenario-revision/v1', 'qautra/scenario-revision/v2', 'qautra/scenario-revision/v3', 'qautra/scenario-revision/v4']),
  revisionId: Digest, publishedAt: z.iso.datetime(), definition: DefinitionEnvelope,
  review: z.strictObject({
    candidateId: Id, digest: Digest, checks: z.array(z.string()),
    authority: z.strictObject({ principalId: z.string().min(1), channel: z.literal('local-ui'), approvedAt: z.iso.datetime() }).optional(),
  }),
});
export const ScenarioOriginSchema = z.discriminatedUnion('availability', [
  z.strictObject({ schema: z.literal('qautra/scenario-origin/v1'), revisionId: Digest, testId: z.string(), availability: z.literal('verified'), manifestSha256: Digest, manifest: z.looseObject({}) }),
  z.strictObject({ schema: z.literal('qautra/scenario-origin/v1'), revisionId: Digest, testId: z.string(), availability: z.literal('not-captured'), manifestSha256: z.null(), manifest: z.null() }),
]);
