import { z } from 'zod';
import type { GuestControlRequest } from './instances.ts';

const ID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const Epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const GUEST_RECORDING_LIMIT_MS = 600_000;
export const GUEST_RECORDING_LIMIT_BYTES = 1024 * 1024 * 1024;
export const GUEST_RECORDING_CHUNK_BYTES = 256 * 1024;
export const GuestRecordingIdentity = z.strictObject({
  machineId: ID, contextId: ID, generation: Epoch, epoch: Epoch,
  guestPid: z.number().int().positive().max(2147483647), recorderId: ID,
  attemptId: z.string().min(1).max(256), runId: z.string().min(1).max(256),
});
export type GuestRecordingIdentity = z.infer<typeof GuestRecordingIdentity>;
export const GuestRecordingCommand = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), identity: GuestRecordingIdentity }),
  z.strictObject({ action: z.literal('status'), identity: GuestRecordingIdentity }),
  z.strictObject({ action: z.literal('stop'), identity: GuestRecordingIdentity }),
  z.strictObject({ action: z.literal('read'), identity: GuestRecordingIdentity, offset: z.number().int().nonnegative().max(GUEST_RECORDING_LIMIT_BYTES), length: z.number().int().min(1).max(GUEST_RECORDING_CHUNK_BYTES) }),
  z.strictObject({ action: z.literal('release'), identity: GuestRecordingIdentity, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type GuestRecordingCommand = z.infer<typeof GuestRecordingCommand>;
export type VMControlRequest = GuestControlRequest;
export const GuestRecordingStatus = z.strictObject({
  identity: GuestRecordingIdentity, state: z.enum(['starting', 'recording', 'stopping', 'finalized', 'failed']),
  readyAt: z.iso.datetime().nullable(), heartbeatAt: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(), width: z.number().int().min(0).max(4096), height: z.number().int().min(0).max(4096),
  code: z.string().max(256).nullable(),
  firstFrameAt: z.iso.datetime().nullable(),
  capture: z.enum(['active', 'stopped', 'unknown']), encoder: z.enum(['active', 'finalized', 'failed', 'unknown']),
});
export const GuestRecordingFinal = z.strictObject({
  identity: GuestRecordingIdentity, state: z.literal('finalized'), readyAt: z.iso.datetime(),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive().max(GUEST_RECORDING_LIMIT_BYTES),
  durationSeconds: z.number().positive().max(GUEST_RECORDING_LIMIT_MS / 1000 + 1),
  frames: z.number().int().min(1), width: z.number().int().min(2).max(4096), height: z.number().int().min(2).max(4096),
  media: z.enum(['valid', 'invalid']), code: z.string().max(256).nullable(),
});
export const GuestRecordingPartial = z.strictObject({
  identity: GuestRecordingIdentity, state: z.literal('incomplete'),
  capture: z.enum(['active', 'stopped', 'unknown']), encoder: z.enum(['active', 'finalized', 'failed', 'unknown']), media: z.literal('partial'),
  readyAt: z.iso.datetime().nullable(), startedAt: z.iso.datetime().nullable(),
  frames: z.number().int().nonnegative(), width: z.number().int().min(0).max(4096), height: z.number().int().min(0).max(4096), code: z.string().max(256).nullable(),
});
export function sameRecordingIdentity(actual: GuestRecordingIdentity, expected: GuestRecordingIdentity): boolean {
  return actual.machineId === expected.machineId && actual.contextId === expected.contextId && actual.generation === expected.generation
    && actual.epoch === expected.epoch && actual.guestPid === expected.guestPid && actual.recorderId === expected.recorderId
    && actual.attemptId === expected.attemptId && actual.runId === expected.runId;
}
