import { z } from 'zod';
import { RecordingSegmentSchema, RecordingStatusSchema } from './recording.ts';

export const ChromeProcessFactSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not-started') }),
  z.strictObject({ state: z.literal('starting') }),
  z.strictObject({ state: z.literal('running') }),
  z.strictObject({ state: z.literal('spawn-failed'), code: z.string().min(1).max(128) }),
  z.strictObject({ state: z.literal('stopped'), exit: z.strictObject({ code: z.number().int().nullable(), signal: z.string().min(1).max(128).nullable(), observedAt: z.iso.datetime({ offset: true }) }) }),
]);
export type ChromeProcessFact = z.infer<typeof ChromeProcessFactSchema>;
export const ChromeNativeStatusSchema = z.strictObject({
  schema: z.literal('qautra/owned-chrome-native/v1'), browser: ChromeProcessFactSchema, driver: ChromeProcessFactSchema,
  profile: z.enum(['not-created', 'retained', 'removed']),
});
export type ChromeNativeStatus = z.infer<typeof ChromeNativeStatusSchema>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.string().min(1).max(160);
export const ChromeOwnerScopeSchema = z.strictObject({
  id: z.uuid(), projectRoot: z.string().min(1).max(4096), deviceId: z.string().min(1).max(240),
  execution: z.strictObject({ ownerId: Ref, generation: z.uuid(), resources: z.array(Ref).min(1).max(128) }).nullable(),
  instance: z.strictObject({ instanceId: z.uuid(), generation: z.number().int().positive(), workerId: z.string().min(1).max(512) }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type ChromeOwnerScope = z.infer<typeof ChromeOwnerScopeSchema>;
export const ChromeOwnerSeedSchema = z.strictObject({
  schema: z.literal('qautra/chrome-owner-seed/v1'), scope: ChromeOwnerScopeSchema,
  controlToken: Digest, recoveryToken: Digest, replyKey: Digest, runtimeRoot: z.string().min(1).max(4096),
});
export type ChromeOwnerSeed = z.infer<typeof ChromeOwnerSeedSchema>;
export const ChromeOwnerLocatorSchema = z.strictObject({
  directory: z.string().min(1).max(4096), ownerId: z.uuid(), seedSha256: Digest,
});
export type ChromeOwnerLocator = z.infer<typeof ChromeOwnerLocatorSchema>;
export const ChromeOwnerAddressSchema = z.strictObject({
  schema: z.literal('qautra/chrome-owner-address/v1'), scope: ChromeOwnerScopeSchema, seedSha256: Digest,
  port: z.number().int().min(1).max(65535), signature: Digest,
});
export const ChromeRecordingBindingSchema = z.strictObject({
  attemptId: z.string().min(1).max(240), runId: z.string().min(1).max(240), platform: z.literal('desktop-chrome'),
  deviceId: z.string().min(1).max(240), generation: z.number().int().positive().nullable(),
});

const Problem = z.strictObject({ code: z.string().min(1).max(128), message: z.string().min(1).max(4096), effect: z.enum(['not_started', 'unknown']) });
export const ChromeOwnerRecordingSchema = z.strictObject({
  id: z.uuid(), binding: ChromeRecordingBindingSchema, file: z.string().min(1).max(4096),
  state: z.enum(['starting', 'recording', 'stopping', 'stopped', 'failed']),
  readyAt: z.iso.datetime({ offset: true }).nullable(), firstFrameAt: z.iso.datetime({ offset: true }).nullable(),
  captureExpiresAt: z.iso.datetime({ offset: true }).nullable(), maxDurationMs: z.number().int().positive().max(86_400_000).nullable(), status: RecordingStatusSchema,
  segment: RecordingSegmentSchema.nullable(), problem: Problem.nullable(),
});
export type ChromeOwnerRecording = z.infer<typeof ChromeOwnerRecordingSchema>;
export const ChromeOwnerStateSchema = z.strictObject({
  schema: z.literal('qautra/chrome-owner-state/v1'), scope: ChromeOwnerScopeSchema, seedSha256: Digest,
  phase: z.enum(['preparing', 'ready', 'fenced', 'stopping', 'closed', 'failed']),
  native: ChromeNativeStatusSchema.nullable(),
  endpoint: z.strictObject({ profile: z.string().min(1).max(4096), binary: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(128), debuggerAddress: z.string().regex(/^127\.0\.0\.1:[1-9]\d{0,4}$/) }).nullable(),
  browserSessionId: z.string().min(1).max(512).nullable(), creationRequested: z.boolean(),
  sessionDelete: z.enum(['not-requested', 'pending', 'confirmed', 'unknown']),
  recordings: z.array(ChromeOwnerRecordingSchema).max(128), evidenceFinalized: z.boolean(),
  evidenceFile: z.string().min(1).max(240).nullable(), evidenceSha256: Digest.nullable(),
  problem: Problem.nullable(), observedAt: z.iso.datetime({ offset: true }),
  lastMutation: z.strictObject({ id: z.uuid(), path: z.string().max(4096), state: z.enum(['pending', 'completed', 'rejected', 'unknown']) }).nullable(),
});
export type ChromeOwnerState = z.infer<typeof ChromeOwnerStateSchema>;
export const ChromeOwnerStoredStateSchema = z.strictObject({ body: ChromeOwnerStateSchema, signature: Digest });
const RpcIdentity = z.strictObject({ id: z.uuid(), ownerId: z.uuid(), seedSha256: Digest });
export const ChromeOwnerRequestSchema = z.discriminatedUnion('method', [
  RpcIdentity.extend({ method: z.literal('status') }),
  RpcIdentity.extend({ method: z.literal('heartbeat') }),
  RpcIdentity.extend({ method: z.literal('recording.start'), recordingId: z.uuid(), binding: ChromeRecordingBindingSchema, file: z.string().min(1).max(4096), captureExpiresAt: z.iso.datetime({ offset: true }).nullable() }),
  RpcIdentity.extend({ method: z.literal('recording.status'), recordingId: z.uuid() }),
  RpcIdentity.extend({ method: z.literal('recording.before'), recordingId: z.uuid() }),
  RpcIdentity.extend({ method: z.literal('recording.stop'), recordingId: z.uuid() }),
  RpcIdentity.extend({ method: z.literal('recording.cancel'), recordingId: z.uuid() }),
  RpcIdentity.extend({ method: z.literal('native.stop') }),
]);
export type ChromeOwnerRequest = z.infer<typeof ChromeOwnerRequestSchema>;
export type ChromeOwnerRequestInput = {
  [Method in ChromeOwnerRequest['method']]: Omit<Extract<ChromeOwnerRequest, { method: Method }>, 'id' | 'ownerId' | 'seedSha256'>
}[ChromeOwnerRequest['method']];
export const ChromeOwnerReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), id: z.uuid(), ownerId: z.uuid(), result: z.unknown().refine(value => value !== undefined) }),
  z.strictObject({ ok: z.literal(false), id: z.uuid(), ownerId: z.uuid(), error: Problem }),
]);
export const ChromeOwnerResults = {
  status: ChromeOwnerStateSchema, heartbeat: z.null(), 'recording.start': ChromeOwnerRecordingSchema,
  'recording.status': ChromeOwnerRecordingSchema, 'recording.before': z.null(), 'recording.cancel': z.null(), 'recording.stop': ChromeOwnerRecordingSchema,
  'native.stop': ChromeOwnerStateSchema,
} as const;
