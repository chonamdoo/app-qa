import { z } from 'zod';
import { PLATFORMS } from './platform.ts';

const Ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const unique = <T extends z.ZodType>(schema: T, max = 100) => z.array(schema).max(max).refine(values => new Set(values.map(value => JSON.stringify(value))).size === values.length);
const Origin = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value && !url.username && !url.password; }
  catch { return false; }
});
/** The one actual-target identity shared by grants, regression requests and attempt records. */
export const RegressionGrantTargetSchema = z.strictObject({ platform: z.enum(PLATFORMS), deviceId: Ref });
const Target = RegressionGrantTargetSchema;

export const RegressionGrantOperationKindSchema = z.enum(['launch', 'terminate', 'open', 'tap', 'longPress', 'type', 'clear', 'press', 'back', 'scroll', 'swipe', 'hideKeyboard', 'location', 'reset', 'setup', 'cleanup', 'observe', 'capture-screen', 'record-video']);
export const RegressionGrantEffectSchema = z.enum(['read', 'fixture-write', 'external-send']);
export const RegressionGrantSinkSchema = z.strictObject({ id: Ref, kind: z.enum(['test-mail', 'test-payment', 'test-webhook']), origin: Origin });
export const RegressionGrantOperationSchema = z.strictObject({
  kind: RegressionGrantOperationKindSchema,
  effect: RegressionGrantEffectSchema,
  entityIds: unique(Ref),
  sinkIds: unique(Ref),
});
export const RegressionGrantScopeSchema = z.strictObject({
  environment: Ref,
  tenant: Ref,
  accountRef: Ref,
  credentialRef: Ref,
  fixture: z.strictObject({ id: Ref, entityIds: unique(Ref).refine(values => values.length > 0), initialStateSha256: Digest }),
  operations: unique(RegressionGrantOperationSchema, 100).refine(values => values.length > 0),
  effects: unique(RegressionGrantEffectSchema, 3).refine(values => values.length > 0),
  sinks: unique(RegressionGrantSinkSchema, 32),
}).superRefine((scope, context) => {
  if (new Set(scope.sinks.map(sink => sink.id)).size !== scope.sinks.length) context.addIssue({ code: 'custom', message: 'Duplicate sink identity' });
  for (const operation of scope.operations) {
    if (!scope.effects.includes(operation.effect) || operation.entityIds.some(id => !scope.fixture.entityIds.includes(id)) || operation.sinkIds.some(id => !scope.sinks.some(sink => sink.id === id))) context.addIssue({ code: 'custom', message: 'Operation exceeds fixture, effect or sink scope' });
    if ((operation.effect === 'external-send') !== (operation.sinkIds.length > 0)) context.addIssue({ code: 'custom', message: 'External effects require explicit test sinks' });
    if (operation.effect !== 'read' && operation.entityIds.length === 0) context.addIssue({ code: 'custom', message: 'Mutations require explicit owned entities' });
    if ((operation.kind === 'capture-screen' || operation.kind === 'record-video') && (operation.effect !== 'read' || operation.sinkIds.length > 0)) context.addIssue({ code: 'custom', message: 'Capture authorizes local collection, not AI transfer or external sharing' });
  }
});
export type RegressionGrantScope = z.infer<typeof RegressionGrantScopeSchema>;
export type RegressionGrantOperation = z.infer<typeof RegressionGrantOperationSchema>;

export const RegressionGrantSubjectSchema = z.strictObject({
  appId: Ref,
  target: Target,
  scope: RegressionGrantScopeSchema,
  origins: unique(Origin, 32),
  applicationId: Ref.optional(),
  policyVersion: Ref,
}).superRefine((subject, context) => {
  if (subject.origins.length === 0 && !subject.applicationId) context.addIssue({ code: 'custom', message: 'An origin or application identity is required' });
});
export const RegressionGrantSchema = z.strictObject({
  grantId: Ref,
  subject: RegressionGrantSubjectSchema,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  evidence: z.strictObject({ file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/), sha256: Digest }),
});
export const RegressionGrantPolicySchema = z.strictObject({
  schema: z.literal('qautra/regression-grant-policy/v1'),
  policyVersion: Ref,
  grants: z.array(RegressionGrantSchema).max(100),
}).superRefine((policy, context) => {
  if (new Set(policy.grants.map(grant => grant.grantId)).size !== policy.grants.length) context.addIssue({ code: 'custom', message: 'Duplicate grant identity' });
});

export const RegressionGrantEvidenceSchema = z.strictObject({
  schema: z.literal('qautra/backend-enforcement-probe/v1'),
  subject: RegressionGrantSubjectSchema,
  checkedAt: Timestamp,
  expiresAt: Timestamp,
  enforcement: z.literal('server-enforced-tenant-credential'),
  credential: z.strictObject({ ref: Ref, accountRef: Ref, tenant: Ref }),
  probes: z.strictObject({
    crossTenant: z.strictObject({ tenant: Ref, observedStatus: z.union([z.literal(401), z.literal(403), z.literal(404)]) }),
    unownedEntity: z.strictObject({ entityId: Ref, observedStatus: z.union([z.literal(401), z.literal(403), z.literal(404)]) }),
    unapprovedSink: z.strictObject({ sinkId: Ref, observedStatus: z.union([z.literal(401), z.literal(403), z.literal(404)]) }),
  }),
  initialState: z.strictObject({ fixtureId: Ref, entityIds: unique(Ref).refine(values => values.length > 0), observedStateSha256: Digest }),
});
export const RegressionGrantBindingSchema = z.strictObject({
  schema: z.literal('qautra/regression-grant-binding/v2'),
  grantId: Ref,
  root: z.string().min(1).max(4096),
  grantSha256: Digest,
  evidenceSha256: Digest,
  evidenceCheckedAt: Timestamp,
  evidenceExpiresAt: Timestamp,
  subject: RegressionGrantSubjectSchema,
  expiresAt: Timestamp,
});
export type RegressionGrantBinding = z.infer<typeof RegressionGrantBindingSchema>;
export type RegressionGrant = z.infer<typeof RegressionGrantSchema>;
export type RegressionGrantEvidence = z.infer<typeof RegressionGrantEvidenceSchema>;
export const RegressionGrantDescriptorSchema = z.strictObject({
  grantId: Ref,
  subjectSha256: Digest,
  appId: Ref,
  target: Target,
  environment: Ref,
  tenant: Ref,
  policyVersion: Ref,
  expiresAt: Timestamp,
  revoked: z.boolean(),
});
export type RegressionGrantDescriptor = z.infer<typeof RegressionGrantDescriptorSchema>;
export type RegressionGrantBlockCode = 'grant_input_invalid' | 'grant_policy_missing' | 'grant_file_unsafe' | 'grant_file_changed' | 'grant_file_limit' | 'grant_policy_invalid' | 'grant_not_found' | 'grant_revoked' | 'grant_expired' | 'grant_scope_mismatch' | 'grant_changed' | 'grant_operation_denied' | 'grant_evidence_missing' | 'grant_evidence_invalid' | 'grant_enforcement_unverified' | 'grant_initial_state_unverified';
export class RegressionGrantError extends Error {
  readonly effect = 'not_started' as const;
  readonly reasons: readonly { code: RegressionGrantBlockCode }[];
  readonly code: RegressionGrantBlockCode;
  constructor(code: RegressionGrantBlockCode) {
    super(code);
    this.code = code;
    this.name = 'RegressionGrantError';
    this.reasons = [{ code }];
  }
}
