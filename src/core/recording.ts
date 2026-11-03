import type { Platform } from './types.ts';
import { z } from 'zod';

export interface RecordingBinding {
  attemptId: string;
  runId: string;
  platform: Platform;
  deviceId: string;
  generation: number | null;
}
export interface RecordingSegment {
  file: string;
  sha256: string;
  bytes: number;
  durationSeconds: number;
  frames: number;
  width: number;
  height: number;
  startedAt: string;
  endedAt: string;
  source: 'android-device-screen' | 'ios-device-screen' | 'macos-guest-display' | 'chrome-page';
  timing?: { basis: 'source' | 'encoder-observed'; firstFrameReceivedAt: string; captureStartedAt: string | null; captureEndedAt: string | null };
}

export interface RecordingStatus {
  capture: 'active' | 'stopped' | 'unknown';
  encoder: 'active' | 'finalized' | 'failed' | 'unknown';
  spool: 'pending' | 'released' | 'unknown';
  file: 'pending' | 'durable' | 'unknown';
  media: 'pending' | 'valid' | 'invalid';
  diagnostics: string[];
  segment?: RecordingSegment;
}

export function recordingCleanupConfirmed(status: RecordingStatus): boolean {
  return status.capture === 'stopped' && (status.encoder === 'finalized' || status.encoder === 'failed') && status.spool === 'released';
}
export interface TargetRecording {
  readonly readyAt: string;
  readonly firstFrameAt: string;
  readonly lost: Promise<Error>;
  readonly maxDurationMs: number | null;
  assertHealthy(): void;
  /** Dispatch 직전에 비동기 target/session·capture 상태를 재검사한다. */
  beforeDispatch(): Promise<void>;
  status(): Promise<RecordingStatus>;
  stop(): Promise<RecordingSegment>;
}
export type StartTargetRecording = (input: { binding: RecordingBinding; file: string; signal: AbortSignal; captureExpiresAt?: string; sanitize?: (text: string) => string }) => Promise<TargetRecording>;
export interface AttemptVideoReceipt {
  schema: 'qautra/attempt-video/v1';
  binding: RecordingBinding;
  state: 'ready' | 'incomplete';
  cleanup: 'confirmed' | 'unknown';
  segments: RecordingSegment[];
  gaps: { from: string; to: string | null; reason: string; basis?: 'source' | 'encoder-observed' | 'host-detected' | 'unconfirmed' }[];
  artifacts?: { file: string; readyAt: string | null; firstFrameAt: string | null; status: RecordingStatus; code: string | null }[];
  boundaries?: { from: string; to: string; mutationFenced: true }[];
  actions?: { boundary: number; dispatchedAt: string; finishedAt: string | null; firstFrameAt: string; readyAt: string }[];
  code: string | null;
}

export const RecordingSegmentSchema: z.ZodType<RecordingSegment> = z.strictObject({
  file: z.string().min(1).max(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), durationSeconds: z.number().positive(),
  frames: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }), endedAt: z.iso.datetime({ offset: true }),
  source: z.enum(['android-device-screen', 'ios-device-screen', 'macos-guest-display', 'chrome-page']),
  timing: z.strictObject({ basis: z.enum(['source', 'encoder-observed']), firstFrameReceivedAt: z.iso.datetime({ offset: true }), captureStartedAt: z.iso.datetime({ offset: true }).nullable(), captureEndedAt: z.iso.datetime({ offset: true }).nullable() }).optional(),
});
export const RecordingStatusSchema: z.ZodType<RecordingStatus> = z.strictObject({
  capture: z.enum(['active', 'stopped', 'unknown']), encoder: z.enum(['active', 'finalized', 'failed', 'unknown']),
  spool: z.enum(['pending', 'released', 'unknown']), file: z.enum(['pending', 'durable', 'unknown']),
  media: z.enum(['pending', 'valid', 'invalid']), diagnostics: z.array(z.string().max(4096)).max(256),
  segment: RecordingSegmentSchema.optional(),
});
