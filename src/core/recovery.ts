import { z } from 'zod';
import { ChromeNativeStatusSchema, ChromeOwnerLocatorSchema, type ChromeOwnerLocator, type ChromeOwnerScope, type ChromeOwnerState } from './chrome-owner.ts';
import { RecordingSegmentSchema } from './recording.ts';
import { GuestRecoverySourceSchema, GuestRecoveryStopSchema } from './guest-recovery.ts';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ExecutionRecoverySourceSchema = z.union([z.strictObject({ kind: z.literal('owned-chrome'), id: z.uuid(), bindingSha256: Digest }), GuestRecoverySourceSchema]).readonly();
export const ExecutionRecoverySourcesSchema = z.array(ExecutionRecoverySourceSchema).max(128).refine(sources => new Set(sources.map(source => source.id)).size === sources.length);
const Ref = z.string().min(1).max(240);
export const ExecutionRecoveryScopeSchema = z.strictObject({ ownerId: Id, generation: z.string().min(1).max(160), resources: z.array(Id).min(1).max(128), markerSha256: Digest, lockSha256: Digest.nullable(), recoverySources: ExecutionRecoverySourcesSchema.readonly() });
export const ExecutionRecoveryReceiptSchema = z.strictObject({
  schema: z.literal('qautra/execution-recovery/v1'), scope: ExecutionRecoveryScopeSchema,
  resources: z.array(z.strictObject({
    resourceId: Id, nativeStop: z.literal('confirmed'), nativeStopSha256: Digest,
    evidence: z.literal('finalized'), evidenceSha256: Digest,
    fixture: z.enum(['restored', 'isolated']), fixtureSha256: Digest,
    lateEffects: z.enum(['resolved', 'isolated']), lateEffectsSha256: Digest,
  })).min(1).max(128),
});
const Path = z.string().min(1).max(4096);
export type ExecutionRecoveryScope = Readonly<Omit<z.infer<typeof ExecutionRecoveryScopeSchema>, 'resources'> & { resources: readonly string[] }>;
export type ExecutionRecoveryReceipt = z.infer<typeof ExecutionRecoveryReceiptSchema>;
export type ExecutionRecoverySource = z.infer<typeof ExecutionRecoverySourceSchema>;
export const AttemptRecoveryContextSchema = z.strictObject({
  root: Path, runDir: Path, runId: Ref, attemptId: Ref, revisionId: Ref, testId: Ref,
  ownerId: z.string().min(1).max(160), fixtureSeedId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  grantId: Ref, grantSha256: Digest, subjectSha256: Digest,
  target: z.strictObject({ platform: z.enum(['desktop-chrome', 'desktop-safari']), deviceId: Ref }),
});
export type AttemptRecoveryContext = z.infer<typeof AttemptRecoveryContextSchema>;
export const NativeAttemptBindingSchema = z.strictObject({
  schema: z.literal('qautra/native-attempt-binding/v1'), context: AttemptRecoveryContextSchema.extend({ target: z.strictObject({ platform: z.literal('desktop-chrome'), deviceId: Ref }) }), native: ChromeOwnerLocatorSchema,
});
export const StoredNativeAttemptBindingSchema = z.strictObject({ body: NativeAttemptBindingSchema, signature: Digest });
export type NativeAttemptBinding = z.infer<typeof NativeAttemptBindingSchema>;
export interface ChromeAttemptRecovery {
  register(locator: ChromeOwnerLocator, context: NativeAttemptBinding['context']): ExecutionRecoverySource;
  read(directory: string, source: ExecutionRecoverySource, scope: Pick<ExecutionRecoveryScope, 'ownerId' | 'generation'>): NativeAttemptBinding;
  scope(locator: ChromeOwnerLocator): ChromeOwnerScope;
  observe(locator: ChromeOwnerLocator): Promise<ChromeOwnerState>;
}
const Check = z.strictObject({
  kind: z.enum(['binding', 'native-stop', 'evidence', 'fixture', 'late-effects']),
  status: z.enum(['verified', 'blocked', 'unobserved']), code: z.string().min(1).max(160).nullable(),
});
export const ResourceRecoverySourceSchema = z.strictObject({
  reference: ExecutionRecoverySourceSchema, context: AttemptRecoveryContextSchema.nullable(),
  native: z.union([ChromeNativeStatusSchema, GuestRecoveryStopSchema]).nullable(), evidenceSha256: Digest.nullable(),
  video: z.enum(['ready', 'incomplete', 'unavailable']), segments: z.array(RecordingSegmentSchema).max(128),
  fixture: z.strictObject({ receiptSha256: Digest, subjectSha256: Digest, observedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }), cleanup: z.enum(['not_started', 'incomplete', 'complete', 'quarantined']), effect: z.literal('unknown'), comparison: z.literal('unobserved') }).nullable(),
  checks: z.array(Check).length(5),
});
export type ResourceRecoverySource = z.infer<typeof ResourceRecoverySourceSchema>;
export const ResourceRecoveryObservationSchema = z.strictObject({
  schema: z.literal('qautra/resource-recovery-observation/v1'), kind: z.literal('resource-verification-only'),
  scope: ExecutionRecoveryScopeSchema, observedAt: z.iso.datetime({ offset: true }),
  state: z.enum(['verified', 'blocked']), sources: z.array(ResourceRecoverySourceSchema).max(128),
  receipt: ExecutionRecoveryReceiptSchema.nullable(),
  problems: z.array(z.string().min(1).max(160)).max(256),
});
export type ResourceRecoveryObservation = z.infer<typeof ResourceRecoveryObservationSchema>;

export const InstanceRecoverySummarySchema = z.strictObject({
  recovered: z.array(z.uuid()).max(128),
  blocked: z.array(z.strictObject({ instanceId: z.uuid(), code: z.string().min(1).max(160) })).max(128),
});
export type InstanceRecoverySummary = z.infer<typeof InstanceRecoverySummarySchema>;
export const ExecutionRecoveryViewSchema = z.strictObject({
  kind: z.literal('resource-verification-only'),
  admission: z.strictObject({
    state: z.enum(['idle', 'active', 'unknown']), ownerId: z.string().nullable(), resources: z.array(z.string()),
    ownership: z.enum(['none', 'live', 'orphan', 'unverified']), phase: z.enum(['running', 'closing']).nullable(), reason: z.string().nullable(),
  }),
  observation: ResourceRecoveryObservationSchema.nullable(), instances: InstanceRecoverySummarySchema.nullable(),
  originalOutcomePreserved: z.literal(true),
});
export type ExecutionRecoveryView = z.infer<typeof ExecutionRecoveryViewSchema>;
