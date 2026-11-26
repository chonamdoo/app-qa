import { z } from 'zod';

const UUID = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.string().min(1).max(256);
const Epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Path = z.string().min(1).max(4096);
export const GuestRecoveryContextSchema = z.strictObject({
  root: Path, runDir: Path, runId: Ref, attemptId: Ref, revisionId: Ref, testId: Ref,
  ownerId: Ref, fixtureSeedId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
  grantId: Ref, grantSha256: Digest, subjectSha256: Digest,
  target: z.strictObject({ platform: z.enum(['desktop-chrome', 'desktop-safari']), deviceId: Ref }),
});
export const GuestRecoveryExecutionSchema = z.strictObject({
  ownerId: Ref, generation: Ref, resources: z.array(Ref).min(1).max(128),
});
export const GuestRecoveryIdentitySchema = z.strictObject({
  machineId: UUID, contextId: UUID, generation: Epoch, epoch: Epoch,
  guestPid: z.number().int().positive().max(2147483647), recorderId: UUID, attemptId: Ref, runId: Ref,
});
export const GuestRecoverySourceSchema = z.strictObject({ kind: z.literal('macos-guest'), id: UUID, root: Path, bindingSha256: Digest });
export const GuestRecoveryLocatorSchema = z.strictObject({ directory: Path, machineId: UUID, nativeGeneration: UUID, recorderId: UUID });
export const GuestRecoveryRegistrationSchema = z.strictObject({
  context: GuestRecoveryContextSchema, execution: GuestRecoveryExecutionSchema, identity: GuestRecoveryIdentitySchema, evidenceFile: Path,
});
export const GuestAttemptBindingSchema = GuestRecoveryRegistrationSchema.extend({
  schema: z.literal('qautra/guest-attempt-binding/v1'), native: GuestRecoveryLocatorSchema,
  workerId: Ref, machinesRoot: Path, rootId: UUID, bootTokenSha256: Digest,
  artifacts: z.strictObject({ diskIdentity: Ref, auxiliaryIdentity: Ref, hardwareHash: Digest, machineHash: Digest }),
});
export const GuestRecoveryStopSchema = z.strictObject({
  schema: z.literal('qautra/guest-native-stop/v1'), recorderId: UUID, bindingSha256: Digest, nativeGeneration: UUID,
  observedAt: z.iso.datetime(), observation: z.enum(['vz-stop-completion', 'vz-delegate-stop', 'vz-delegate-error', 'vz-start-failure']),
});
export const GuestRecoveryInventorySchema = z.strictObject({
  schema: z.literal('qautra/guest-recorder-inventory/v1'), recorderId: UUID, bindingSha256: Digest, nativeGeneration: UUID,
  sealedAt: z.iso.datetime(), capture: z.literal('closed'), encoder: z.enum(['finalized', 'failed', 'unknown']),
  media: z.enum(['valid', 'invalid', 'partial', 'unavailable']), video: z.enum(['ready', 'incomplete', 'unavailable']),
  artifacts: z.array(z.strictObject({ name: z.enum(['status.json', 'final.json', 'video.mov', 'recovered.json']), location: z.enum(['spool', 'evidence']), identity: Ref, bytes: z.number().int().nonnegative().max(1024 * 1024 * 1024), sha256: Digest })).max(4),
  status: z.unknown(), final: z.unknown(), problems: z.array(z.string().min(1).max(256)).max(32),
});
export type GuestRecoveryContext = z.infer<typeof GuestRecoveryContextSchema>;
export type GuestRecoveryExecution = z.infer<typeof GuestRecoveryExecutionSchema>;
export type GuestRecoveryIdentity = z.infer<typeof GuestRecoveryIdentitySchema>;
export type GuestRecoverySource = z.infer<typeof GuestRecoverySourceSchema>;
export type GuestRecoveryLocator = z.infer<typeof GuestRecoveryLocatorSchema>;
export type GuestRecoveryRegistration = z.infer<typeof GuestRecoveryRegistrationSchema>;
export type GuestAttemptBinding = z.infer<typeof GuestAttemptBindingSchema>;
export type GuestRecoveryInventory = z.infer<typeof GuestRecoveryInventorySchema>;
export interface GuestRecoveryObservation {
  binding: GuestAttemptBinding;
  nativeStop: z.infer<typeof GuestRecoveryStopSchema> | null;
  nativeStopSha256: string | null;
  inventory: GuestRecoveryInventory | null;
  evidenceSha256: string | null;
  evidence: 'finalized' | 'incomplete' | 'unobserved';
  video: 'ready' | 'incomplete' | 'unavailable';
  problems: string[];
}
export interface GuestAttemptRecovery {
  register(endpoint: string, input: GuestRecoveryRegistration): Promise<{ source: GuestRecoverySource; binding: GuestAttemptBinding }>;
  read(directory: string, source: GuestRecoverySource, scope: Pick<GuestRecoveryExecution, 'ownerId' | 'generation'>): GuestAttemptBinding;
  scope(locator: GuestRecoveryLocator): GuestRecoveryExecution;
  observe(locator: GuestRecoveryLocator): Promise<GuestRecoveryObservation>;
}
